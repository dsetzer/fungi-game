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

/** Reveal circles are deduped onto this grid so standing still doesn't pile them up. */
const REVEAL_GRID = 150;

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
  /**
   * Where you have looked, as circles rather than a pixel mask: drawn with hard
   * edges so the fog border stays crisp at any zoom. Keyed on a coarse grid so
   * standing still doesn't pile up duplicates.
   */
  private reveals = new Map<number, { x: number; y: number; r: number }>();

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
      this.remember(n.x, n.y, r);
    }
  }

  private remember(x: number, y: number, r: number): void {
    const gx = Math.round(x / REVEAL_GRID);
    const gy = Math.round(y / REVEAL_GRID);
    const key = gx * 100_000 + gy;
    const seen = this.reveals.get(key);
    if (!seen || seen.r < r) this.reveals.set(key, { x, y, r });
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
        this.explored[gy * this.n + gx] = 1;
      }
    }
  }

  private idx(v: number): number {
    return Math.min(this.n - 1, Math.max(0, Math.floor((v - this.origin) / this.cell)));
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
   * Every edge is a hard-edged circle — no blur, no gradient — so the fog border
   * stays as sharp as the rest of the art at any zoom.
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

    // Thin the fog over remembered ground: one hard-edged circle per place you
    // have looked, culled to the view. Their union gives a clean rounded border.
    f.globalCompositeOperation = "destination-out";
    f.globalAlpha = 1 - FOG_EXPLORED_ALPHA;
    f.fillStyle = "#000";
    f.beginPath();
    for (const r of this.reveals.values()) {
      const cx = toScreenX(r.x);
      const cy = toScreenY(r.y);
      const rr = r.r * k;
      if (cx + rr < 0 || cy + rr < 0 || cx - rr > w || cy - rr > h) continue;
      f.moveTo(cx + rr, cy);
      f.arc(cx, cy, rr, 0, Math.PI * 2);
    }
    f.fill();
    f.globalAlpha = 1;

    // Clear it entirely inside current vision.
    f.beginPath();
    for (const e of this.eyes) {
      const cx = toScreenX(e.x);
      const cy = toScreenY(e.y);
      const r = e.r * k;
      f.moveTo(cx + r, cy);
      f.arc(cx, cy, r, 0, Math.PI * 2);
    }
    f.fill();

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
