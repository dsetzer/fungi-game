import { EJECT_MIN_AMOUNT, NODE_CORE_RADIUS, colonyAura } from "../config";
import type { Input } from "../input/input";
import type { Vec } from "../sim/geometry";
import type { GameNode, Pipe } from "../sim/types";
import type { World } from "../sim/world";
import type { Camera } from "./camera";
import { FogOfWar } from "./fog";
import { GrowthTracker, easeOutBack } from "./growth";
import { TerrainCache } from "./terrain";
import { TerritoryLayer } from "./territory";

const COLORS = {
  outside: "#e9ecef",
  wallEdge: "#d6dbe0",
  wallFill: "#eef0f3",
  floor: "#ffffff",
  fallCore: "#6f7177",
  fog: "#c9ced4",
  reachRing: "#00000066",
  valid: "#2f9e44",
  invalid: "#e03131",
  warn: "#f08c00",
};

const DEATH_WARN_SECONDS = 20;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private territory = new TerritoryLayer();
  private terrain = new TerrainCache();
  /** Recreated when the round does, so a new arena starts fully fogged. */
  private fog: { arena: World["arena"]; fog: FogOfWar } | null = null;
  private growth = new GrowthTracker();

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
    const t0 = performance.now();
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.outside;
    ctx.fillRect(0, 0, camera.width, camera.height);

    ctx.translate(camera.width / 2, camera.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // Fog decides what exists on screen this frame: your own things always, a
    // rival's only while one of your colonies can see it.
    if (this.fog?.arena !== world.arena) this.fog = { arena: world.arena, fog: new FogOfWar(world.arena.radius) };
    const fog = this.fog.fog;
    fog.update(world, player);
    const seen = fog.visibleNodes(world, player);
    const shown = (id: number) => seen.has(id);
    this.growth.update(world, timeMs);
    const tFog1 = performance.now();

    this.drawFloor(world);
    this.drawAuras(world, timeMs, shown);
    const tAuras = performance.now();
    this.drawTerrain(world);
    const tTerrain = performance.now();
    for (const b of world.barriers.values()) {
      if (b.owner !== player && !fog.isVisible(b.x, b.y)) continue;
      const color = world.player(b.owner)?.color ?? "#888";
      const anchor = world.nodes.get(b.anchor)!;
      this.drawWall(anchor, b, b.a, b.b, color, b.id === input.hoverWall ? 1 : 0.8);
    }
    for (const p of world.pipes.values()) {
      if (!shown(p.from) || !shown(p.to)) continue;
      this.drawPipe(world, p, timeMs, p.id === input.hoverPipe);
    }
    const hovered = input.nodeAt(input.cursor);
    // Hovering your own colony shows how far it can reach right now.
    if (hovered?.owner === player && !input.drag && input.wallDrag == null) {
      this.drawReachRing(world, hovered);
    }
    for (const n of world.nodes.values()) {
      if (shown(n.id)) this.drawNode(world, n, n === hovered, player, timeMs);
    }
    this.drawDragPreview(world, input, player);
    this.drawWallPreview(world, input, player);
    const tEntities = performance.now();
    fog.draw(ctx, camera, COLORS.fog);
    const tEnd = performance.now();

    const p = this.perf;
    const ema = (was: number, now: number) => was * 0.9 + now * 0.1;
    p.vision = ema(p.vision, tFog1 - t0);
    p.auras = ema(p.auras, tAuras - tFog1);
    p.terrain = ema(p.terrain, tTerrain - tAuras);
    p.entities = ema(p.entities, tEntities - tTerrain);
    p.fog = ema(p.fog, tEnd - tEntities);
    p.frame = ema(p.frame, tEnd - t0);
    p.gpuAuras = this.territory.usingGpu;
    p.fallbackReason = this.territory.fallbackReason;
    if (this.showPerf) this.drawPerf();
  }

  /** Rolling per-stage render cost in ms — toggle the overlay with F. */
  readonly perf = {
    vision: 0, auras: 0, terrain: 0, entities: 0, fog: 0, frame: 0, gpuAuras: false, walls: 0,
    /** Why auras are on the CPU fallback, or null when the GPU path is running. */
    fallbackReason: null as string | null,
  };
  showPerf = false;

  private drawPerf(): void {
    const { ctx, camera } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = this.perf;
    const lines = [
      __APP_VERSION__,
      `frame ${p.frame.toFixed(1)}ms`,
      `vision ${p.vision.toFixed(1)}`,
      `auras ${p.auras.toFixed(1)} ${p.gpuAuras ? "(gpu)" : "(cpu)"}`,
      ...(p.fallbackReason ? [`  └ ${p.fallbackReason}`] : []),
      `terrain ${p.terrain.toFixed(1)} · ${p.walls} circles`,
      `entities ${p.entities.toFixed(1)}`,
      `fog ${p.fog.toFixed(1)}`,
    ];
    ctx.font = "12px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      ctx.fillStyle = "#0009";
      ctx.fillText(line, camera.width - 10, 10 + i * 15);
    });
    ctx.restore();
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
    ctx.strokeStyle = COLORS.reachRing;
    ctx.lineWidth = 1.5 / this.camera.zoom;
    const dash = 10 / this.camera.zoom;
    ctx.setLineDash([dash, dash]);
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
    if (this.terrain.shouldUse(camera)) {
      this.perf.walls = 0; // one blit instead of thousands of circles
      this.terrain.blit(ctx, world.arena, COLORS.wallEdge, COLORS.wallFill);
      return;
    }
    // The cave system is thousands of circles, so only draw what's on screen.
    const halfW = camera.width / 2 / camera.zoom;
    const halfH = camera.height / 2 / camera.zoom;
    const visible = world.arena.index.inRect(
      camera.x - halfW, camera.y - halfH,
      camera.x + halfW, camera.y + halfH,
    );
    this.perf.walls = visible.length;
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

  /**
   * A hypha is a chain of V-shaped chevrons with no line under it, fattest in the
   * middle and tapering to points at both ends, always travelling the way the
   * nutrients go. It runs dead straight, exactly as the sim sees it: hyphae block
   * one another (§6.2), so the player has to be able to read where each runs.
   * Sizes are in screen pixels so it reads the same at any zoom.
   */
  private drawPipe(world: World, pipe: Pipe, timeMs: number, hovered: boolean): void {
    const { ctx } = this;
    const src = world.nodes.get(pipe.from)!;
    const dst = world.nodes.get(pipe.to)!;
    const color = world.player(pipe.owner)?.color ?? "#888";
    const zoom = this.camera.zoom;
    const full = Math.hypot(dst.x - src.x, dst.y - src.y);
    if (full === 0) return;
    // A new hypha shoots out from its source; until it arrives it is shorter,
    // and tapers over what has grown so far.
    const len = full * this.growth.grown(pipe.id, timeMs);
    if (len <= 0) return;
    const dx = (dst.x - src.x) / full;
    const dy = (dst.y - src.y) / full;

    const base = (hovered ? 9 : 7.5) / zoom; // half-length of a chevron at its fattest
    const spacing = 10 / zoom;
    const offset = ((timeMs / 1000) * (45 / zoom)) % spacing; // the flow, crawling along
    ctx.fillStyle = color;
    for (let d = offset; d < len; d += spacing) {
      const u = d / len;
      const s = base * (0.3 + 0.7 * Math.sin(u * Math.PI));
      const x = src.x + dx * d;
      const y = src.y + dy * d;
      // Tip ahead, two swept-back wings, and a notch between them: a "V".
      ctx.beginPath();
      ctx.moveTo(x + dx * s, y + dy * s);
      ctx.lineTo(x - dx * s * 0.8 - dy * s * 0.75, y - dy * s * 0.8 + dx * s * 0.75);
      ctx.lineTo(x - dx * s * 0.25, y - dy * s * 0.25);
      ctx.lineTo(x - dx * s * 0.8 + dy * s * 0.75, y - dy * s * 0.8 - dx * s * 0.75);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** A node is just a point: a fixed-size dot. Its size lives in the aura. */
  private drawNode(world: World, n: GameNode, hovered: boolean, player: number, timeMs: number): void {
    const { ctx } = this;
    // A new colony swells into place; one a hypha just landed on gives a bump.
    const formed = this.growth.formed(n.id, timeMs);
    if (formed <= 0) return;
    const r = world.radiusOf(n) * easeOutBack(formed) * (1 + 0.35 * this.growth.pulse(world, n.id, timeMs));
    const color = n.kind === "fall" ? COLORS.fallCore : (world.player(n.owner)?.color ?? "#888");
    // Your own colonies draw hollow while they're too poor to throw, so a colony
    // you can't expand from is obvious before you try to drag off it.
    const tooWeak =
      n.kind === "colony" && n.owner === player && world.ejectAmount(n) < EJECT_MIN_AMOUNT;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    if (tooWeak) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
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
  private drawAuras(world: World, timeMs: number, shown: (id: number) => boolean): void {
    const { ctx, camera } = this;
    const layer = this.territory.render(world, camera, timeMs, shown, (id) =>
      easeOutBack(this.growth.formed(id, timeMs)),
    );
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
      : world.canEject(player, from.id, input.cursor, input.ejectFraction);

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
      // Ghost of the colony about to be thrown, sized by what it would carry,
      // with the share the wheel is set to (§6.1).
      const carried = world.ejectAmount(from, input.ejectFraction);
      ctx.beginPath();
      ctx.arc(end.x, end.y, NODE_CORE_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(end.x, end.y, colonyAura(carried), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (check.ok) {
        const label = `${Math.round(input.ejectFraction * 100)}% · ${Math.round(carried)}`;
        ctx.fillStyle = color;
        ctx.font = `${14 / this.camera.zoom}px system-ui, sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, end.x + 12 / this.camera.zoom, end.y - 8 / this.camera.zoom);
      }
    }
    if (!check.ok) this.drawReason(check.reason, end);
  }
}
