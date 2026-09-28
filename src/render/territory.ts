import type { PlayerId } from "../sim/types";
import type { World } from "../sim/world";
import type { Camera } from "./camera";

/**
 * The fluid areas around nodes, drawn as metaballs in a WebGL2 fragment shader.
 * Each owner (and the neutral falls) is its own layer: auras in the same layer
 * pull toward each other and merge into one contiguous shape; different layers
 * overlap translucently. Rendered offscreen at reduced resolution and composited
 * into the 2D canvas by the Renderer.
 */

const MAX_BALLS = 256;
const MAX_LAYERS = 8; // layer 0 = neutral falls, 1.. = player ids
const RES_SCALE = 1; // offscreen resolution relative to device pixels (1 = crisp edges)

// Each ball contributes (1 - (d/R)^2)^2 inside R = r * REACH. Threshold is chosen
// so a lone ball's edge lands exactly at r; nearby balls sum and bridge the gap.
// How far a blob's influence extends past its own radius. Higher bridges gaps
// between neighbouring colonies more readily, so a network reads as one mass.
const REACH = 1.9;
const THRESHOLD = (1 - 1 / (REACH * REACH)) ** 2;

/**
 * The territory edge is a hard edge with a border, not a fade. Everything here is
 * measured in *output* pixels and resolved at output resolution, so the edge is
 * one pixel of antialiasing however large a territory grows or however far out the
 * view is zoomed — the same treatment terrain gets from the canvas.
 */
const EDGE_AA_PX = 1;
/** Border band drawn just inside the contour, in CSS pixels. */
const BORDER_PX = 2;
/** The border is the fill colour darkened, which keeps the flat palette. */
const BORDER_DARKEN = 0.8;
const BORDER_ALPHA = 0.85;

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

/**
 * The screen is cut into TILE_PX squares. Each frame the CPU lists, per tile, the
 * balls whose reach overlaps it (binBalls), and a pixel only visits its own tile's
 * list — a handful of balls instead of every one on screen. Looping over every
 * ball for every pixel drove a frame to hundreds of milliseconds once a network
 * spread. Every ball that can touch a pixel is in that pixel's tile list, so the
 * field, and so the picture, is exactly what summing all balls would give.
 */
const TILE_PX = 32;
/** Row width of the tile-list texture; lists are packed row after row. */
const LIST_W = 4096;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp isampler2D;
#define MAX_LAYERS ${MAX_LAYERS}
#define TILE_PX ${TILE_PX}
#define LIST_W ${LIST_W}
uniform sampler2D uBalls;   // a texel per ball: x, y (buffer px, y-up), radius px, layer*1000 + seed
uniform isampler2D uTiles;  // a texel per tile: first index into uList, count
uniform isampler2D uList;   // ball indices, LIST_W per row
uniform vec4 uColors[MAX_LAYERS]; // rgb, alpha
uniform float uTime;
uniform float uBorderPx;
out vec4 outColor;

