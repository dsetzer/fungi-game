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
/** How much darker a territory's outline is than its fill. */
export const OUTLINE_DARKEN = 0.55;
/** Outline thickness in buffer pixels — constant whatever the blob's size. */
export const OUTLINE_PX = 3;
const THRESHOLD = (1 - 1 / (REACH * REACH)) ** 2;

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
#define MAX_BALLS ${MAX_BALLS}
#define MAX_LAYERS ${MAX_LAYERS}
uniform vec4 uBalls[MAX_BALLS]; // x, y (buffer px, y-up), radius px, layer*1000 + seed
uniform vec4 uColors[MAX_LAYERS]; // rgb, alpha
uniform int uCount;
uniform float uTime;
out vec4 outColor;

void main() {
  vec2 p = gl_FragCoord.xy;
  float field[MAX_LAYERS];
  for (int l = 0; l < MAX_LAYERS; l++) field[l] = 0.0;

  for (int i = 0; i < MAX_BALLS; i++) {
    if (i >= uCount) break;
    vec4 b = uBalls[i];
    vec2 d = p - b.xy;
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
    // Widths come from how fast the field changes per pixel, so the edge and the
    // outline are a fixed number of pixels wide on a small fall and on a huge
    // territory alike. Fixed field-space widths made big blobs look bevelled,
    // because the same band spans far more screen on a shallow gradient.
    float fw = max(fwidth(f), 1e-5);
    float shape = smoothstep(${THRESHOLD.toFixed(4)} - fw, ${THRESHOLD.toFixed(4)} + fw, f);
    float a = shape * uColors[l].a;
    float edge = 1.0 - smoothstep(
      ${THRESHOLD.toFixed(4)} + fw,
      ${THRESHOLD.toFixed(4)} + fw * ${(1 + OUTLINE_PX).toFixed(1)},
      f
    );
    vec3 col = mix(uColors[l].rgb, uColors[l].rgb * ${OUTLINE_DARKEN.toFixed(2)}, edge);
    a = max(a, shape * edge * uColors[l].a);
    acc.rgb = col * a + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
  }
  outColor = acc; // premultiplied
}`;

// Nutrient falls are warm and dark-rimmed: pale grey food on pale grey terrain
// was unreadable.
export const NEUTRAL_AURA = { rgb: [0.91, 0.74, 0.44], alpha: 0.9 };
export const PLAYER_AURA_ALPHA = 0.5;

/** Picks the WebGL2 path when available, otherwise the CPU fallback. */
export class TerritoryLayer {
  private gpu = new GpuTerritory();
  private cpu: CpuTerritory | null = null;
  /** False when the WebGL2 path is unavailable and the CPU fallback is in use. */
  usingGpu = false;

  /**
   * Renders the frame; returns the canvas to composite over the viewport.
   * `shown` filters out nodes hidden by fog of war.
   */
  render(
    world: World,
    camera: Camera,
    timeMs: number,
    shown: (id: number) => boolean = () => true,
  ): HTMLCanvasElement {
    if (this.gpu.available && this.gpu.render(world, camera, timeMs, shown)) {
      this.usingGpu = true;
      return this.gpu.canvas;
    }
    this.usingGpu = false;
    this.cpu ??= new CpuTerritory();
    this.cpu.render(world, camera, timeMs, shown);
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
): Ball[] {
  const out: Ball[] = [];
  const k = camera.zoom * scale;
  for (const n of world.nodes.values()) {
    const layer = n.owner == null ? 0 : layerOf(n.owner);
    if (layer >= MAX_LAYERS || !shown(n.id)) continue;
    const r = world.auraOf(n) * k;
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
 * Same field maths as the shader, evaluated on a coarse grid on the CPU and
 * upscaled with smoothing. Only touches pixels inside each ball's reach.
 */
class CpuTerritory {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private fields: Float32Array[] = [];
  private image: ImageData | null = null;
  /** Layers that had field data last frame — only these need clearing. */
  private lastLayers: number[] = [];
  // Higher than it needs to be for the maths, but the result is upscaled to the
  // screen, and at 0.3 the blob edges read as blurry rather than clean.
  /** Fixed resolution steps, highest first: the buffer only resizes between these. */
  private static readonly STEPS = [0.55, 0.4, 0.28, 0.2, 0.14];
  /** Rough cap on field-evaluation pixels per frame, before scaling down. */
  private static readonly PIXEL_BUDGET = 6e5;

  render(world: World, camera: Camera, _timeMs: number, shown: (id: number) => boolean): void {
    const layerOf = layerAssigner(world);
    // Collect in CSS pixels first, then pick a resolution that keeps the work
    // bounded: zoomed out there are far more blobs on screen, and at a fixed
    // resolution this fallback spiked past 50ms a frame.
    const cssBalls = collectBalls(world, camera, 1, camera.width, camera.height, shown, layerOf);
    let touched = 0;
    for (const b of cssBalls) touched += (2 * b.r * REACH) ** 2;
    // Snap to fixed steps. Recomputing a continuous scale every frame resized the
    // buffer constantly, which flickered — the resolution must only change when it
    // crosses a step, not with every wobble in how much blob is on screen.
    const wanted = Math.sqrt(CpuTerritory.PIXEL_BUDGET / Math.max(1, touched));
    const scale = CpuTerritory.STEPS.find((s) => s <= wanted) ?? CpuTerritory.STEPS.at(-1)!;
    const w = Math.max(1, Math.round(camera.width * scale));
    const h = Math.max(1, Math.round(camera.height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h || !this.image) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.image = this.ctx.createImageData(w, h);
      this.fields = Array.from({ length: MAX_LAYERS }, () => new Float32Array(w * h));
      this.lastLayers = this.fields.map((_, i) => i);
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
    const px = this.image!.data;
    // Only the rows/columns any blob touched can be non-empty; clear the rest.
    px.fill(0);
    if (maxX < minX || maxY < minY) {
      this.ctx.putImageData(this.image!, 0, 0);
      return;
    }
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const i = y * w + x;
      let r = 0, g = 0, bl = 0, a = 0;
      for (const l of layers) {
        const fieldL = this.fields[l];
        const f = fieldL[i];
        if (f <= THRESHOLD - 0.25) continue;
        // Gradient by finite difference, standing in for the shader's fwidth():
        // it makes the edge and outline a fixed pixel width at any blob size.
        const gx = Math.abs((fieldL[i + 1] ?? f) - (fieldL[i - 1] ?? f)) / 2;
        const gy = Math.abs((fieldL[i + w] ?? f) - (fieldL[i - w] ?? f)) / 2;
        const fw = Math.max(gx + gy, 1e-5);
        const lo = THRESHOLD - fw;
        const hi = THRESHOLD + fw;
        if (f <= lo) continue;
        const s = f >= hi ? 1 : ((f - lo) / (hi - lo)) ** 2 * (3 - 2 * ((f - lo) / (hi - lo)));
        const t = Math.min(1, Math.max(0, (f - hi) / (fw * OUTLINE_PX)));
        const edge = 1 - t * t * (3 - 2 * t);
        const la = Math.max(s * colors[l * 4 + 3], s * edge * colors[l * 4 + 3]);
        const dim = 1 - (1 - OUTLINE_DARKEN) * edge;
        const cr = colors[l * 4] * dim;
        const cg = colors[l * 4 + 1] * dim;
        const cb = colors[l * 4 + 2] * dim;
        r = cr * la + r * (1 - la);
        g = cg * la + g * (1 - la);
        bl = cb * la + bl * (1 - la);
        a = la + a * (1 - la);
      }
      // ImageData is straight (not premultiplied) alpha.
      const o = i * 4;
      px[o] = a > 0 ? (r / a) * 255 : 0;
      px[o + 1] = a > 0 ? (g / a) * 255 : 0;
      px[o + 2] = a > 0 ? (bl / a) * 255 : 0;
      px[o + 3] = a * 255;
    }
    this.ctx.putImageData(this.image!, 0, 0);
  }
}

class GpuTerritory {
  readonly canvas = document.createElement("canvas");
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private balls = new Float32Array(MAX_BALLS * 4);

  constructor() {
    this.gl = this.canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (this.gl) this.init(this.gl);
  }

  get available(): boolean {
    return this.prog !== null;
  }

  private init(gl: WebGL2RenderingContext): void {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("territory shader:", gl.getShaderInfoLog(s));
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
      console.warn("territory program:", gl.getProgramInfoLog(prog));
      return;
    }
    this.prog = prog;
    gl.useProgram(prog);
    for (const name of ["uBalls", "uColors", "uCount", "uTime"]) {
      this.loc[name] = gl.getUniformLocation(prog, name);
    }
    // Fullscreen triangle.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  }

  /** Renders the current frame into `this.canvas`. Returns false if unavailable. */
  render(world: World, camera: Camera, timeMs: number, shown: (id: number) => boolean): boolean {
    const gl = this.gl;
    if (!gl || !this.prog) return false;

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
    const balls = collectBalls(world, camera, scale, w, h, shown, layerOf);
    // .w packs layer and the node's stable wobble seed: layer * 1000 + seed.
    balls.forEach((b, i) => this.balls.set([b.x, h - b.y, b.r, b.layer * 1000 + b.seed], i * 4));
    const count = balls.length;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform4fv(this.loc.uBalls, this.balls);
    gl.uniform4fv(this.loc.uColors, layerColors(world, layerOf));
    gl.uniform1i(this.loc.uCount, count);
    gl.uniform1f(this.loc.uTime, timeMs / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
