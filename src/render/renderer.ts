import { NODE_CORE_RADIUS } from "../config";
import type { Input } from "../input/input";
import type { Vec } from "../sim/geometry";
import type { GameNode, Pipe } from "../sim/types";
import type { World } from "../sim/world";
import type { Camera } from "./camera";
import { TerritoryLayer } from "./territory";

const COLORS = {
  outside: "#e9ecef",
  wallEdge: "#ccd2d8",
  wallFill: "#e7eaee",
  floor: "#ffffff",
  fallCore: "#a3a3aa",
  valid: "#2f9e44",
  invalid: "#e03131",
  warn: "#f08c00",
};

const DEATH_WARN_SECONDS = 20;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private territory = new TerritoryLayer();

  constructor(private canvas: HTMLCanvasElement, private camera: Camera) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.camera.width = w;
    this.camera.height = h;
  }

  draw(world: World, input: Input, timeMs: number, player: number): void {
    const { ctx, camera } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.outside;
    ctx.fillRect(0, 0, camera.width, camera.height);

    ctx.translate(camera.width / 2, camera.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    this.drawFloor(world);
    this.drawAuras(world, timeMs);
    this.drawTerrain(world);
    for (const b of world.barriers.values()) {
      const color = world.player(b.owner)?.color ?? "#888";
      const anchor = world.nodes.get(b.anchor)!;
      this.drawWall(anchor, b, b.a, b.b, color, b.id === input.hoverWall ? 1 : 0.8);
    }
    for (const p of world.pipes.values()) this.drawPipe(world, p, timeMs, p.id === input.hoverPipe);
    const hovered = input.nodeAt(input.cursor);
    // Hovering your own colony shows how far it can reach right now.
    if (hovered?.owner === player && !input.drag && input.wallDrag == null) {
      this.drawReachRing(world, hovered);
    }
    for (const n of world.nodes.values()) this.drawNode(world, n, n === hovered);
    this.drawDragPreview(world, input, player);
    this.drawWallPreview(world, input, player);
  }

  /** Stem from the colony to the crossbar, drawn as a ⊢ like the original. */
  private drawWall(from: Vec, mid: Vec, a: Vec, b: Vec, color: string, alpha: number): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha * 0.7;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(mid.x, mid.y);
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 3.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.globalAlpha = 1;
  }

  private drawWallPreview(world: World, input: Input, player: number): void {
    const fromId = input.wallDrag;
    const from = fromId != null ? world.nodes.get(fromId) : undefined;
    if (!from) return;
    const check = world.canBuildWall(player, from.id, input.cursor);
    const { a, b } = world.crossbarFor(from, input.cursor);
    this.drawReachRing(world, from);
    this.drawWall(from, input.cursor, a, b, check.ok ? COLORS.valid : COLORS.invalid, 0.8);
    if (!check.ok) this.drawReason(check.reason, input.cursor);
  }

  private drawReachRing(world: World, from: GameNode): void {
    const { ctx } = this;
    ctx.strokeStyle = "#0002";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(from.x, from.y, world.reachOf(from), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawReason(reason: string, at: Vec): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.invalid;
    ctx.font = `${14 / this.camera.zoom}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(reason, at.x + 12 / this.camera.zoom, at.y - 8 / this.camera.zoom);
  }

  private drawFloor(world: World): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.floor;
    ctx.beginPath();
    ctx.arc(0, 0, world.arena.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Drawn over the auras so terrain visibly occludes territory. */
  private drawTerrain(world: World): void {
    const { ctx, camera } = this;
    // The cave system is thousands of circles, so only draw what's on screen.
    const halfW = camera.width / 2 / camera.zoom;
    const halfH = camera.height / 2 / camera.zoom;
    const visible = world.arena.index.inRect(
      camera.x - halfW, camera.y - halfH,
      camera.x + halfW, camera.y + halfH,
    );
    // Two passes (slightly larger darker circles underneath) give the merged
    // clusters a single soft outline, like a cloud.
    for (const [pad, color] of [[3, COLORS.wallEdge], [0, COLORS.wallFill]] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const w of visible) {
        ctx.moveTo(w.x + w.r + pad, w.y);
        ctx.arc(w.x, w.y, w.r + pad, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  private drawPipe(world: World, pipe: Pipe, timeMs: number, hovered: boolean): void {
    const { ctx } = this;
    const a = world.nodes.get(pipe.from)!;
    const b = world.nodes.get(pipe.to)!;
    const color = world.player(pipe.owner)?.color ?? "#888";
    const c = pipeControlPoint(a, b, pipe.id);

    ctx.strokeStyle = color;
    ctx.globalAlpha = hovered ? 0.9 : 0.45;
    ctx.lineWidth = hovered ? 4 : 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Nutrient particles travelling from → to.
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const count = Math.max(2, Math.floor(len / 45));
    const phase = (timeMs / 1000) * 0.6;
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const t = (phase + i / count) % 1;
      const p = quadPoint(a, c, b, t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A node is just a point: a fixed-size dot. Its size lives in the aura. */
  private drawNode(world: World, n: GameNode, hovered: boolean): void {
    const { ctx } = this;
    const r = world.radiusOf(n);
    ctx.fillStyle = n.kind === "fall" ? COLORS.fallCore : (world.player(n.owner)?.color ?? "#888");
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (n.kind === "colony") this.drawDeathRing(n, r);

    if (hovered) {
      ctx.fillStyle = "#222";
      ctx.font = `${13 / this.camera.zoom}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(String(Math.floor(n.nutrients)), n.x + r + 6 / this.camera.zoom, n.y);
    }
  }

  /** Fluid areas (metaballs), rendered in screen space and composited here. */
  private drawAuras(world: World, timeMs: number): void {
    const { ctx, camera } = this;
    const layer = this.territory.render(world, camera, timeMs);
    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(layer, 0, 0, camera.width, camera.height);
    ctx.restore();
  }

  /** §8: make "how long until this dies" readable without clicking. */
  private drawDeathRing(n: GameNode, r: number): void {
    if (n.rate >= 0) return;
    const seconds = n.nutrients / -n.rate;
    if (seconds > DEATH_WARN_SECONDS) return;
    const { ctx } = this;
    ctx.strokeStyle = seconds < 5 ? COLORS.invalid : COLORS.warn;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 5, -Math.PI / 2, -Math.PI / 2 + (seconds / DEATH_WARN_SECONDS) * Math.PI * 2);
    ctx.stroke();
  }

  private drawDragPreview(world: World, input: Input, player: number): void {
    if (!input.drag) return;
    const from = world.nodes.get(input.drag.from);
    if (!from) return;
    const { ctx } = this;
    const target = input.nodeAt(input.cursor);
    const end: Vec = target ?? input.cursor;
    const check = target
      ? target.id === from.id
        ? null
        : world.canConnect(player, from.id, target.id)
      : world.canEject(player, from.id, input.cursor);

    if (from.owner === player) this.drawReachRing(world, from);
    if (!check) return;

    const color = check.ok ? COLORS.valid : COLORS.invalid;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!target) {
      ctx.beginPath();
      ctx.arc(end.x, end.y, NODE_CORE_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (!check.ok) this.drawReason(check.reason, end);
  }
}

/** Deterministic sideways bend so hyphae look organic rather than ruled. */
function pipeControlPoint(a: Vec, b: Vec, id: number): Vec {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const bend = Math.sin(id * 12.9898) * 0.12;
  return { x: mx - dy * bend, y: my + dx * bend };
}

function quadPoint(a: Vec, c: Vec, b: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}
