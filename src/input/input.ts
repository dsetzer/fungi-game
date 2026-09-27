import {
  CAMERA_FLY_ON_EJECT,
  EJECT_FRACTION_DEFAULT,
  EJECT_FRACTION_MAX,
  EJECT_FRACTION_MIN,
} from "../config";
import type { Camera } from "../render/camera";
import { distToSegmentSq, type Vec } from "../sim/geometry";
import type { Command, EntityId, GameNode, PlayerId } from "../sim/types";
import type { World } from "../sim/world";

const PAN_SPEED = 900; // world px per second at zoom 1
const CLICK_SLOP = 4; // screen px of movement before a right-press becomes a drag

export interface DragState {
  from: EntityId;
}

interface RightPress {
  sx: number;
  sy: number;
  moved: boolean;
  /** Set when the press started on one of our colonies: dragging builds a wall. */
  wallFrom: EntityId | null;
}

/**
 * Translates mouse/keyboard into camera moves and sim Commands (§6).
 * Left-drag from any node: release on a node = connect, on empty space = eject.
 * Right-drag from your colony = wall (stem + crossbar at release point).
 * Right-drag elsewhere / WASD = pan. Right-click a wall/hypha = demolish/cut. Wheel = zoom.
 */
export class Input {
  drag: DragState | null = null;
  cursor: Vec = { x: 0, y: 0 };
  hoverPipe: EntityId | null = null;
  hoverWall: EntityId | null = null;
  /** Share of the parent carried by the next throw; the wheel adjusts it mid-drag. */
  ejectFraction = EJECT_FRACTION_DEFAULT;

