import { CAMERA_FLY_TAU_MS } from "../config";
import type { Vec } from "../sim/geometry";

export class Camera {
  x = 0;
  y = 0;
  zoom = 0.7;
  /** Viewport size in CSS pixels. */
  width = 1;
  height = 1;

  /** Where the camera is easing toward, if anywhere. */
  private target: Vec | null = null;

  screenToWorld(sx: number, sy: number): Vec {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: (sy - this.height / 2) / this.zoom + this.y,
    };
  }

  /** Ease toward a world point over the next few frames. */
  flyTo(x: number, y: number): void {
    this.target = { x, y };
  }

  /** Jump immediately, e.g. when a round starts. */
  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.target = null;
  }

  /** Any manual camera control hands control back to the player. */
  cancelFly(): void {
    this.target = null;
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
    const k = 1 - Math.exp(-dtMs / CAMERA_FLY_TAU_MS);
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
    // Keep easing toward the same world point, now at the new zoom.
  }
}
