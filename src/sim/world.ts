import {
  DT,
  EJECT_FRACTION_DEFAULT,
  EJECT_FRACTION_MAX,
  EJECT_FRACTION_MIN,
  EJECT_MIN_AMOUNT,
  EJECT_MIN_PARENT_REMAINING,
  FALL_DRAIN_GAIN,
  FALL_CLUSTER_BLOBS_MAX,
  FALL_CLUSTER_BLOBS_MIN,
  FALL_CLUSTER_SPREAD,
  FALL_POOL_CENTER,
  FALL_POOL_EDGE,
  FALLS_PAY_UPKEEP,
  MAX_OUT_PIPES_PER_COLONY,
  NEUTRAL_FALL_CLUSTERS,
  PIPE_RATE_PER_SEC,
  attackRate,
  PLAYER_COUNT,
  SPAWN_CLUSTER_DISTANCE,
  START_NUTRIENTS,
  UPKEEP_PER_SEC,
  MAX_WALLS_PER_COLONY,
  WALL_BAR_LENGTH,
  WALL_COST,
  WALLS_CUT_EXISTING_PIPES,
  NODE_CORE_RADIUS,
  NODE_SPACING,
  colonyAura,
  fallAura,
  reach,
} from "../config";
import { generateArena, type Arena } from "./arena";
import {
  dist,
  distToSegmentSq,
  makeRng,
  segmentsIntersect,
  type Vec,
} from "./geometry";
import type {
  Barrier,
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
  readonly barriers = new Map<EntityId, Barrier>();
  readonly players: Player[] = [];
  winner: PlayerId | null = null;
  ended = false;
  /** Server rounds end on a timer and respawn the dead, so last-standing is off. */
  endOnLastStanding = true;

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
      id, name, isBot, alive: true, score: 0,
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
      if (this.isFreeSpot(p, NODE_SPACING)) placed.push(this.addFall(p.x, p.y, pool));
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
      const nearSpawn = this.arena.spawns.some(
        (s) => dist(s.x, s.y, c.x, c.y) < SPAWN_CLUSTER_DISTANCE * 2.5,
      );
      // Skip pockets walled off from the main cave system — nobody could ever reach them.
      if (!nearSpawn && this.arena.isReachable(c) && this.isFreeSpot(c, NODE_SPACING * 2)) {
        this.addFallCluster(c);
        placed++;
      }
    }
  }

  // ---------- queries ----------

  /** By id, not by index: online, player ids don't start at 1 or run contiguously. */
  player(id: PlayerId | null): Player | undefined {
    if (id == null) return undefined;
    for (const p of this.players) if (p.id === id) return p;
    return undefined;
  }

  /** Nodes are points; this is the fixed core used for hit-testing and spacing. */
  radiusOf(_n: GameNode): number {
    return NODE_CORE_RADIUS;
  }

  /** Visual size of the fluid area around a node — grows with its nutrients. */
  auraOf(n: GameNode): number {
    return n.kind === "fall" ? fallAura(n.nutrients) : colonyAura(n.nutrients);
  }

  reachOf(n: GameNode): number {
    return reach(n.nutrients);
  }

  /** Hyphae flowing out of this node. */
  outCount(nodeId: EntityId): number {
    let c = 0;
    for (const p of this.pipes.values()) if (p.from === nodeId) c++;
    return c;
  }

  /**
   * Outgoing hyphae the node's owner grew themselves — what the output cap counts.
   * A rival's drain line is *their* hypha hanging off your colony: it must not eat
   * one of your slots, and a colony with all its slots spent must not be immune to
   * being attacked.
   */
  ownOutCount(nodeId: EntityId): number {
    const owner = this.nodes.get(nodeId)?.owner;
    let c = 0;
    for (const p of this.pipes.values()) if (p.from === nodeId && p.owner === owner) c++;
    return c;
  }

  /** Hyphae flowing into this node. */
  inCount(nodeId: EntityId): number {
    let c = 0;
    for (const p of this.pipes.values()) if (p.to === nodeId) c++;
    return c;
  }

  pipeBetween(a: EntityId, b: EntityId): Pipe | undefined {
    for (const p of this.pipes.values()) {
      if ((p.from === a && p.to === b) || (p.from === b && p.to === a)) return p;
    }
    return undefined;
  }

  /** Blocked by terrain and by any player-built crossbar. */
  hasLineOfSight(a: Vec, b: Vec): boolean {
    if (this.arena.index.segmentBlocks(a, b)) return false;
    for (const bar of this.barriers.values()) {
      if (segmentsIntersect(a, b, bar.a, bar.b)) return false;
    }
    return true;
  }

  wallCount(nodeId: EntityId): number {
    let c = 0;
    for (const b of this.barriers.values()) if (b.anchor === nodeId) c++;
    return c;
  }

  /** Crossbar endpoints for a wall whose stem runs from `from` to `target`. */
  crossbarFor(from: Vec, target: Vec): { a: Vec; b: Vec } {
    const d = dist(from.x, from.y, target.x, target.y) || 1;
    // Unit vector perpendicular to the stem, scaled to half the bar length.
    const px = (-(target.y - from.y) / d) * (WALL_BAR_LENGTH / 2);
    const py = ((target.x - from.x) / d) * (WALL_BAR_LENGTH / 2);
    return {
      a: { x: target.x + px, y: target.y + py },
      b: { x: target.x - px, y: target.y - py },
    };
  }

  /**
   * Inside the arena, not in a wall, not overlapping any node — and, when `player`
   * is given, not inside a rival's territory.
   *
   * A colony's blob is that player's ground: rivals cannot plant inside it, only
   * around its edge. Reaching a node buried in the middle of someone's territory
   * therefore takes enough reach to span the blob, which is what makes a large
   * network genuinely hard to walk into rather than merely large. Neutral falls
   * hold no territory — their blobs never block — or the richest ground on the map
   * would be unplantable.
   *
   * Pass player 0 (no player has that id) to treat every owned blob as a rival's,
   * which is what someone who owns nothing yet, i.e. spawning, wants.
   */
  isFreeSpot(p: Vec, radius: number, player?: PlayerId): boolean {
    if (Math.hypot(p.x, p.y) + radius > this.arena.radius) return false;
    if (this.arena.index.discBlocks(p, radius)) return false;
    for (const n of this.nodes.values()) {
      if (dist(n.x, n.y, p.x, p.y) < this.radiusOf(n) + radius) return false;
      if (player === undefined || n.owner == null || n.owner === player) continue;
      if (dist(n.x, n.y, p.x, p.y) < this.auraOf(n)) return false;
    }
    return true;
  }

  // ---------- rule checks (shared by command validation and input previews) ----------

  /**
   * How much a throw would carry: a share of the parent's store, clamped so the
   * parent keeps something back and tiny throws aren't made at all.
   */
  ejectAmount(from: GameNode, fraction = EJECT_FRACTION_DEFAULT): number {
    const share = Math.min(EJECT_FRACTION_MAX, Math.max(EJECT_FRACTION_MIN, fraction));
    const spare = from.nutrients - EJECT_MIN_PARENT_REMAINING;
    return Math.min(spare, Math.max(EJECT_MIN_AMOUNT, from.nutrients * share));
  }

  canEject(player: PlayerId, fromId: EntityId, target: Vec, fraction?: number): CheckResult {
    const from = this.nodes.get(fromId);
    if (!from || from.kind !== "colony" || from.owner !== player) return NO("not your colony");
    if (this.ejectAmount(from, fraction) < EJECT_MIN_AMOUNT) return NO("too weak to eject");
    // Ejecting auto-grows a hypha parent → child, so the parent needs a free output.
    if (this.ownOutCount(fromId) >= MAX_OUT_PIPES_PER_COLONY) return NO("output limit reached");
    if (dist(from.x, from.y, target.x, target.y) > this.reachOf(from)) return NO("out of reach");
    if (!this.isFreeSpot(target, NODE_SPACING, player)) return NO("inside rival territory");
    if (!this.hasLineOfSight(from, target)) return NO("no line of sight");
    return YES;
  }

  canConnect(player: PlayerId, fromId: EntityId, toId: EntityId): CheckResult {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    if (!from || !to || from === to) return NO("invalid target");
    const mine = [from, to].filter((n) => n.owner === player);
    if (mine.length === 0) return NO("must involve one of your colonies");
    if (this.pipeBetween(fromId, toId)) return NO("already connected — click it to reverse");
    // The cap is on what a colony sends of its own accord, so it only applies when
    // the source is yours. Draining a rival never runs out of slots — otherwise a
    // player who spent all four on their own network would be unattackable.
    if (from.kind === "colony" && from.owner === player) {
      if (this.ownOutCount(fromId) >= MAX_OUT_PIPES_PER_COLONY) return NO("output limit reached");
    }
    const maxReach = Math.max(...mine.map((n) => this.reachOf(n)));
    if (dist(from.x, from.y, to.x, to.y) > maxReach) return NO("out of reach");
    if (!this.hasLineOfSight(from, to)) return NO("no line of sight");
    return YES;
  }

  /**
   * Flipping which way a hypha flows (§6.2). Only the player who grew it may
   * flip it — a rival draining you is answered by cutting, not by commandeering
   * their hypha. The node that becomes the new source needs a free output.
   */
  canReverse(player: PlayerId, pipeId: EntityId): CheckResult {
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return NO("no such hypha");
    if (pipe.owner !== player) return NO("not your hypha");
    const newSource = this.nodes.get(pipe.to);
    if (!newSource) return NO("invalid target");
    if (newSource.kind === "colony" && this.ownOutCount(newSource.id) >= MAX_OUT_PIPES_PER_COLONY) {
      return NO("output limit reached");
    }
    return YES;
  }

  /**
   * A hypha belongs to whoever grew it, wherever its ends are. Only they can cut
   * it or flip it — being drained is not answered by snipping the attacker's
   * hypha, but by killing the colony on the other end of it, walling the line, or
   * out-draining them.
   */
  canCut(player: PlayerId, pipeId: EntityId): CheckResult {
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return NO("no such pipe");
    if (pipe.owner !== player) return NO("not your hypha");
    return YES;
  }

  canBuildWall(player: PlayerId, fromId: EntityId, target: Vec): CheckResult {
    const from = this.nodes.get(fromId);
    if (!from || from.kind !== "colony" || from.owner !== player) return NO("not your colony");
    if (from.nutrients - WALL_COST < EJECT_MIN_PARENT_REMAINING) return NO("too weak to build");
    if (this.wallCount(fromId) >= MAX_WALLS_PER_COLONY) return NO("wall limit reached");
    const d = dist(from.x, from.y, target.x, target.y);
    if (d < this.radiusOf(from) + 10) return NO("too close");
    if (d > this.reachOf(from)) return NO("out of reach");
    if (Math.hypot(target.x, target.y) > this.arena.radius) return NO("outside arena");
    if (!this.hasLineOfSight(from, target)) return NO("no line of sight");
    const { a, b } = this.crossbarFor(from, target);
    for (const n of this.nodes.values()) {
      const r = this.radiusOf(n);
      if (distToSegmentSq(n.x, n.y, a.x, a.y, b.x, b.y) < r * r) return NO("blocked");
    }
    return YES;
  }

  canDemolish(player: PlayerId, wallId: EntityId): CheckResult {
    const wall = this.barriers.get(wallId);
    if (!wall) return NO("no such wall");
    if (wall.owner !== player) return NO("not your wall");
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
        if (!this.canEject(cmd.player, cmd.from, cmd, cmd.fraction).ok) return;
        const parent = this.nodes.get(cmd.from)!;
        const carried = this.ejectAmount(parent, cmd.fraction);
        parent.nutrients -= carried;
        const child = this.addColony(cmd.player, cmd.x, cmd.y, carried);
        this.addPipe(cmd.from, child.id, cmd.player);
        return;
      }
      case "connect": {
        if (this.canConnect(cmd.player, cmd.from, cmd.to).ok) {
          this.addPipe(cmd.from, cmd.to, cmd.player);
        }
        return;
      }
      case "cut": {
        if (this.canCut(cmd.player, cmd.pipe).ok) this.pipes.delete(cmd.pipe);
        return;
      }
      case "reverse": {
        if (!this.canReverse(cmd.player, cmd.pipe).ok) return;
        const pipe = this.pipes.get(cmd.pipe)!;
        [pipe.from, pipe.to] = [pipe.to, pipe.from];
        return;
      }
      case "wall": {
        if (!this.canBuildWall(cmd.player, cmd.from, cmd).ok) return;
        const from = this.nodes.get(cmd.from)!;
        from.nutrients -= WALL_COST;
        const { a, b } = this.crossbarFor(from, cmd);
        const id = this.nextId++;
        const bar: Barrier = { id, owner: cmd.player, anchor: from.id, x: cmd.x, y: cmd.y, a, b };
        this.barriers.set(id, bar);
        if (WALLS_CUT_EXISTING_PIPES) this.cutPipesCrossing(bar);
        return;
      }
      case "demolish": {
        if (this.canDemolish(cmd.player, cmd.wall).ok) this.barriers.delete(cmd.wall);
        return;
      }
    }
  }

  private addPipe(from: EntityId, to: EntityId, owner: PlayerId): Pipe {
    const pipe: Pipe = { id: this.nextId++, from, to, owner };
    this.pipes.set(pipe.id, pipe);
    return pipe;
  }

  private cutPipesCrossing(bar: Barrier): void {
    for (const p of this.pipes.values()) {
      const s = this.nodes.get(p.from)!;
      const e = this.nodes.get(p.to)!;
      if (segmentsIntersect(s, e, bar.a, bar.b)) this.pipes.delete(p.id);
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

    // Every hypha has its own rate. Moving nutrients inside a network, or tapping a
    // fall, runs at the flat pipe rate; a hypha draining a *rival* runs at the
    // attacking colony's attack rate, which is much faster and grows with the
    // attacker's strength — that is what makes killing a player possible.
    const rateOf = new Map<EntityId, number>();
    const demandOf = new Map<EntityId, number>();
    for (const p of this.pipes.values()) {
      const src = this.nodes.get(p.from)!;
      const dst = this.nodes.get(p.to)!;
      const attack =
        src.kind === "colony" && src.owner != null && dst.owner != null && dst.owner !== src.owner;
      const r = (attack ? attackRate(dst.nutrients) : PIPE_RATE_PER_SEC) * DT;
      rateOf.set(p.id, r);
      demandOf.set(p.from, (demandOf.get(p.from) ?? 0) + r);
    }

    // Outflow is computed from start-of-tick stores so pipe order doesn't matter.
    // A node that can't cover all its outgoing pipes splits what it has pro rata.
    const inflow = new Map<EntityId, number>();
    const drained = new Set<EntityId>(); // couldn't cover its outgoing demand this step
    const demand = (id: EntityId) => demandOf.get(id) ?? 0;
    for (const p of this.pipes.values()) {
      const src = this.nodes.get(p.from)!;
      const wanted = demand(p.from);
      const share = Math.min(1, Math.max(0, src.nutrients) / wanted);
      if (share < 1) drained.add(p.from);
      const amount = rateOf.get(p.id)! * share;
      // Draining a fall yields more than it costs the fall (§6.4): gathering is
      // meant to be fast. Colony-to-colony transfers stay 1:1.
      const gained = src.kind === "fall" ? amount * FALL_DRAIN_GAIN : amount;
      // Score is everything drawn into your network from outside it (§7 leaderboard).
      const dst = this.nodes.get(p.to)!;
      if (dst.owner != null && dst.owner !== src.owner) {
        const earner = this.player(dst.owner);
        if (earner) earner.score += gained;
      }
      add(p.from, -amount);
      add(p.to, gained);
      inflow.set(p.to, (inflow.get(p.to) ?? 0) + gained);
    }

    // Upkeep is only charged to nodes that aren't sustained. A node is sustained
    // while nutrients flow into it and its hyphae don't demand more than it
    // receives. Judged on demand, not on what a nearly-empty node managed to send.
    const EPS = 1e-9;
    for (const n of this.nodes.values()) {
      if (n.kind !== "colony" && !FALLS_PAY_UPKEEP) continue;
      const inAmt = inflow.get(n.id) ?? 0;
      const sustained = inAmt > EPS && inAmt + EPS >= demand(n.id);
      if (!sustained) add(n.id, -UPKEEP_PER_SEC * DT);
    }

    for (const n of this.nodes.values()) {
      const d = delta.get(n.id) ?? 0;
      n.nutrients += d;
      n.rate = d / DT;
      // Ran dry while being drained faster than it's fed: it's empty now, even
      // though this step's inflow landed after it gave everything away.
      if (drained.has(n.id) && (inflow.get(n.id) ?? 0) + EPS < demand(n.id)) n.nutrients = 0;
    }
  }

  private removeDead(): void {
    for (const n of this.nodes.values()) {
      if (n.nutrients > 0) continue;
      this.nodes.delete(n.id);
      for (const p of this.pipes.values()) {
        if (p.from === n.id || p.to === n.id) this.pipes.delete(p.id);
      }
      for (const b of this.barriers.values()) {
        if (b.anchor === n.id) this.barriers.delete(b.id);
      }
    }
  }

  private updatePlayers(): void {
    const alive = new Set<PlayerId>();
    for (const n of this.nodes.values()) if (n.owner != null) alive.add(n.owner);
    for (const pl of this.players) pl.alive = alive.has(pl.id);

    if (!this.endOnLastStanding) return;
    // With a single player (solo sandbox) the round only ends when they die.
    const threshold = this.players.length > 1 ? 1 : 0;
    if (alive.size <= threshold) {
      this.ended = true;
      this.winner = alive.size === 1 ? [...alive][0] : null;
    }
  }
}
