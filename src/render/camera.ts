import { CAMERA_FLY_TAU_MS, CAMERA_PAN_TAU_MS } from "../config";
import type { Vec } from "../sim/geometry";

export class Camera {
  x = 0;
  y = 0;
  zoom = 0.7;
  /** Viewport size in CSS pixels. */
  width = 1;
  height = 1;

  /**
   * Where the camera is easing toward, if anywhere. "fly" is autopilot (following
   * a throw) and any manual control cancels it; "pan" is the player's own drag,
   * eased so the map glides rather than jumps with the mouse.
   */
  private target: Vec | null = null;
  private mode: "fly" | "pan" = "fly";

  screenToWorld(sx: number, sy: number): Vec {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: (sy - this.height / 2) / this.zoom + this.y,
    };
  }

  /** Ease toward a world point over the next few frames. */
  flyTo(x: number, y: number): void {
    this.target = { x, y };
    this.mode = "fly";
  }

  /**
   * Drag-pan by a world offset. It moves the destination and the camera eases
   * after it; successive drags build on the destination, not the lagging
   * position, so the map ends up exactly where it was dragged. A pan takes over
   * from a fly-to at wherever the camera currently is.
   */
  panBy(dx: number, dy: number): void {
    const from = this.target && this.mode === "pan" ? this.target : { x: this.x, y: this.y };
    this.target = { x: from.x + dx, y: from.y + dy };
    this.mode = "pan";
  }

  /** Move immediately (keyboard panning), carrying any drag-pan destination along. */
  moveBy(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    if (this.target && this.mode === "pan") {
      this.target.x += dx;
      this.target.y += dy;
    }
  }

  /** Jump immediately, e.g. when a round starts. */
  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.target = null;
  }

  /** Any manual camera control takes the camera off autopilot. A drag-pan still settles. */
  cancelFly(): void {
    if (this.mode === "fly") this.target = null;
  }

  get flying(): boolean {
    return this.target !== null;
  }

  /**
   * Exponential ease, framerate-independent: the camera covers the same fraction
   * of the remaining distance per unit time whatever the frame rate.
   */
  update(dtMs: number): void {
    const t = this.target;
    if (!t) return;
    const tau = this.mode === "pan" ? CAMERA_PAN_TAU_MS : CAMERA_FLY_TAU_MS;
    const k = 1 - Math.exp(-dtMs / tau);
    this.x += (t.x - this.x) * k;
    this.y += (t.y - this.y) * k;
    // Close enough that further easing is invisible: stop, so tiny drift doesn't
    // fight the player's own panning.
    const remaining = Math.hypot(t.x - this.x, t.y - this.y) * this.zoom;
    if (remaining < 0.5) this.snapTo(t.x, t.y);
  }

  /** Zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    // Lower bound lets you pull back far enough to read the whole arena.
    this.zoom = Math.min(3, Math.max(0.045, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    // A drag-pan still settling moves with the zoom, so the point under the
    // cursor stays put instead of the camera drifting back toward a stale spot.
    if (this.target && this.mode === "pan") {
      this.target.x += before.x - after.x;
      this.target.y += before.y - after.y;
    }
  }
}
