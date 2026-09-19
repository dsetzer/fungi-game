import {
  DT,
  EJECT_BUFFER,
  EJECT_MIN_PARENT_REMAINING,
  FALL_CLUSTER_BLOBS_MAX,
  FALL_CLUSTER_BLOBS_MIN,
  FALL_CLUSTER_SPREAD,
  FALL_POOL_CENTER,
  FALL_POOL_EDGE,
  FALLS_PAY_UPKEEP,
  MAX_PIPES_PER_COLONY,
  NEUTRAL_FALL_CLUSTERS,
  PIPE_RATE_PER_SEC,
  PLAYER_COUNT,
  SPAWN_CLUSTER_DISTANCE,
  START_NUTRIENTS,
  UPKEEP_PER_SEC,
  colonyRadius,
  fallRadius,
  reach,
} from "../config";
import { generateArena, type Arena } from "./arena";
import { dist, makeRng, segmentHitsCircle, type Vec } from "./geometry";
import type {
  CheckResult,
  Command,
  EntityId,
  GameNode,
  Pipe,
  Player,
  PlayerId,
} from "./types";

const PLAYER_COLORS = ["#2f9e44", "#d9480f", "#1971c2", "#9c36b5", "#e8590c", "#0c8599"];
const NO = (reason: string): CheckResult => ({ ok: false, reason });
const YES: CheckResult = { ok: true };

/**
 * Authoritative game state + rules. Contains no DOM/rendering code so the same
 * class can run headless on a server or in tests.
 */
export class World {
  tick = 0;
  readonly nodes = new Map<EntityId, GameNode>();
  readonly pipes = new Map<EntityId, Pipe>();
  readonly players: Player[] = [];
  winner: PlayerId | null = null;
  ended = false;

  private nextId = 1;
  private queue: Command[] = [];
  readonly rng: () => number;

  constructor(readonly arena: Arena, seed = 1) {
    this.rng = makeRng(seed ^ 0x9e3779b9);
  }

  /** A full round: generated arena, spawned players, scattered nutrient falls. */
  static createMatch(seed: number, playerCount = PLAYER_COUNT): World {
    const world = new World(generateArena(seed, playerCount), seed);
    world.arena.spawns.forEach((s, i) => {
      const player = world.addPlayer(i === 0 ? "You" : `Bot ${i}`, i !== 0);
      world.addColony(player.id, s.x, s.y, START_NUTRIENTS);
    });
    // Every spawn gets a cluster next to it: small outer blobs within starting
    // reach, the rich centre just beyond it — the opening race.
    for (const s of world.arena.spawns) {
      const toCentre = Math.atan2(-s.y, -s.x) + (world.rng() - 0.5) * 1.6;
      const centre = {
        x: s.x + Math.cos(toCentre) * SPAWN_CLUSTER_DISTANCE,
        y: s.y + Math.sin(toCentre) * SPAWN_CLUSTER_DISTANCE,
      };
      world.addFallCluster(centre, s);
    }
    world.scatterNeutralClusters(NEUTRAL_FALL_CLUSTERS);
    return world;
  }

  // ---------- setup helpers ----------

