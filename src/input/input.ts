import type { Camera } from "../render/camera";
import { distToSegmentSq, type Vec } from "../sim/geometry";
import type { EntityId, GameNode, PlayerId } from "../sim/types";
import type { World } from "../sim/world";

const PAN_SPEED = 900; // world px per second at zoom 1
const CLICK_SLOP = 4; // screen px of movement before a right-press becomes a pan

export interface DragState {
  from: EntityId;
}

/**
 * Translates mouse/keyboard into camera moves and sim Commands (§6).
 * Left-drag from any node: release on a node = connect, on empty space = eject.
 * Right-click on a hypha = cut. Right-drag / WASD = pan. Wheel = zoom.
 */
export class Input {
  drag: DragState | null = null;
  cursor: Vec = { x: 0, y: 0 };
  hoverPipe: EntityId | null = null;

  private keys = new Set<string>();
  private pan: { sx: number; sy: number; moved: boolean } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private getWorld: () => World,
    private player: PlayerId,
  ) {
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  update(dtMs: number): void {
    const step = (PAN_SPEED * dtMs) / 1000 / this.camera.zoom;
    if (this.keys.has("w")) this.camera.y -= step;
    if (this.keys.has("s")) this.camera.y += step;
    if (this.keys.has("a")) this.camera.x -= step;
    if (this.keys.has("d")) this.camera.x += step;
    this.hoverPipe = this.pipeAt(this.cursor);
    // Drop a drag whose source died mid-gesture.
    if (this.drag && !this.getWorld().nodes.has(this.drag.from)) this.drag = null;
  }

  nodeAt(p: Vec): GameNode | undefined {
    const world = this.getWorld();
    const slop = 6 / this.camera.zoom;
    let best: GameNode | undefined;
    let bestD = Infinity;
    for (const n of world.nodes.values()) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < world.radiusOf(n) + slop && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private pipeAt(p: Vec): EntityId | null {
    const world = this.getWorld();
    const tol = 8 / this.camera.zoom;
    for (const pipe of world.pipes.values()) {
      const a = world.nodes.get(pipe.from)!;
      const b = world.nodes.get(pipe.to)!;
      if (distToSegmentSq(p.x, p.y, a.x, a.y, b.x, b.y) < tol * tol) return pipe.id;
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.cursor = this.camera.screenToWorld(e.offsetX, e.offsetY);
    if (e.button === 0) {
      const node = this.nodeAt(this.cursor);
      if (node) this.drag = { from: node.id };
    } else if (e.button === 2) {
      this.pan = { sx: e.offsetX, sy: e.offsetY, moved: false };
    }
  };

  private onMove = (e: PointerEvent) => {
    if (this.pan) {
      const dx = e.offsetX - this.pan.sx;
      const dy = e.offsetY - this.pan.sy;
      if (this.pan.moved || Math.hypot(dx, dy) > CLICK_SLOP) {
        this.pan.moved = true;
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        this.pan.sx = e.offsetX;
        this.pan.sy = e.offsetY;
      }
    }
    this.cursor = this.camera.screenToWorld(e.offsetX, e.offsetY);
  };

  private onUp = (e: PointerEvent) => {
    const world = this.getWorld();
    this.cursor = this.camera.screenToWorld(e.offsetX, e.offsetY);

    if (e.button === 0 && this.drag) {
      const from = this.drag.from;
      const target = this.nodeAt(this.cursor);
      if (target && target.id !== from) {
        world.enqueue({ type: "connect", player: this.player, from, to: target.id });
      } else if (!target) {
        world.enqueue({ type: "eject", player: this.player, from, ...this.cursor });
      }
      this.drag = null;
    } else if (e.button === 2 && this.pan) {
      if (!this.pan.moved) {
        const pipe = this.pipeAt(this.cursor);
        if (pipe != null) world.enqueue({ type: "cut", player: this.player, pipe });
      }
      this.pan = null;
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
  };
}
