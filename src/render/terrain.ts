import type { Arena } from "../sim/arena";
import type { Camera } from "./camera";

/**
 * Terrain is static for a whole round but runs to ~9,000 circles, so redrawing it
 * every frame is the single most expensive thing on screen when zoomed out.
 *
 * Zoomed out, we blit one pre-rendered image of the whole arena. Zoomed in, few
 * circles are on screen and vector drawing stays sharper, so we keep that path.
 */

/** Below this zoom the cached image is used (a texel is then ≤ ~1 screen pixel). */
export const CACHE_BELOW_ZOOM = 0.22;
const TEXTURE = 3072;

export class TerrainCache {
  private canvas: HTMLCanvasElement | null = null;
  private arena: Arena | null = null;

  /** Draws the whole arena from the cached image; call inside the world transform. */
  blit(ctx: CanvasRenderingContext2D, arena: Arena, edge: string, fill: string): void {
    const image = this.imageFor(arena, edge, fill);
    const r = arena.radius;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, -r, -r, r * 2, r * 2);
  }

  shouldUse(camera: Camera): boolean {
    return camera.zoom <= CACHE_BELOW_ZOOM;
  }

  private imageFor(arena: Arena, edge: string, fill: string): HTMLCanvasElement {
    if (this.canvas && this.arena === arena) return this.canvas;
    const canvas = document.createElement("canvas");
    canvas.width = TEXTURE;
    canvas.height = TEXTURE;
    const ctx = canvas.getContext("2d")!;
    // World (-r..r) → texture (0..TEXTURE).
    const scale = TEXTURE / (arena.radius * 2);
    ctx.setTransform(scale, 0, 0, scale, TEXTURE / 2, TEXTURE / 2);
    for (const [pad, color] of [[3, edge], [0, fill]] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const w of arena.walls) {
        ctx.moveTo(w.x + w.r + pad, w.y);
        ctx.arc(w.x, w.y, w.r + pad, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    this.canvas = canvas;
    this.arena = arena;
    return canvas;
  }
}
