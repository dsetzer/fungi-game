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
const REACH = 1.7;
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

  vec4 acc = vec4(0.0);
  for (int l = 0; l < MAX_LAYERS; l++) {
    float a = smoothstep(${(THRESHOLD - 0.012).toFixed(4)}, ${(THRESHOLD + 0.012).toFixed(4)}, field[l]) * uColors[l].a;
    acc.rgb = uColors[l].rgb * a + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
  }
  outColor = acc; // premultiplied
}`;

export const NEUTRAL_AURA = { rgb: [0.78, 0.78, 0.8], alpha: 0.75 };
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
  private static readonly SCALE = 0.55;

  render(world: World, camera: Camera, _timeMs: number, shown: (id: number) => boolean): void {
    const scale = CpuTerritory.SCALE;
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
    const layerOf = layerAssigner(world);
    for (const b of collectBalls(world, camera, scale, w, h, shown, layerOf)) {
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
    const layers = [...used].sort((a, b) => a - b);
    this.lastLayers = layers;
    const px = this.image!.data;
    const lo = THRESHOLD - 0.012;
    const hi = THRESHOLD + 0.012;
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
        const f = this.fields[l][i];
        if (f <= lo) continue;
        const s = f >= hi ? 1 : ((f - lo) / (hi - lo)) ** 2 * (3 - 2 * ((f - lo) / (hi - lo)));
        const la = s * colors[l * 4 + 3];
        r = colors[l * 4] * la + r * (1 - la);
        g = colors[l * 4 + 1] * la + g * (1 - la);
        bl = colors[l * 4 + 2] * la + bl * (1 - la);
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
