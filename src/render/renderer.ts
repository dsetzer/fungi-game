import { EJECT_BUFFER, TICK_RATE, colonyRadius } from "../config";
import type { Input } from "../input/input";
import type { Vec } from "../sim/geometry";
import type { GameNode, Pipe } from "../sim/types";
import type { World } from "../sim/world";
import type { Camera } from "./camera";

const COLORS = {
  outside: "#e9ecef",
  wallEdge: "#d6dbe0",
  wallFill: "#eef0f3",
  floor: "#ffffff",
  fall: "#9c6b3f",
  fallSpeck: "#6f4a2a",
  valid: "#2f9e44",
  invalid: "#e03131",
  warn: "#f08c00",
};

const DEATH_WARN_SECONDS = 20;

export class Renderer {
  private ctx: CanvasRenderingContext2D;

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

    this.drawArena(world);
    for (const p of world.pipes.values()) this.drawPipe(world, p, timeMs, p.id === input.hoverPipe);
    for (const n of world.nodes.values()) this.drawNode(world, n, timeMs);
    this.drawDragPreview(world, input, player);
  }

  private drawArena(world: World): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.floor;
    ctx.beginPath();
    ctx.arc(0, 0, world.arena.radius, 0, Math.PI * 2);
    ctx.fill();

    // Two passes (slightly larger darker circles underneath) give the merged
    // clusters a single soft outline, like a cloud.
    for (const [pad, color] of [[3, COLORS.wallEdge], [0, COLORS.wallFill]] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (const w of world.arena.walls) {
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

  private drawNode(world: World, n: GameNode, timeMs: number): void {
    const { ctx, camera } = this;
    const r = world.radiusOf(n);

    blobPath(ctx, n, r, timeMs);
    if (n.kind === "fall") {
      ctx.fillStyle = COLORS.fall;
      ctx.fill();
      ctx.fillStyle = COLORS.fallSpeck;
      for (let i = 0; i < 6; i++) {
        const a = n.seed * 7 + i * 2.1;
        const d = r * 0.55 * ((i * 0.37 + n.seed) % 1);
        ctx.beginPath();
        ctx.arc(n.x + Math.cos(a) * d, n.y + Math.sin(a) * d, r * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      const color = world.player(n.owner)?.color ?? "#888";
      ctx.fillStyle = color + "55";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      this.drawDeathRing(n, r);
    }

    if (r * camera.zoom > 14) {
      ctx.fillStyle = n.kind === "fall" ? "#fff" : "#222";
      ctx.font = `${Math.max(10, r * 0.55)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(Math.floor(n.nutrients)), n.x, n.y);
    }
  }

  /** §8: make "how long until this dies" readable without clicking. */
  private drawDeathRing(n: GameNode, r: number): void {
    if (n.lastDelta >= 0) return;
    const seconds = n.nutrients / -n.lastDelta / TICK_RATE;
    if (seconds > DEATH_WARN_SECONDS) return;
    const { ctx } = this;
    ctx.strokeStyle = seconds < 5 ? COLORS.invalid : COLORS.warn;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r + 6, -Math.PI / 2, -Math.PI / 2 + (seconds / DEATH_WARN_SECONDS) * Math.PI * 2);
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

    if (from.owner === player) {
      ctx.strokeStyle = "#0002";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(from.x, from.y, world.reachOf(from), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
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
      ctx.arc(end.x, end.y, colonyRadius(EJECT_BUFFER), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (!check.ok) {
      ctx.fillStyle = color;
      ctx.font = `${14 / this.camera.zoom}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(check.reason, end.x + 12 / this.camera.zoom, end.y - 8 / this.camera.zoom);
    }
  }
}

/** Soft, slightly wobbling outline instead of a perfect circle (§8). */
function blobPath(ctx: CanvasRenderingContext2D, n: GameNode, r: number, timeMs: number): void {
  const points = 24;
  const t = timeMs / 1000;
  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const k =
      1 +
      0.06 * Math.sin(3 * a + n.seed) +
      0.04 * Math.sin(5 * a + n.seed * 2) +
      0.025 * Math.sin(7 * a + t * 0.8 + n.seed);
    const x = n.x + Math.cos(a) * r * k;
    const y = n.y + Math.sin(a) * r * k;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
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