void main() {
  vec2 p = gl_FragCoord.xy;
  float field[MAX_LAYERS];
  for (int l = 0; l < MAX_LAYERS; l++) field[l] = 0.0;

  ivec2 span = texelFetch(uTiles, ivec2(p) / TILE_PX, 0).xy;
  for (int k = 0; k < span.y; k++) {
    int at = span.x + k;
    int i = texelFetch(uList, ivec2(at % LIST_W, at / LIST_W), 0).r;
    vec4 b = texelFetch(uBalls, ivec2(i, 0), 0);
    vec2 d = p - b.xy;
    // Tiles are coarse, so skip balls that reach the tile but not this pixel
    // before the trig below: the wobble never swells a blob past 1.08x.
    float reachMax = b.z * ${(REACH * 1.08).toFixed(3)};
    if (dot(d, d) >= reachMax * reachMax) continue;
    // Slow wobble of the edge so the areas feel fluid rather than drawn.
    float ang = atan(d.y, d.x);
    int layer = int(b.w / 1000.0);
    float seed = mod(b.w, 1000.0);
    float wob = 1.0
      + 0.05 * sin(3.0 * ang + uTime * 0.6 + seed * 1.7)
      + 0.03 * sin(5.0 * ang - uTime * 0.9 + seed * 0.9);
    float R = b.z * ${REACH.toFixed(3)} * wob;
    float q = dot(d, d) / (R * R);
    if (q < 1.0) field[layer] += (1.0 - q) * (1.0 - q);
  }

  // Players first, then the neutral falls on top: a colony's territory must not
  // bury the food inside it, which is what you are steering by.
  vec4 acc = vec4(0.0);
  for (int i = 1; i <= MAX_LAYERS; i++) {
    int l = i == MAX_LAYERS ? 0 : i;
    float f = field[l];
    // Signed distance from the contour, in pixels: dividing by how fast the field
    // changes per pixel turns an arbitrary field value into a pixel count, so the
    // edge and the border stay the same width at any blob size or zoom.
    float fw = max(fwidth(f), 1e-5);
    float dpx = (f - ${THRESHOLD.toFixed(4)}) / fw;
    float outer = clamp(dpx / ${EDGE_AA_PX.toFixed(1)} + 0.5, 0.0, 1.0);
    float inner = clamp((dpx - uBorderPx) / ${EDGE_AA_PX.toFixed(1)} + 0.5, 0.0, 1.0);
    float aFill = inner * uColors[l].a;
    float aBorder = (outer - inner) * ${BORDER_ALPHA.toFixed(2)};
    // Fill and border cover disjoint bands, so their premultiplied colours add.
    vec3 pre = uColors[l].rgb * aFill + uColors[l].rgb * ${BORDER_DARKEN.toFixed(2)} * aBorder;
    float a = aFill + aBorder;
    acc.rgb = pre + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
  }
  outColor = acc; // premultiplied
}`;

// Falls stay neutral grey like the rest of the art — just a clearly darker grey
// than the terrain, which is all the separation they needed.
export const NEUTRAL_AURA = { rgb: [0.62, 0.63, 0.67], alpha: 0.75 };
export const PLAYER_AURA_ALPHA = 0.5;

/** Picks the WebGL2 path when available, otherwise the CPU fallback. */
export class TerritoryLayer {
  private gpu = new GpuTerritory();
  private cpu: CpuTerritory | null = null;
  /** False when the WebGL2 path is unavailable and the CPU fallback is in use. */
  usingGpu = false;

  /**
   * Why the GPU path isn't being used, or null when it is. The fallback used to
   * be silent, and its only symptom is edges that soften as territory grows (it
   * renders at reduced resolution and upscales) plus a much slower frame — both
   * of which read as "the game got worse" rather than "the shader didn't load".
   */
  /** The graphics renderer WebGL reports — shows whether it's emulated on the CPU. */
  get gpuRenderer(): string {
    return this.gpu.renderer;
  }

  get fallbackReason(): string | null {
    return this.usingGpu ? null : this.gpu.failure ?? "unknown";
  }

  /**
   * Renders the frame; returns the canvas to composite over the viewport.
   * `shown` filters out nodes hidden by fog of war.
   */
  render(
    world: World,
    camera: Camera,
    timeMs: number,
    shown: (id: number) => boolean = () => true,
    scaleOf: (id: number) => number = () => 1,
  ): HTMLCanvasElement {
    if (this.gpu.available && this.gpu.render(world, camera, timeMs, shown, scaleOf)) {
      this.usingGpu = true;
      return this.gpu.canvas;
    }
    this.usingGpu = false;
    this.cpu ??= new CpuTerritory();
    this.cpu.render(world, camera, timeMs, shown, scaleOf);
    return this.cpu.canvas;
  }
}

interface Ball {
  x: number;
  y: number;
  r: number;
  layer: number;
  seed: number;
}

/** Node auras in target-pixel space (y down), culled to the viewport. */
function collectBalls(
  world: World,
  camera: Camera,
  scale: number,
  w: number,
  h: number,
  shown: (id: number) => boolean,
  layerOf: (id: PlayerId) => number,
  scaleOf: (id: number) => number,
): Ball[] {
  const out: Ball[] = [];
  const k = camera.zoom * scale;
  for (const n of world.nodes.values()) {
    const layer = n.owner == null ? 0 : layerOf(n.owner);
    if (layer >= MAX_LAYERS || !shown(n.id)) continue;
    const grow = scaleOf(n.id); // a forming colony's territory swells in with it
    if (grow <= 0) continue;
    const r = world.auraOf(n) * k * grow;
    const x = ((n.x - camera.x) * camera.zoom + camera.width / 2) * scale;
    const y = ((n.y - camera.y) * camera.zoom + camera.height / 2) * scale;
    const pad = r * REACH * 1.1;
    if (x < -pad || y < -pad || x > w + pad || y > h + pad) continue;
    out.push({ x, y, r, layer, seed: n.seed }); // node.seed is stable, in [0, 1000)
    if (out.length >= MAX_BALLS) break;
  }
  return out;
}

function layerColors(world: World, layerOf: (id: PlayerId) => number): Float32Array {
  const colors = new Float32Array(MAX_LAYERS * 4);
  colors.set([...NEUTRAL_AURA.rgb, NEUTRAL_AURA.alpha], 0);
  for (const p of world.players) {
    const layer = layerOf(p.id);
    if (layer > 0 && layer < MAX_LAYERS) colors.set([...hexToRgb(p.color), PLAYER_AURA_ALPHA], layer * 4);
  }
  return colors;
}

/**
 * Player ids are unbounded online (they climb as people join), but the shader has
 * a fixed number of layers — so ids are packed into layers 1..MAX_LAYERS-1 by the
 * order they appear, with layer 0 reserved for neutral falls.
 */
function layerAssigner(world: World): (id: PlayerId) => number {
  const layers = new Map<PlayerId, number>();
  let next = 1;
  for (const p of world.players) {
    if (next >= MAX_LAYERS) break;
    layers.set(p.id, next++);
  }
  return (id) => layers.get(id) ?? 0;
}

/**
 * Same field maths as the shader, evaluated on a coarse grid on the CPU.
 *
 * The field is coarse but the *contour* is resolved at output resolution, which is
 * the whole point: upscaling a thresholded low-resolution buffer was what softened
 * the edges, and it got worse the more territory was on screen. Resolving the
 * contour separately means the field's resolution costs shape fidelity — how
 * faithfully the blob's outline is traced — and never sharpness.
 */
class CpuTerritory {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private fields: Float32Array[] = [];
  private image: ImageData | null = null;
  /** Output pixels, as premultiplied RGBA words. */
  private out32: Uint32Array | null = null;
  /** Per-field-texel verdict for the whole frame, one byte each (see resolve). */
  private verdict = new Uint8Array(0);
  /** Which layers cover a flat texel, and the colour word that resolves to. */
  private flatKey = new Int32Array(0);
  private flatWord = new Int32Array(0);
  /** Output column -> field column, precomputed so the inner loop stays cheap. */
  private colOfX = new Int32Array(0);
  private fieldW = 0;
  private fieldH = 0;
  /** Layers that had field data last frame — only these need clearing. */
  private lastLayers: number[] = [];
  /**
   * Fixed resolution steps for the *field*, highest first.
   *
   * Since the contour is resolved at output resolution, this no longer controls
   * sharpness at all — only how faithfully the blob's outline is traced. Dropping
   * a step makes a big blob's curve very slightly rounder; it can never make an
   * edge soft. That is what lets the field stay cheap.
   */
  private static readonly STEPS = [0.75, 0.55, 0.42, 0.3];
  /**
   * Hard cap on field-evaluation pixels per frame. Because the step is chosen as
   * sqrt(BUDGET / touched), the work saturates at exactly this many pixels however
   * big the territory gets, so this number *is* the fallback's frame cost: measured
   * at ~33ns a pixel, 6e5 cost 20ms a frame and 1.8e5 costs ~6ms.
   *
   * On a CPU you cannot have both crisp and fast here — 6e5 held a ~2px edge at
   * every size but at 20ms. This is set to keep the worst case as cheap as it was
   * before, which buys full resolution for small and medium territories and still
   * softens the biggest ones.
   */
  private static readonly PIXEL_BUDGET = 1.8e5;
  /**
   * The step in use. Kept between frames so a territory sitting on a boundary
   * doesn't oscillate between two resolutions every frame — resizing the buffer
   * that way flickers badly.
   */
  private step = CpuTerritory.STEPS[0];

  render(
    world: World,
    camera: Camera,
    _timeMs: number,
    shown: (id: number) => boolean,
    scaleOf: (id: number) => number,
  ): void {
    const layerOf = layerAssigner(world);
    // Collect in CSS pixels first, then pick a resolution that keeps the work
    // bounded: zoomed out there are far more blobs on screen, and at a fixed
    // resolution this fallback spiked past 50ms a frame.
    const cssBalls = collectBalls(world, camera, 1, camera.width, camera.height, shown, layerOf, scaleOf);
    // Cost is what actually gets written, so measure each ball's bounding box
    // *clipped to the viewport* — the accumulation loop clips it too. Measuring the
    // unclipped box made one blob larger than the screen look arbitrarily expensive,
    // so zooming in far enough dropped the resolution for no reason at all.
    let touched = 0;
    for (const b of cssBalls) {
      const R = b.r * REACH;
      const bw = Math.min(camera.width, b.x + R) - Math.max(0, b.x - R);
      const bh = Math.min(camera.height, b.y + R) - Math.max(0, b.y - R);
      if (bw > 0 && bh > 0) touched += bw * bh;
    }
    // Snap to fixed steps. Recomputing a continuous scale every frame resized the
    // buffer constantly, which flickered — the resolution must only change when it
    // crosses a step, not with every wobble in how much blob is on screen.
    const wanted = Math.sqrt(CpuTerritory.PIXEL_BUDGET / Math.max(1, touched));
    // Hysteresis: drop a step as soon as needed, but only climb back once there is
    // clear headroom, so a view sitting on a boundary settles instead of flickering.
    const target = CpuTerritory.STEPS.find((s) => s <= wanted) ?? CpuTerritory.STEPS.at(-1)!;
    if (target < this.step || wanted >= target * 1.15) this.step = target;
    const scale = this.step;
    const w = Math.max(1, Math.round(camera.width * scale));
    const h = Math.max(1, Math.round(camera.height * scale));
    // The canvas is full output resolution; only the field grid is coarse.
    const dpr = window.devicePixelRatio || 1;
    const outW = Math.max(1, Math.round(camera.width * dpr));
    const outH = Math.max(1, Math.round(camera.height * dpr));
    if (this.canvas.width !== outW || this.canvas.height !== outH || !this.image) {
      this.canvas.width = outW;
      this.canvas.height = outH;
      this.image = this.ctx.createImageData(outW, outH);
      this.out32 = new Uint32Array(this.image.data.buffer);
      this.colOfX = new Int32Array(0); // force the column map to be rebuilt
    }
    if (this.fieldW !== w || this.fieldH !== h) {
      this.fieldW = w;
      this.fieldH = h;
      this.fields = Array.from({ length: MAX_LAYERS }, () => new Float32Array(w * h));
      this.verdict = new Uint8Array(w * h);
      this.flatKey = new Int32Array(w * h);
      this.flatWord = new Int32Array(w * h);
      this.lastLayers = this.fields.map((_, i) => i);
      this.colOfX = new Int32Array(0);
    }
    // Output column -> field column. Rebuilt only when either size changes.
    if (this.colOfX.length !== outW) {
      this.colOfX = new Int32Array(outW);
      for (let x = 0; x < outW; x++) {
        this.colOfX[x] = Math.min(w - 1, Math.max(0, Math.floor(((x + 0.5) / dpr) * scale)));
      }
    }
    // Clearing all eight field buffers each frame is wasted work; only the layers
    // that had anything in them last frame need resetting.
    for (const l of this.lastLayers) this.fields[l].fill(0);

    const used = new Set<number>();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const css of cssBalls) {
      const b = { ...css, x: css.x * scale, y: css.y * scale, r: css.r * scale };
      used.add(b.layer);
      const field = this.fields[b.layer];
      const maxR = b.r * REACH * 1.08; // wobble headroom
      const x0 = Math.max(0, Math.floor(b.x - maxR));
      const x1 = Math.min(w - 1, Math.ceil(b.x + maxR));
      const y0 = Math.max(0, Math.floor(b.y - maxR));
      const y1 = Math.min(h - 1, Math.ceil(b.y + maxR));
      // No per-pixel wobble here: an atan2 and two sines per pixel per blob cost
      // milliseconds a frame. The GPU path keeps the wobble; this fallback trades
      // it for frame rate, and the merged shape is what carries the look anyway.
      const R = b.r * REACH;
      const invR2 = 1 / (R * R);
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      if (y0 < minY) minY = y0;
      if (y1 > maxY) maxY = y1;
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - b.y;
        const row = y * w;
        const dy2 = dy * dy;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - b.x;
          const q = (dx * dx + dy2) * invR2;
          if (q < 1) field[row + x] += (1 - q) * (1 - q);
        }
      }
    }

    const colors = layerColors(world, layerOf);
    // Same order as the shader: players first, neutral falls (layer 0) on top.
    const layers = [...used].sort((a, b) => (a === 0 ? Infinity : a) - (b === 0 ? Infinity : b));
    this.lastLayers = layers;
    const out32 = this.out32!;
    out32.fill(0);
    // (bounded below to the union's bounding box; a full clear is one pass and
    // cheaper than tracking the previous frame's extent)
    if (maxX < minX || maxY < minY) {
      this.ctx.putImageData(this.image!, 0, 0);
      return;
    }

    // One field texel spans this many output pixels; a signed distance in pixels
    // therefore changes by at most this much from one texel to the next.
    const pxPerTexel = dpr / scale;
    const borderPx = BORDER_PX * dpr;
    // How far from the contour a texel must be before every output pixel inside it
    // is unambiguously interior or exterior, with a pixel of slack.
    const slack = pxPerTexel + EDGE_AA_PX + 1;

    // Pass 1, per texel: how far is it from each layer's contour? A texel is only
    // worth resolving pixel by pixel if some layer's edge or border band runs
    // through it; everywhere else the colour is constant and can be written flat.
    // OUT = nothing here, FLAT = constant colour, EDGE = resolve each pixel.
    const OUT = 0, FLAT = 1, EDGE = 2;
    const verdict = this.verdict;
    verdict.fill(OUT, minY * w + minX, maxY * w + maxX + 1);
    const flatKey = this.flatKey;
    flatKey.fill(0, minY * w + minX, maxY * w + maxX + 1);
    for (const l of layers) {
      const fieldL = this.fields[l];
      const bit = 1 << l;
      for (let y = minY; y <= maxY; y++) {
        const row = y * w;
        for (let x = minX; x <= maxX; x++) {
          const i = row + x;
          const f = fieldL[i];
          if (f <= 0) continue;
          const gx = Math.abs((fieldL[i + 1] ?? f) - (fieldL[i - 1] ?? f)) / 2;
          const gy = Math.abs((fieldL[i + w] ?? f) - (fieldL[i - w] ?? f)) / 2;
          // Field change per output pixel, not per texel.
          const per = Math.max((gx + gy) / pxPerTexel, 1e-6);
          const dpx = (f - THRESHOLD) / per;
          if (dpx < -slack) continue; // outside this layer entirely
          if (dpx > borderPx + slack) {
            if (verdict[i] === OUT) verdict[i] = FLAT;
            flatKey[i] |= bit;
          } else {
            verdict[i] = EDGE;
          }
        }
      }
    }

    // A flat texel's colour depends only on which layers cover it, so there are a
    // handful of distinct answers. Resolve each texel's word once here rather than
    // hashing the layer set again for every output pixel inside it.
    const flatCache = new Map<number, number>();
    const flatWord = this.flatWord;
    for (let y = minY; y <= maxY; y++) {
      const row = y * w;
      for (let x = minX; x <= maxX; x++) {
        const i = row + x;
        if (verdict[i] !== FLAT) continue;
        const key = flatKey[i];
        let word = flatCache.get(key);
        if (word === undefined) {
          let r = 0, g = 0, b = 0, a = 0;
          for (const l of layers) {
            if (!(key & (1 << l))) continue;
            const la = colors[l * 4 + 3];
            r = colors[l * 4] * la + r * (1 - la);
            g = colors[l * 4 + 1] * la + g * (1 - la);
            b = colors[l * 4 + 2] * la + b * (1 - la);
            a = la + a * (1 - la);
          }
          word = pack(r, g, b, a);
          flatCache.set(key, word);
        }
        flatWord[i] = word;
      }
    }

    // Pass 2, per output pixel: flat runs are a single store; only pixels whose
    // texel holds an edge pay for a bilinear sample.
    const colOfX = this.colOfX;
    const y0 = Math.max(0, Math.floor((minY / scale) * dpr));
    const y1 = Math.min(outH - 1, Math.ceil(((maxY + 1) / scale) * dpr));
    const x0 = Math.max(0, Math.floor((minX / scale) * dpr));
    const x1 = Math.min(outW - 1, Math.ceil(((maxX + 1) / scale) * dpr));
    for (let oy = y0; oy <= y1; oy++) {
      const fyf = ((oy + 0.5) / dpr) * scale - 0.5;
      const fy = Math.min(h - 1, Math.max(0, Math.floor(fyf)));
      const ty = Math.min(h - 2, Math.max(0, Math.floor(fyf)));
      const wy = Math.min(1, Math.max(0, fyf - ty));
      const vRow = fy * w;
      const outRow = oy * outW;
      for (let ox = x0; ox <= x1; ox++) {
        const v = verdict[vRow + colOfX[ox]];
        if (v === OUT) continue;
        if (v === FLAT) {
          out32[outRow + ox] = flatWord[vRow + colOfX[ox]];
          continue;
        }
        // Edge texel: sample the field where this pixel actually sits.
        const fxf = ((ox + 0.5) / dpr) * scale - 0.5;
        const tx = Math.min(w - 2, Math.max(0, Math.floor(fxf)));
        const wx = Math.min(1, Math.max(0, fxf - tx));
        let r = 0, g = 0, b = 0, a = 0;
        for (const l of layers) {
          const fl = this.fields[l];
          const i00 = ty * w + tx;
          const f = (fl[i00] * (1 - wx) + fl[i00 + 1] * wx) * (1 - wy)
            + (fl[i00 + w] * (1 - wx) + fl[i00 + w + 1] * wx) * wy;
          if (f <= 0) continue;
          const gx = Math.abs((fl[i00 + 1] ?? f) - (fl[i00 - 1] ?? f)) / 2;
          const gy = Math.abs((fl[i00 + w] ?? f) - (fl[i00 - w] ?? f)) / 2;
          const per = Math.max((gx + gy) / pxPerTexel, 1e-6);
          const dpx = (f - THRESHOLD) / per;
          const outer = clamp01(dpx / EDGE_AA_PX + 0.5);
          if (outer <= 0) continue;
          const inner = clamp01((dpx - borderPx) / EDGE_AA_PX + 0.5);
          const aFill = inner * colors[l * 4 + 3];
          const aBorder = (outer - inner) * BORDER_ALPHA;
          const la = aFill + aBorder;
          if (la <= 0) continue;
          // Fill and border cover disjoint bands, so their contributions add.
          const cr = colors[l * 4], cg = colors[l * 4 + 1], cb = colors[l * 4 + 2];
          const pr = cr * aFill + cr * BORDER_DARKEN * aBorder;
          const pg = cg * aFill + cg * BORDER_DARKEN * aBorder;
          const pb = cb * aFill + cb * BORDER_DARKEN * aBorder;
          r = pr + r * (1 - la);
          g = pg + g * (1 - la);
          b = pb + b * (1 - la);
          a = la + a * (1 - la);
        }
        if (a > 0) out32[outRow + ox] = pack(r, g, b, a);
      }
    }
    this.ctx.putImageData(this.image!, 0, 0);
  }
}

class GpuTerritory {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  /** Set when WebGL2 or the shader is unusable, so the HUD can say why. */
  failure: string | null = null;
  /**
   * The graphics renderer the browser reports. "SwiftShader" or similar means
   * WebGL is being emulated on the CPU (hardware acceleration off or the driver
   * blocklisted): it works, but every pixel of the shader runs on the CPU.
   */
  renderer = "unknown";
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private tex: { balls: WebGLTexture; tiles: WebGLTexture; list: WebGLTexture } | null = null;
  private balls = new Float32Array(MAX_BALLS * 4);
  /** Frames left to check for GL errors; getError stalls the pipeline, so only at first. */
  private errorChecks = 3;

  constructor() {
    this.gl = this.canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (this.gl) this.init(this.gl);
    else this.failure = "no WebGL2 context";
  }

  get available(): boolean {
    return this.prog !== null;
  }

  private init(gl: WebGL2RenderingContext): void {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    this.renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    // Software WebGL runs every pixel of the shader on the CPU, far slower than the
    // CPU fallback, which is written for the CPU: on Windows' Basic Render Driver a
    // spread-out network took ~300ms a frame and maxed the CPU. Use the fallback.
    if (/basic render|swiftshader|llvmpipe|softpipe|software/i.test(this.renderer)) {
      this.failure = `software WebGL (${this.renderer.slice(0, 40)})`;
      return;
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = (gl.getShaderInfoLog(s) ?? "").trim();
        console.warn("territory shader:", log);
        this.failure = `shader did not compile: ${log.slice(0, 120)}`;
        return null;
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = (gl.getProgramInfoLog(prog) ?? "").trim();
      console.warn("territory program:", log);
      this.failure = `shader did not link: ${log.slice(0, 120)}`;
      return;
    }
    this.prog = prog;
    gl.useProgram(prog);
    for (const name of ["uBalls", "uTiles", "uList", "uColors", "uTime", "uBorderPx"]) {
      this.loc[name] = gl.getUniformLocation(prog, name);
    }
    // Data textures, only ever read with texelFetch: no filtering, no mipmaps.
    const dataTexture = (unit: number, sampler: string): WebGLTexture => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(this.loc[sampler], unit);
      return t;
    };
    this.tex = { balls: dataTexture(0, "uBalls"), tiles: dataTexture(1, "uTiles"), list: dataTexture(2, "uList") };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Fullscreen triangle.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  }

  /** Renders the current frame into `this.canvas`. Returns false if unavailable. */
  render(
    world: World,
    camera: Camera,
    timeMs: number,
    shown: (id: number) => boolean,
    scaleOf: (id: number) => number,
  ): boolean {
    const gl = this.gl;
    if (!gl || !this.prog || !this.tex) return false;

    const dpr = window.devicePixelRatio || 1;
    const scale = dpr * RES_SCALE;
    const w = Math.max(1, Math.round(camera.width * scale));
    const h = Math.max(1, Math.round(camera.height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    // Balls in buffer pixel space, y flipped for gl_FragCoord.
    const layerOf = layerAssigner(world);
    const balls = collectBalls(world, camera, scale, w, h, shown, layerOf, scaleOf);
    // .w packs layer and the node's stable wobble seed: layer * 1000 + seed.
    balls.forEach((b, i) => this.balls.set([b.x, h - b.y, b.r, b.layer * 1000 + b.seed], i * 4));
    const texels = Math.max(1, balls.length); // a texture needs at least one texel
    const { tiles, tilesX, tilesY, list } = binBalls(this.balls, balls.length, w, h);
    const listRows = Math.max(1, Math.ceil(list.length / LIST_W));
    const listData = new Int32Array(LIST_W * listRows);
    listData.set(list);

    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.balls);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, texels, 1, 0, gl.RGBA, gl.FLOAT, this.balls.subarray(0, texels * 4));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.tiles);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32I, tilesX, tilesY, 0, gl.RG_INTEGER, gl.INT, tiles);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.list);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32I, LIST_W, listRows, 0, gl.RED_INTEGER, gl.INT, listData);

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4fv(this.loc.uColors, layerColors(world, layerOf));
    gl.uniform1f(this.loc.uTime, timeMs / 1000);
    gl.uniform1f(this.loc.uBorderPx, BORDER_PX * scale);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // A driver that rejects a texture format or the draw would otherwise leave the
    // territory blank; give up on the GPU path and let the CPU fallback draw it.
    if (this.errorChecks > 0) {
      this.errorChecks--;
      const err = gl.getError();
      if (err !== gl.NO_ERROR) {
        this.failure = `GL error 0x${err.toString(16)} while drawing`;
        this.prog = null;
        return false;
      }
    }
    return true;
  }
}

/**
 * Lists, for each TILE_PX tile of a w x h buffer, the balls whose reach (with
 * wobble headroom) overlaps it. `balls` packs x, y (y-up), r, w per ball.
 * Returns a (first, count) pair per tile into one flat list of ball indices.
 */
function binBalls(
  balls: Float32Array,
  n: number,
  w: number,
  h: number,
): { tiles: Int32Array; tilesX: number; tilesY: number; list: Int32Array } {
  const tilesX = Math.ceil(w / TILE_PX);
  const tilesY = Math.ceil(h / TILE_PX);
  const counts = new Int32Array(tilesX * tilesY);
  const spans = new Int32Array(n * 4); // per ball: first/last tile column, first/last tile row
  for (let i = 0; i < n; i++) {
    const x = balls[i * 4];
    const y = balls[i * 4 + 1];
    const reach = balls[i * 4 + 2] * REACH * 1.08 + 1;
    const x0 = Math.max(0, Math.floor((x - reach) / TILE_PX));
    const x1 = Math.min(tilesX - 1, Math.floor((x + reach) / TILE_PX));
    const y0 = Math.max(0, Math.floor((y - reach) / TILE_PX));
    const y1 = Math.min(tilesY - 1, Math.floor((y + reach) / TILE_PX));
    spans.set([x0, x1, y0, y1], i * 4);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) counts[ty * tilesX + tx]++;
  }
  const tiles = new Int32Array(tilesX * tilesY * 2);
  let total = 0;
  for (let t = 0; t < counts.length; t++) {
    tiles[t * 2] = total;
    tiles[t * 2 + 1] = counts[t];
    total += counts[t];
  }
  const list = new Int32Array(Math.max(1, total));
  const filled = new Int32Array(counts.length);
  for (let i = 0; i < n; i++) {
    const x0 = spans[i * 4], x1 = spans[i * 4 + 1], y0 = spans[i * 4 + 2], y1 = spans[i * 4 + 3];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = ty * tilesX + tx;
        list[tiles[t * 2] + filled[t]++] = i;
      }
    }
  }
  return { tiles, tilesX, tilesY, list };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Packs a premultiplied colour into one RGBA word. ImageData is straight alpha,
 * so the colour is un-premultiplied on the way in; writing a whole pixel as a
 * single 32-bit store is what makes the flat runs cheap.
 */
function pack(r: number, g: number, b: number, a: number): number {
  const inv = a > 0 ? 1 / a : 0;
  const R = Math.min(255, (r * inv * 255) | 0);
  const G = Math.min(255, (g * inv * 255) | 0);
  const B = Math.min(255, (b * inv * 255) | 0);
  const A = Math.min(255, (a * 255) | 0);
  // Little-endian byte order in the ImageData buffer: R, G, B, A.
  return (A << 24) | (B << 16) | (G << 8) | R;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
