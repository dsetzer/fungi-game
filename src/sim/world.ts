import type { BotLevel } from "./bot";
import {
  BOOST_MAX,
  BOOST_MIN_COLONY_DISTANCE,
  BOOST_MIN_FALL_DISTANCE,
  BOOST_POOL,
  BOOST_SPAWN_SECONDS,
  BOOST_START,
  BRANCH_OUT_PIPES,
  DT,
  FLOW_COOLDOWN_SECONDS,
  FLOW_MULTIPLIER,
  FLOW_SECONDS,
  HARVEST_MULTIPLIER,
  RIND_MULTIPLIER,
  SIPHON_MULTIPLIER,
  REACH_BONUS,
  SEVER_COOLDOWN_SECONDS,
  SIM_HZ,
  VISION_BONUS,
  VISION_MIN,
  VISION_REACH_SCALE,
  EJECT_FRACTION_DEFAULT,
  EJECT_FRACTION_MAX,
  EJECT_FRACTION_MIN,
  EJECT_MIN_AMOUNT,
  EJECT_MIN_PARENT_REMAINING,
  FALL_CLUSTER_BLOBS_MAX,
  FALL_CLUSTER_BLOBS_MIN,
  FALL_CLUSTER_GAP,
  FALL_CLUSTER_LOOSE_MAX,
  FALL_CLUSTER_LOOSE_MIN,
  FALL_CLUSTER_TIGHT_GAP,
  FALL_CLUSTER_TIGHT_MAX,
  FALL_POOL_MAX,
  FALL_POOL_MIN,
  FALLS_PAY_UPKEEP,
  MAX_OUT_PIPES_PER_COLONY,
  NEUTRAL_FALL_CLUSTERS,
  PIPE_RATE_PER_SEC,
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
import {
  BOOST_KINDS,
  type Barrier,
  type BoostKind,
  type CheckResult,
  type Command,
  type EntityId,
  type GameNode,
  type Pipe,
  type Player,
  type PlayerId,
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
  /** How the computer players in this match play (solo and spectate). */
  botLevel: BotLevel = "normal";

  private nextId = 1;
  private queue: Command[] = [];
  /** Which boosts each player holds; rebuilt lazily after anything changes owner or dies. */
  private held: Map<PlayerId, Set<BoostKind>> | null = null;
  readonly rng: () => number;

  constructor(readonly arena: Arena, seed = 1) {
    this.rng = makeRng(seed ^ 0x9e3779b9);
  }

  /** A full round: generated arena, spawned players, scattered nutrient falls. */
  /** A solo match. With `allBots`, every seat is a bot — something to spectate. */
  static createMatch(seed: number, playerCount = PLAYER_COUNT, allBots = false): World {
    const world = new World(generateArena(seed, playerCount), seed);
    world.arena.spawns.forEach((s, i) => {
      const human = i === 0 && !allBots;
      const player = world.addPlayer(human ? "You" : `Bot ${i + (allBots ? 1 : 0)}`, !human);
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
    world.placeBoosts(BOOST_START);
    return world;
  }

  // ---------- setup helpers ----------

  addPlayer(name: string, isBot: boolean): Player {
    const id = this.players.length + 1;
    const player: Player = {
      id, name, isBot, alive: true, score: 0,
      abilities: { flowUntil: 0, flowReadyAt: 0, severReadyAt: 0 },
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

  addBoost(x: number, y: number, boost: BoostKind, nutrients = BOOST_POOL): GameNode {
    return this.addNode({ kind: "boost", owner: null, x, y, nutrients, boost });
  }

  private addNode(n: Omit<GameNode, "id" | "rate" | "seed">): GameNode {
    const node: GameNode = { ...n, id: this.nextId++, rate: 0, seed: this.rng() * 1000 };
    this.nodes.set(node.id, node);
    this.boostsChanged();
    return node;
  }

  /**
   * Scatters boosts (§6.7) on open, reachable ground on their own: well away from
   * every colony and outside anyone's territory, so each is a trip to make and a
   * point to fight over, and clear of the falls, so none reads as part of a
   * cluster. The kind is random.
   */
  placeBoosts(count: number): void {
    let placed = 0;
    for (let attempt = 0; placed < count && attempt < count * 80; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const d = Math.sqrt(this.rng()) * (this.arena.radius - 120);
      const p = { x: Math.cos(a) * d, y: Math.sin(a) * d };
      if (!this.arena.isReachable(p) || !this.isFreeSpot(p, NODE_SPACING * 2, 0)) continue;
      const crowded = [...this.nodes.values()].some((n) => {
        const d = dist(n.x, n.y, p.x, p.y);
        return n.kind === "fall" ? d < BOOST_MIN_FALL_DISTANCE : d < BOOST_MIN_COLONY_DISTANCE;
      });
      const nearSpawn = this.arena.spawns.some((s) => dist(s.x, s.y, p.x, p.y) < BOOST_MIN_COLONY_DISTANCE);
      if (crowded || nearSpawn) continue;
      this.addBoost(p.x, p.y, BOOST_KINDS[Math.floor(this.rng() * BOOST_KINDS.length)]);
      placed++;
    }
  }
  /**
   * A small, loose group of falls (§6.4): 1–6 of them, of which 1–3 sit right
   * next to each other at the centre and the rest are scattered around it. Each
   * fall's size is its own roll, anywhere from a scrap to a feast.
   *
   * With `facing` (a spawn), the group has at least three falls and one of the
   * scattered ones lies toward it, inside starting reach: the first meal.
   * Falls that would land in a wall or on another node are skipped.
   */
  addFallCluster(centre: Vec, facing?: Vec): GameNode[] {
    const roll = (min: number, max: number) => min + Math.floor(this.rng() * (max - min + 1));
    let count = roll(FALL_CLUSTER_BLOBS_MIN, FALL_CLUSTER_BLOBS_MAX);
    if (facing) count = Math.max(3, count);
    // The tight core; a spawn's group always keeps one fall back to aim at it.
    const tight = Math.min(roll(1, FALL_CLUSTER_TIGHT_MAX), facing ? count - 1 : count);
    const placed: GameNode[] = [];
    for (let i = 0; i < count; i++) {
      const aimed = facing !== undefined && i === tight;
      const d =
        i === 0 ? 0
        : i < tight ? FALL_CLUSTER_TIGHT_GAP * (0.8 + this.rng() * 0.4)
        : aimed ? FALL_CLUSTER_LOOSE_MAX * 0.85
        : FALL_CLUSTER_LOOSE_MIN + this.rng() * (FALL_CLUSTER_LOOSE_MAX - FALL_CLUSTER_LOOSE_MIN);
      const a = aimed
        ? Math.atan2(facing.y - centre.y, facing.x - centre.x) + (this.rng() - 0.5) * 0.6
        : this.rng() * Math.PI * 2;
      // Around a tight neighbour rather than the exact centre, so the core is a clump.
      const from = i > 0 && i < tight ? placed[placed.length - 1] ?? centre : centre;
      const p = { x: from.x + Math.cos(a) * d, y: from.y + Math.sin(a) * d };
      const pool = Math.round(FALL_POOL_MIN * (FALL_POOL_MAX / FALL_POOL_MIN) ** this.rng());
      if (this.isFreeSpot(p, NODE_SPACING)) placed.push(this.addFall(p.x, p.y, pool));
    }
    return placed;
  }

  private scatterNeutralClusters(count: number): void {
    let placed = 0;
    for (let attempt = 0; placed < count && attempt < count * 50; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const d = Math.sqrt(this.rng()) * (this.arena.radius - FALL_CLUSTER_LOOSE_MAX - 40);
      const c = { x: Math.cos(a) * d, y: Math.sin(a) * d };
      // Keep neutral clusters away from spawns so each player's home cluster is theirs.
      const nearSpawn = this.arena.spawns.some(
        (s) => dist(s.x, s.y, c.x, c.y) < SPAWN_CLUSTER_DISTANCE * 2.5,
      );
      // Groups stay apart: two side by side would read as one big clump.
      const crowded = [...this.nodes.values()].some(
        (n) => n.kind === "fall" && dist(n.x, n.y, c.x, c.y) < FALL_CLUSTER_GAP,
      );
      if (crowded) continue;
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

  /**
   * Visual size of the fluid area around a node — grows with its nutrients. A
   * boost has none: it is a marker on the map, not ground anyone holds.
   */
  auraOf(n: GameNode): number {
    if (n.kind === "boost") return 0;
    return n.kind === "colony" ? colonyAura(n.nutrients) : fallAura(n.nutrients);
  }

  /** Reach grows with a node's store, capped; the Reach boost adds to it (§6.7). */
  reachOf(n: GameNode): number {
    return reach(n.nutrients) + (this.holds(n.owner, "reach") ? REACH_BONUS : 0);
  }

  /** How far a node of yours lights up the fog (§8); the Vision boost widens it. */
  visionOf(n: GameNode): number {
    const r = Math.max(VISION_MIN, this.reachOf(n) * VISION_REACH_SCALE);
    return this.holds(n.owner, "vision") ? r * VISION_BONUS : r;
  }

  // ---------- boosts (§6.7) ----------

  /**
   * Forget which boosts are held, after a node changes owner, appears or dies.
   * The sim calls this itself; a client filling the world from snapshots calls it
   * once per snapshot.
   */
  boostsChanged(): void {
    this.held = null;
  }

  /** Whether a player holds a boost of this kind. Holding two changes nothing. */
  holds(player: PlayerId | null, boost: BoostKind): boolean {
    if (player == null) return false;
    if (!this.held) {
      this.held = new Map();
      for (const n of this.nodes.values()) {
        if (n.kind !== "boost" || n.owner == null || !n.boost) continue;
        const set = this.held.get(n.owner) ?? new Set<BoostKind>();
        set.add(n.boost);
        this.held.set(n.owner, set);
      }
    }
    return this.held.get(player)?.has(boost) ?? false;
  }

  /** Output slots on a node you own: doubled by Branch. */
  outputCap(nodeId: EntityId): number {
    return this.holds(this.nodes.get(nodeId)?.owner ?? null, "branch") ? BRANCH_OUT_PIPES : MAX_OUT_PIPES_PER_COLONY;
  }

  /** Whether a player's Flow is running right now. Losing the boost ends it. */
  flowActive(player: PlayerId): boolean {
    const p = this.player(player);
    return !!p && this.tick < p.abilities.flowUntil && this.holds(player, "flow");
  }

  canFlow(player: PlayerId): CheckResult {
    const p = this.player(player);
    if (!p || !this.holds(player, "flow")) return NO("you don't hold Flow");
    if (this.tick < p.abilities.flowReadyAt) return NO("Flow is recharging");
    return YES;
  }

  canSever(player: PlayerId, pipeId: EntityId): CheckResult {
    const p = this.player(player);
    if (!p || !this.holds(player, "sever")) return NO("you don't hold Sever");
    if (this.tick < p.abilities.severReadyAt) return NO("Sever is recharging");
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return NO("no such hypha");
    if (this.holds(pipe.owner, "chitin")) return NO("hardened by Chitin");
    return YES;
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

  /** Blocked by terrain and by any player-built wall. */
  hasLineOfSight(a: Vec, b: Vec): boolean {
    if (this.arena.index.segmentBlocks(a, b)) return false;
    for (const bar of this.barriers.values()) {
      if (this.wallCrosses(bar, a, b)) return false;
    }
    return true;
  }

  /**
   * Both lines of the ⊢ are wall: the crossbar and the stem back to its colony.
   * A line from the anchor colony itself shares the stem's end, so it isn't crossing.
   */
  wallCrosses(bar: Barrier, a: Vec, b: Vec): boolean {
    if (segmentsIntersect(a, b, bar.a, bar.b)) return true;
    const anchor = this.nodes.get(bar.anchor);
    return !!anchor && segmentsIntersect(a, b, anchor, bar);
  }

  /**
   * Hyphae never cross (§6.2): a new line is refused if it crosses any existing
   * hypha, whoever grew it. Two hyphae meeting at a shared node aren't crossing.
   */
  crossesHypha(a: Vec, b: Vec): boolean {
    for (const pipe of this.pipes.values()) {
      const u = this.nodes.get(pipe.from);
      const v = this.nodes.get(pipe.to);
      if (u && v && segmentsIntersect(a, b, u, v)) return true;
    }
    return false;
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
    if (this.ownOutCount(fromId) >= this.outputCap(fromId)) return NO("output limit reached");
    if (dist(from.x, from.y, target.x, target.y) > this.reachOf(from)) return NO("out of reach");
    if (!this.isFreeSpot(target, NODE_SPACING, player)) return NO("inside rival territory");
    if (!this.hasLineOfSight(from, target)) return NO("no line of sight");
    if (this.crossesHypha(from, target)) return NO("crosses a hypha");
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
    if (from.kind !== "fall" && from.owner === player) {
      if (this.ownOutCount(fromId) >= this.outputCap(fromId)) return NO("output limit reached");
    }
    const maxReach = Math.max(...mine.map((n) => this.reachOf(n)));
    if (dist(from.x, from.y, to.x, to.y) > maxReach) return NO("out of reach");
    if (!this.hasLineOfSight(from, to)) return NO("no line of sight");
    if (this.crossesHypha(from, to)) return NO("crosses a hypha");
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
    if (newSource.owner != null && this.ownOutCount(newSource.id) >= this.outputCap(newSource.id)) {
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
      case "flow": {
        if (!this.canFlow(cmd.player).ok) return;
        const a = this.player(cmd.player)!.abilities;
        a.flowUntil = this.tick + FLOW_SECONDS * SIM_HZ;
        a.flowReadyAt = a.flowUntil + FLOW_COOLDOWN_SECONDS * SIM_HZ;
        return;
      }
      case "sever": {
        if (!this.canSever(cmd.player, cmd.pipe).ok) return;
        this.pipes.delete(cmd.pipe);
        this.player(cmd.player)!.abilities.severReadyAt = this.tick + SEVER_COOLDOWN_SECONDS * SIM_HZ;
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
      if (this.wallCrosses(bar, s, e)) this.pipes.delete(p.id);
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
    this.captureBoosts();
    this.removeDead();
    this.updatePlayers();
    this.spawnBoosts();
  }

  /**
   * A neutral boost belongs to the first player to feed it (§6.7). Once owned it
   * stays theirs: a rival takes it away by draining it dry, not by feeding it.
   */
  private captureBoosts(): void {
    for (const p of this.pipes.values()) {
      const dst = this.nodes.get(p.to);
      const src = this.nodes.get(p.from);
      if (dst?.kind !== "boost" || dst.owner != null || src?.owner == null) continue;
      dst.owner = src.owner;
      this.boostsChanged();
    }
  }

  /** Boosts keep appearing through the round, somewhere random, up to a cap. */
  private spawnBoosts(): void {
    if (this.tick % (BOOST_SPAWN_SECONDS * SIM_HZ) !== 0) return;
    let count = 0;
    for (const n of this.nodes.values()) if (n.kind === "boost") count++;
    if (count < BOOST_MAX) this.placeBoosts(1);
  }

  private flowAndUpkeep(): void {
    const delta = new Map<EntityId, number>();
    const add = (id: EntityId, v: number) => delta.set(id, (delta.get(id) ?? 0) + v);

    // Every hypha runs at the same rate, whatever it draws from — a fall, your own
    // colony or a rival's (§6.3). Flow (§6.7) doubles every hypha its holder grew.
    const rateOf = new Map<EntityId, number>();
    const demandOf = new Map<EntityId, number>();
    for (const p of this.pipes.values()) {
      const src = this.nodes.get(p.from)!;
      const boosted = this.flowActive(p.owner) ? FLOW_MULTIPLIER : 1;
      // A hypha draining a rival's node (§6.7): Siphon makes its grower pull
      // harder, Rind makes the victim give up less. Together they cancel.
      const drain = src.owner != null && src.owner !== p.owner;
      const siphon = drain && this.holds(p.owner, "siphon") ? SIPHON_MULTIPLIER : 1;
      const rind = drain && this.holds(src.owner, "rind") ? RIND_MULTIPLIER : 1;
      const r = PIPE_RATE_PER_SEC * DT * boosted * siphon * rind;
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
      // Every hypha is 1:1 — except a fall line grown by a Harvest holder (§6.7),
      // which yields double: the one way a sustain loop pays.
      const harvest = src.kind === "fall" && this.holds(p.owner, "harvest") ? HARVEST_MULTIPLIER : 1;
      const gained = amount * harvest;
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
    // Anything owned pays: colonies, and boosts once captured. Neutral ground doesn't.
    for (const n of this.nodes.values()) {
      if (n.owner == null && !FALLS_PAY_UPKEEP) continue;
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
      if (n.kind === "boost") this.boostsChanged();
      for (const p of this.pipes.values()) {
        if (p.from === n.id || p.to === n.id) this.pipes.delete(p.id);
      }
      for (const b of this.barriers.values()) {
        if (b.anchor === n.id) this.barriers.delete(b.id);
      }
    }
  }

  private updatePlayers(): void {
    // A player lives on while they have a colony; boosts alone don't count, and
    // go back to neutral when their holder is wiped out.
    const alive = new Set<PlayerId>();
    for (const n of this.nodes.values()) if (n.kind === "colony" && n.owner != null) alive.add(n.owner);
    for (const pl of this.players) pl.alive = alive.has(pl.id);
    for (const n of this.nodes.values()) {
      if (n.kind === "boost" && n.owner != null && !alive.has(n.owner)) {
        n.owner = null;
        this.boostsChanged();
      }
    }

    if (!this.endOnLastStanding) return;
    // With a single player (solo sandbox) the round only ends when they die.
    const threshold = this.players.length > 1 ? 1 : 0;
    if (alive.size <= threshold) {
      this.ended = true;
      this.winner = alive.size === 1 ? [...alive][0] : null;
    }
  }
}
