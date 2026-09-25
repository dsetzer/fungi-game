import {
  FOG_CELL,
  FOG_EXPLORED_ALPHA,
  FOG_RENDER_SCALE,
  VISION_MIN,
  VISION_REACH_SCALE,
} from "../config";
import type { EntityId, PlayerId } from "../sim/types";
import type { World } from "../sim/world";
import type { Camera } from "./camera";

/**
 * Fog of war (§8): your colonies light up a radius around themselves. Ground you
 * have never seen is hidden; ground you have seen but aren't watching stays
 * remembered — terrain and nutrient falls persist, but rival colonies and their
 * hyphae are only drawn while something of yours can see them.
 *
 * Purely a client-side view filter for now. A server would do this per player so
 * the hidden state never reaches the client at all.
 */
export class FogOfWar {
  private explored: Uint8Array;
  private cell = FOG_CELL;
  private n: number;
  private origin: number;
  private radius: number;
  /** Vision circles for the current frame, in world space. */
  private eyes: { x: number; y: number; r: number }[] = [];
  private fog = document.createElement("canvas");
  private mask = document.createElement("canvas");
  private maskDirty = true;

  constructor(radius: number) {
    this.radius = radius;
    this.origin = -radius - this.cell;
    this.n = Math.ceil((radius * 2 + this.cell * 2) / this.cell);
    this.explored = new Uint8Array(this.n * this.n);
  }

  /** Recomputes vision and marks newly explored ground. Call once per frame. */
  update(world: World, player: PlayerId): void {
    this.eyes = [];
    for (const n of world.nodes.values()) {
      if (n.owner !== player) continue;
      const r = Math.max(VISION_MIN, world.reachOf(n) * VISION_REACH_SCALE);
      this.eyes.push({ x: n.x, y: n.y, r });
      this.markExplored(n.x, n.y, r);
    }
  }

  private markExplored(x: number, y: number, r: number): void {
    const c0 = this.idx(x - r);
    const c1 = this.idx(x + r);
    const r0 = this.idx(y - r);
    const r1 = this.idx(y + r);
    for (let gy = r0; gy <= r1; gy++) {
      for (let gx = c0; gx <= c1; gx++) {
        const wx = this.origin + (gx + 0.5) * this.cell;
        const wy = this.origin + (gy + 0.5) * this.cell;
        if (Math.hypot(wx - x, wy - y) > r + this.cell * 0.5) continue;
        const i = gy * this.n + gx;
        if (!this.explored[i]) {
          this.explored[i] = 1;
          this.maskDirty = true;
        }
      }
    }
  }

  private idx(v: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((v - this.origin) / this.cell)));
  }

  /**
   * One pixel per explored cell, blurred in mask space so the upscaled border is
   * soft. Rebuilt only when new ground is explored, not per frame.
   */
  private maskCanvas(): HTMLCanvasElement {
    if (!this.maskDirty) return this.mask;
    this.maskDirty = false;
    const src = document.createElement("canvas");
    src.width = this.n;
    src.height = this.n;
    const sctx = src.getContext("2d")!;
    const img = sctx.createImageData(this.n, this.n);
    for (let i = 0; i < this.explored.length; i++) {
      if (this.explored[i]) img.data[i * 4 + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);

    this.mask.width = this.n;
    this.mask.height = this.n;
    const ctx = this.mask.getContext("2d")!;
    ctx.clearRect(0, 0, this.n, this.n);
    ctx.filter = "blur(0.8px)";
    ctx.drawImage(src, 0, 0);
    ctx.filter = "none";
    return this.mask;
  }

  /** True while one of your colonies can currently see this point. */
  isVisible(x: number, y: number): boolean {
    return this.eyes.some((e) => Math.hypot(e.x - x, e.y - y) <= e.r);
  }

  isExplored(x: number, y: number): boolean {
    return this.explored[this.idx(y) * this.n + this.idx(x)] === 1;
  }

  /**
   * Nodes to draw: your own always, rivals only while visible, falls once seen
   * (they don't move, so remembering them is fair).
   */
  visibleNodes(world: World, player: PlayerId): Set<EntityId> {
    const out = new Set<EntityId>();
    for (const n of world.nodes.values()) {
      const seen =
        n.owner === player ||
        this.isVisible(n.x, n.y) ||
        (n.kind === "fall" && this.isExplored(n.x, n.y));
      if (seen) out.add(n.id);
    }
    return out;
  }

  /**
   * Grey overlay: opaque where unexplored, dimmed where remembered, clear in sight.
   *
   * Drawn at a fraction of the screen resolution and scaled up. Fog is soft by
   * design, so the lost detail is invisible, while the full-resolution version
   * cost ~40ms a frame in compositing passes — the whole frame budget.
   */
  draw(ctx: CanvasRenderingContext2D, camera: Camera, color: string): void {
    const dpr = window.devicePixelRatio || 1;
    const scale = FOG_RENDER_SCALE;
    const w = Math.max(1, Math.round(camera.width * scale));
    const h = Math.max(1, Math.round(camera.height * scale));
    if (this.fog.width !== w || this.fog.height !== h) {
      this.fog.width = w;
      this.fog.height = h;
    }
    const f = this.fog.getContext("2d")!;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.globalCompositeOperation = "source-over";
    f.fillStyle = color;
    f.clearRect(0, 0, w, h);
    f.fillRect(0, 0, w, h);

    // World → fog-buffer pixels (screen pixels scaled down by FOG_RENDER_SCALE).
    const k = camera.zoom * scale;
    const toScreenX = (x: number) => (x - camera.x) * k + w / 2;
    const toScreenY = (y: number) => (y - camera.y) * k + h / 2;

    // Thin the fog over remembered ground. The memory is drawn as a low-res mask
    // scaled up with smoothing and a blur, so the border is soft rather than tiled.
    f.globalCompositeOperation = "destination-out";
    f.globalAlpha = 1 - FOG_EXPLORED_ALPHA;
    f.imageSmoothingEnabled = true;
    f.imageSmoothingQuality = "high";
    // The mask is blurred once, in mask space, when it changes — blurring the
    // full-screen canvas every frame was costing milliseconds per frame.
    const span = this.n * this.cell * k;
    f.drawImage(this.maskCanvas(), toScreenX(this.origin), toScreenY(this.origin), span, span);
    f.globalAlpha = 1;

    // Clear it entirely inside vision, with a soft edge.
    for (const e of this.eyes) {
      const cx = toScreenX(e.x);
      const cy = toScreenY(e.y);
      const r = e.r * k;
      const grad = f.createRadialGradient(cx, cy, r * 0.75, cx, cy, r);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      f.fillStyle = grad;
      f.beginPath();
      f.arc(cx, cy, r, 0, Math.PI * 2);
      f.fill();
    }

    // Outside the arena there is nothing to hide.
    f.globalCompositeOperation = "destination-out";
    f.beginPath();
    f.rect(0, 0, w, h);
    f.arc(toScreenX(0), toScreenY(0), this.radius * k, 0, Math.PI * 2);
    f.fill("evenodd");

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.fog, 0, 0, camera.width, camera.height);
    ctx.restore();
  }
}