  addPlayer(name: string, isBot: boolean): Player {
    const id = this.players.length + 1;
    const player: Player = {
      id, name, isBot, alive: true,
      color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length],
    };
    this.players.push(player);
    return player;
  }

  addColony(owner: PlayerId, x: number, y: number, nutrients: number): GameNode {
    return this.addNode({ kind: "colony", owner, x, y, nutrients });
  }

  addFall(x: number, y: number, nutrients: number): GameNode {
    return this.addNode({ kind: "fall", owner: null, x, y, nutrients });
  }

  private addNode(n: Omit<GameNode, "id" | "rate" | "seed">): GameNode {
    const node: GameNode = { ...n, id: this.nextId++, rate: 0, seed: this.rng() * 1000 };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * A cluster of nutrient blobs of varying size, biggest toward the middle.
   * Blobs that would land in a wall or on another node are skipped.
   */
  addFallCluster(centre: Vec, facing?: Vec): GameNode[] {
    const count =
      FALL_CLUSTER_BLOBS_MIN +
      Math.floor(this.rng() * (FALL_CLUSTER_BLOBS_MAX - FALL_CLUSTER_BLOBS_MIN + 1));
    const placed: GameNode[] = [];
    for (let i = 0; i < count; i++) {
      // First blob sits at the centre; the rest spread outward. With `facing`,
      // the second blob is on the outer edge pointing at it (a spawn's first meal).
      const aimed = i === 1 && facing !== undefined;
      const t = i === 0 ? 0 : aimed ? 1 : 0.35 + this.rng() * 0.65;
      const a = aimed
        ? Math.atan2(facing.y - centre.y, facing.x - centre.x) + (this.rng() - 0.5) * 0.6
        : this.rng() * Math.PI * 2;
      const p = {
        x: centre.x + Math.cos(a) * t * FALL_CLUSTER_SPREAD,
        y: centre.y + Math.sin(a) * t * FALL_CLUSTER_SPREAD,
      };
      const jitter = 0.8 + this.rng() * 0.4;
      const pool = Math.round((FALL_POOL_CENTER + (FALL_POOL_EDGE - FALL_POOL_CENTER) * t) * jitter);
      if (this.isFreeSpot(p, fallRadius(pool) + 6)) placed.push(this.addFall(p.x, p.y, pool));
    }
    return placed;
  }

  private scatterNeutralClusters(count: number): void {
    let placed = 0;
    for (let attempt = 0; placed < count && attempt < count * 50; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const d = Math.sqrt(this.rng()) * (this.arena.radius - FALL_CLUSTER_SPREAD - 40);
      const c = { x: Math.cos(a) * d, y: Math.sin(a) * d };
      // Keep neutral clusters away from spawns so each player's home cluster is theirs.
      const nearSpawn = this.arena.spawns.some((s) => dist(s.x, s.y, c.x, c.y) < 500);
      if (!nearSpawn && this.isFreeSpot(c, fallRadius(FALL_POOL_CENTER) + 6)) {
        this.addFallCluster(c);
        placed++;
      }
    }
  }

  // ---------- queries ----------

  player(id: PlayerId | null): Player | undefined {
    return id == null ? undefined : this.players[id - 1];
  }

  radiusOf(n: GameNode): number {
    return n.kind === "fall" ? fallRadius(n.nutrients) : colonyRadius(n.nutrients);
  }

  reachOf(n: GameNode): number {
    return reach(n.nutrients);
  }

  pipeCount(nodeId: EntityId): number {
    let c = 0;
    for (const p of this.pipes.values()) if (p.from === nodeId || p.to === nodeId) c++;
    return c;
  }

  pipeBetween(a: EntityId, b: EntityId): Pipe | undefined {
    for (const p of this.pipes.values()) {
      if ((p.from === a && p.to === b) || (p.from === b && p.to === a)) return p;
    }
    return undefined;
  }

  hasLineOfSight(a: Vec, b: Vec): boolean {
    return !this.arena.walls.some((w) => segmentHitsCircle(a, b, w));
  }

  /** Inside the arena, not in a wall, not overlapping any node. */
  isFreeSpot(p: Vec, radius: number): boolean {
    if (Math.hypot(p.x, p.y) + radius > this.arena.radius) return false;
    if (this.arena.walls.some((w) => dist(w.x, w.y, p.x, p.y) < w.r + radius)) return false;
    for (const n of this.nodes.values()) {
      if (dist(n.x, n.y, p.x, p.y) < this.radiusOf(n) + radius) return false;
    }
    return true;
  }

  // ---------- rule checks (shared by command validation and input previews) ----------

  canEject(player: PlayerId, fromId: EntityId, target: Vec): CheckResult {
    const from = this.nodes.get(fromId);
    if (!from || from.kind !== "colony" || from.owner !== player) return NO("not your colony");
    if (from.nutrients - EJECT_BUFFER < EJECT_MIN_PARENT_REMAINING) return NO("too weak to eject");
    if (dist(from.x, from.y, target.x, target.y) > this.reachOf(from)) return NO("out of reach");
    if (!this.isFreeSpot(target, colonyRadius(EJECT_BUFFER))) return NO("blocked");
    if (!this.hasLineOfSight(from, target)) return NO("no line of sight");
    return YES;
  }

  canConnect(player: PlayerId, fromId: EntityId, toId: EntityId): CheckResult {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    if (!from || !to || from === to) return NO("invalid target");
    const mine = [from, to].filter((n) => n.owner === player);
    if (mine.length === 0) return NO("must involve one of your colonies");
    if (this.pipeBetween(fromId, toId)) return NO("already connected");
    for (const n of [from, to]) {
      if (n.kind === "colony" && this.pipeCount(n.id) >= MAX_PIPES_PER_COLONY) {
        return NO("pipe limit reached");
      }
    }
    const maxReach = Math.max(...mine.map((n) => this.reachOf(n)));
    if (dist(from.x, from.y, to.x, to.y) > maxReach) return NO("out of reach");
    if (!this.hasLineOfSight(from, to)) return NO("no line of sight");
    return YES;
  }

  canCut(player: PlayerId, pipeId: EntityId): CheckResult {
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return NO("no such pipe");
    const ends = [this.nodes.get(pipe.from), this.nodes.get(pipe.to)];
    if (!ends.some((n) => n?.owner === player)) return NO("not your pipe");
    return YES;
  }

  // ---------- commands ----------

  /** Commands are applied at the start of the next tick, in arrival order. */
  enqueue(cmd: Command): void {
    this.queue.push(cmd);
  }

  private apply(cmd: Command): void {
    switch (cmd.type) {
      case "eject": {
        if (!this.canEject(cmd.player, cmd.from, cmd).ok) return;
        this.nodes.get(cmd.from)!.nutrients -= EJECT_BUFFER;
        this.addColony(cmd.player, cmd.x, cmd.y, EJECT_BUFFER);
        return;
      }
      case "connect": {
        if (!this.canConnect(cmd.player, cmd.from, cmd.to).ok) return;
        const id = this.nextId++;
        this.pipes.set(id, { id, from: cmd.from, to: cmd.to, owner: cmd.player });
        return;
      }
      case "cut": {
        if (this.canCut(cmd.player, cmd.pipe).ok) this.pipes.delete(cmd.pipe);
        return;
      }
    }
  }

  // ---------- simulation ----------

  step(): void {
    if (this.ended) return;
    this.tick++;

    const cmds = this.queue;
    this.queue = [];
    for (const c of cmds) this.apply(c);

    this.flowAndUpkeep();
    this.removeDead();
    this.updatePlayers();
  }

  private flowAndUpkeep(): void {
    const delta = new Map<EntityId, number>();
    const add = (id: EntityId, v: number) => delta.set(id, (delta.get(id) ?? 0) + v);

    // Outflow is computed from start-of-tick stores so pipe order doesn't matter.
    // A node that can't cover all its outgoing pipes splits what it has evenly.
    const outCount = new Map<EntityId, number>();
    for (const p of this.pipes.values()) outCount.set(p.from, (outCount.get(p.from) ?? 0) + 1);

    const inflow = new Map<EntityId, number>();
    const outflow = new Map<EntityId, number>();
    const perStep = PIPE_RATE_PER_SEC * DT;
    for (const p of this.pipes.values()) {
      const src = this.nodes.get(p.from)!;
      const wanted = perStep * outCount.get(p.from)!;
      const amount = perStep * Math.min(1, Math.max(0, src.nutrients) / wanted);
      add(p.from, -amount);
      add(p.to, amount);
      outflow.set(p.from, (outflow.get(p.from) ?? 0) + amount);
      inflow.set(p.to, (inflow.get(p.to) ?? 0) + amount);
    }

    // Upkeep is only charged to nodes that aren't sustained. A node is sustained
    // while nutrients flow into it and it isn't sending out more than it receives.
    const EPS = 1e-9;
    for (const n of this.nodes.values()) {
      if (n.kind !== "colony" && !FALLS_PAY_UPKEEP) continue;
      const inAmt = inflow.get(n.id) ?? 0;
      const sustained = inAmt > EPS && inAmt + EPS >= (outflow.get(n.id) ?? 0);
      if (!sustained) add(n.id, -UPKEEP_PER_SEC * DT);
    }

    for (const n of this.nodes.values()) {
      const d = delta.get(n.id) ?? 0;
      n.nutrients += d;
      n.rate = d / DT;
    }
  }

  private removeDead(): void {
    for (const n of this.nodes.values()) {
      if (n.nutrients > 0) continue;
      this.nodes.delete(n.id);
      for (const p of this.pipes.values()) {
        if (p.from === n.id || p.to === n.id) this.pipes.delete(p.id);
      }
    }
  }

  private updatePlayers(): void {
    const alive = new Set<PlayerId>();
    for (const n of this.nodes.values()) if (n.owner != null) alive.add(n.owner);
    for (const pl of this.players) pl.alive = alive.has(pl.id);

    // With a single player (solo sandbox) the round only ends when they die.
    const threshold = this.players.length > 1 ? 1 : 0;
    if (alive.size <= threshold) {
      this.ended = true;
      this.winner = alive.size === 1 ? [...alive][0] : null;
    }
  }
}
