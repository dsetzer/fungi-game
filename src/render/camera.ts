import type { Vec } from "../sim/geometry";

export class Camera {
  x = 0;
  y = 0;
  zoom = 0.7;
  /** Viewport size in CSS pixels. */
  width = 1;
  height = 1;

  screenToWorld(sx: number, sy: number): Vec {
    return {
      x: (sx - this.width / 2) / this.zoom + this.x,
      y: (sy - this.height / 2) / this.zoom + this.y,
    };
  }

  /** Zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    // Lower bound lets you pull back far enough to read the whole arena.
    this.zoom = Math.min(3, Math.max(0.045, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }
}