  private keys = new Set<string>();
  private right: RightPress | null = null;
  /** Where a left press started, to tell a click from a drag. */
  private leftPress: { sx: number; sy: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private camera: Camera,
    private getWorld: () => World,
    private player: () => PlayerId,
    /** Where commands go: the local world offline, the server online. */
    private send: (cmd: Command) => void,
  ) {
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return; // typing on the menu, not panning
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** Colony a wall is being dragged from, once the right-drag has actually moved. */
  get wallDrag(): EntityId | null {
    return this.right?.moved ? this.right.wallFrom : null;
  }

  update(dtMs: number): void {
    const step = (PAN_SPEED * dtMs) / 1000 / this.camera.zoom;
    const panning = ["w", "a", "s", "d"].some((k) => this.keys.has(k));
    if (panning) this.camera.cancelFly(); // keys take the camera back off autopilot
    if (this.keys.has("w")) this.camera.y -= step;
    if (this.keys.has("s")) this.camera.y += step;
    if (this.keys.has("a")) this.camera.x -= step;
    if (this.keys.has("d")) this.camera.x += step;
    this.hoverWall = this.wallAt(this.cursor);
    this.hoverPipe = this.hoverWall == null ? this.pipeAt(this.cursor) : null;
    // Pointer cursor over anything a click acts on, so reversing is discoverable.
    const clickable =
      this.hoverWall != null ||
      (this.hoverPipe != null && this.getWorld().canReverse(this.player(), this.hoverPipe).ok);
    this.canvas.style.cursor = clickable ? "pointer" : "crosshair";
    // Drop gestures whose source died mid-drag.
    const world = this.getWorld();
    if (this.drag && !world.nodes.has(this.drag.from)) this.drag = null;
    if (this.right?.wallFrom != null && !world.nodes.has(this.right.wallFrom)) this.right = null;
  }

  nodeAt(p: Vec): GameNode | undefined {
    const world = this.getWorld();
    // Cores are small dots, so be generous with the click target.
    const slop = 10 / this.camera.zoom;
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

  /** Nearest hypha under the cursor. */
  private pipeAt(p: Vec): EntityId | null {
    const world = this.getWorld();
    const tol = 12 / this.camera.zoom;
    let best: EntityId | null = null;
    let bestD = tol * tol;
    for (const pipe of world.pipes.values()) {
      const a = world.nodes.get(pipe.from);
      const b = world.nodes.get(pipe.to);
      if (!a || !b) continue;
      const d = distToSegmentSq(p.x, p.y, a.x, a.y, b.x, b.y);
      if (d < bestD) {
        bestD = d;
        best = pipe.id;
      }
    }
    return best;
  }

  /** Our own walls only — they're the only ones a right-click can remove. */
  private wallAt(p: Vec): EntityId | null {
    const world = this.getWorld();
    const tol = 8 / this.camera.zoom;
    for (const w of world.barriers.values()) {
      if (w.owner !== this.player()) continue;
      if (distToSegmentSq(p.x, p.y, w.a.x, w.a.y, w.b.x, w.b.y) < tol * tol) return w.id;
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.cursor = this.camera.screenToWorld(e.offsetX, e.offsetY);
    const node = this.nodeAt(this.cursor);
    if (e.button === 0) {
      this.leftPress = { sx: e.offsetX, sy: e.offsetY };
      if (node) this.drag = { from: node.id };
    } else if (e.button === 2) {
      const wallFrom = node && node.owner === this.player() ? node.id : null;
      this.right = { sx: e.offsetX, sy: e.offsetY, moved: false, wallFrom };
    }
  };

  private onMove = (e: PointerEvent) => {
    const r = this.right;
    if (r?.moved && r.wallFrom == null) this.camera.cancelFly(); // dragging the map
    if (r) {
      const dx = e.offsetX - r.sx;
      const dy = e.offsetY - r.sy;
      if (!r.moved && Math.hypot(dx, dy) > CLICK_SLOP) r.moved = true;
      if (r.moved && r.wallFrom == null) {
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        r.sx = e.offsetX;
        r.sy = e.offsetY;
      }
    }
    this.cursor = this.camera.screenToWorld(e.offsetX, e.offsetY);
  };

  private onUp = (e: PointerEvent) => {
    const player = this.player();
    this.cursor = this.camera.screenToWorld(e.offsetX, e.offsetY);

    if (e.button === 0 && this.drag) {
      const from = this.drag.from;
      const target = this.nodeAt(this.cursor);
      if (target && target.id !== from) {
        this.send({ type: "connect", player, from, to: target.id });
      } else if (!target) {
        this.send({ type: "eject", player, from, ...this.cursor, fraction: this.ejectFraction });
        // Follow the throw to where it lands.
        if (CAMERA_FLY_ON_EJECT) this.camera.flyTo(this.cursor.x, this.cursor.y);
      }
      this.drag = null;
      this.leftPress = null;
    } else if (e.button === 0 && this.leftPress) {
      // A left-click that isn't a drag: clicking a hypha flips which way it flows.
      const moved = Math.hypot(e.offsetX - this.leftPress.sx, e.offsetY - this.leftPress.sy);
      const pipe = moved <= CLICK_SLOP ? this.pipeAt(this.cursor) : null;
      if (pipe != null) this.send({ type: "reverse", player, pipe });
      this.leftPress = null;
    } else if (e.button === 2 && this.right) {
      const r = this.right;
      if (r.moved && r.wallFrom != null) {
        this.send({ type: "wall", player, from: r.wallFrom, ...this.cursor });
      } else if (!r.moved) {
        const wall = this.wallAt(this.cursor);
        const pipe = wall == null ? this.pipeAt(this.cursor) : null;
        if (wall != null) this.send({ type: "demolish", player, wall });
        else if (pipe != null) this.send({ type: "cut", player, pipe });
      }
      this.right = null;
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.drag) this.camera.cancelFly(); // zooming is manual control too
    // Mid-throw the wheel sets how much of the parent goes with the new colony
    // (Galcon-style). It only does this while dragging, so zoom is never hijacked
    // just because the cursor is near a colony.
    if (this.drag) {
      const step = e.deltaY < 0 ? 0.05 : -0.05;
      this.ejectFraction = Math.min(
        EJECT_FRACTION_MAX,
        Math.max(EJECT_FRACTION_MIN, this.ejectFraction + step),
      );
      return;
    }
    this.camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
  };
}
