import {
  EJECT_MIN_AMOUNT,
  EJECT_MIN_PARENT_REMAINING,
  FLOW_MULTIPLIER,
  HARVEST_MULTIPLIER,
  MAX_WALLS_PER_COLONY,
  NODE_SPACING,
  PIPE_RATE_PER_SEC,
  REACH_BONUS,
  RIND_MULTIPLIER,
  SIPHON_MULTIPLIER,
  UPKEEP_PER_SEC,
  WALL_COST,
  reach,
} from "../../config";
import { dist, segmentsIntersect, type Vec } from "../geometry";
import type { BoostKind, Command, EntityId, GameNode, Pipe, PlayerId } from "../types";
import type { World } from "../world";
import {
  BOOST_BASE,
  COLONY,
  ENEMY_LOSS,
  HORIZON,
  KILL,
  LINE,
  pairKey,
  seconds,
  type Candidate,
  type Category,
  type Memory,
} from "./core";
import { navFor, type NavGrid } from "./nav";
import { BOT_LEVELS, type BotProfile } from "./profile";

const RATE = PIPE_RATE_PER_SEC;

/** A rival hypha draining one of our nodes. */
export interface Attack {
  pipe: Pipe;
  victim: GameNode;
  attacker: GameNode;
  /** Nutrients per second it takes, with Siphon and Rind counted. */
  rate: number;
}

/** What the bot knows about one colony of its own this look. */
export interface ColonyInfo {
  node: GameNode;
  /** Smoothed net rate. */
  rate: number;
  /** Seconds until empty at that rate; Infinity if it isn't shrinking. */
  lasts: number;
  /** Food coming in from outside the network, per second (falls, boosts, rivals). */
  income: number;
  /** Our own hyphae into and out of it. */
  ownIn: Pipe[];
  ownOut: Pipe[];
  /** Of ownOut, those that feed another colony of ours. */
  feedsColonies: Pipe[];
  attackedBy: Attack[];
  /** Pays no upkeep: something flows in, and at least as much as it sends. */
  sustained: boolean;
  piece: number;
  /** How badly it wants nutrients (bot-design.md, "need"). */
  need: number;
}

/**
 * One look at the board (bot-design.md, "What a bot tracks"): everything a bot
 * reads before choosing, plus the pricing every layer shares. Built fresh each
 * time the bot's hands are free; cheap queries only — the rules themselves are
 * checked lazily, on the candidates near the top.
 */
export class Board {
  readonly tick: number;
  readonly mine: GameNode[] = [];
  readonly myBoosts: GameNode[] = [];
  readonly info = new Map<EntityId, ColonyInfo>();
  readonly falls: GameNode[] = [];
  readonly boosts: GameNode[] = [];
  readonly rivals: GameNode[] = [];
  readonly rivalBoosts: GameNode[] = [];
  /** Pairs already joined by a hypha (only one per pair). */
  readonly joined = new Set<string>();
  /** Hyphae drawing out of each node / flowing into it, whoever grew them. */
  readonly drawsOn = new Map<EntityId, number>();
  readonly feedsInto = new Map<EntityId, Pipe[]>();
  readonly attacks: Attack[] = [];
  /** Our hyphae draining each rival node, and how fast in total. */
  readonly myDrains = new Map<EntityId, { count: number; rate: number }>();
  readonly pieces = new Map<number, GameNode[]>();
  mainPiece = -1;
  /** Colonies at the head of an expedition: they want nutrients to throw on. */
  readonly leads = new Set<EntityId>();
  readonly nav: NavGrid;
  readonly stats = {
    store: 0,
    income: 0,
    drainOnMe: 0,
    drainedColonies: 0,
    starving: 0,
    preyInReach: 0,
    localEnemyStore: 0,
  };

  constructor(
    readonly world: World,
    readonly me: PlayerId,
    readonly memory: Memory,
    readonly profile: BotProfile = BOT_LEVELS.normal,
  ) {
    this.tick = world.tick;
    this.nav = navFor(world.arena);
    for (const n of world.nodes.values()) {
      if (n.kind === "fall") this.falls.push(n);
      else if (n.kind === "boost") {
        this.boosts.push(n);
        if (n.owner === me) this.myBoosts.push(n);
        else if (n.owner != null) this.rivalBoosts.push(n);
      } else if (n.owner === me) this.mine.push(n);
      else if (n.owner != null) this.rivals.push(n);
    }
    for (const c of this.mine) {
      const rate = memory.rateEma.get(c.id) ?? c.rate;
      this.info.set(c.id, {
        node: c, rate, lasts: rate < 0 ? c.nutrients / -rate : Infinity, income: 0,
        ownIn: [], ownOut: [], feedsColonies: [], attackedBy: [], sustained: false, piece: c.id, need: 0,
      });
    }
    for (const p of world.pipes.values()) {
      this.joined.add(pairKey(p.from, p.to));
      this.drawsOn.set(p.from, (this.drawsOn.get(p.from) ?? 0) + 1);
      this.feedsInto.set(p.to, [...(this.feedsInto.get(p.to) ?? []), p]);
      const from = world.nodes.get(p.from);
      const to = world.nodes.get(p.to);
      if (!from || !to) continue;
      const toInfo = this.info.get(to.id);
      const fromInfo = this.info.get(from.id);
      if (p.owner === me) {
        if (toInfo) {
          if (from.owner === me) toInfo.ownIn.push(p);
          else toInfo.income += this.lineYield(from);
        }
        if (fromInfo) {
          fromInfo.ownOut.push(p);
          if (to.kind === "colony" && to.owner === me) fromInfo.feedsColonies.push(p);
        }
        if (from.owner != null && from.owner !== me) {
          const d = this.myDrains.get(from.id) ?? { count: 0, rate: 0 };
          d.count++;
          d.rate += this.drainRate(from.owner);
          this.myDrains.set(from.id, d);
        }
      } else if (from.owner === me) {
        const attack: Attack = { pipe: p, victim: from, attacker: to, rate: this.rateOnMe(p.owner) };
        this.attacks.push(attack);
        // Only what it has had time to react to shapes the bot's mood and needs.
        if (this.ready(`pipe:${p.id}`)) {
          fromInfo?.attackedBy.push(attack);
          this.stats.drainOnMe += attack.rate;
        }
      }
    }
    for (const i of this.info.values()) {
      const inflow = this.world.inCount(i.node.id);
      i.sustained = inflow > 0 && inflow >= this.world.outCount(i.node.id);
      this.stats.store += i.node.nutrients;
      this.stats.income += i.income;
      if (i.attackedBy.length > 0) this.stats.drainedColonies++;
      if (i.lasts < 45) this.stats.starving++;
    }
    this.findPieces();
    for (const v of this.rivals) {
      if (v.kind !== "colony") continue;
      if (this.mine.some((c) => this.inReach(c, v))) this.stats.preyInReach++;
      if (this.mine.some((c) => dist(c.x, c.y, v.x, v.y) < 1500)) this.stats.localEnemyStore += v.nutrients;
    }
  }

  /**
   * Whether the bot has had its reaction time since this appeared (profile.ts):
   * `node:<id>` for a rival in contact, `pipe:<id>` for a line draining us.
   */
  ready(key: string): boolean {
    const since = this.memory.noticed.get(key);
    return since !== undefined && this.tick - since >= seconds(this.profile.reactionSeconds);
  }

  // ---------- the network ----------

  /**
   * Pieces: our colonies joined by our own hyphae (through our boosts too). A
   * piece is named by its oldest node, so the name survives the piece throwing
   * (a regroup expedition follows its piece by name).
   */
  private findPieces(): void {
    const root = new Map<EntityId, EntityId>();
    for (const n of [...this.mine, ...this.myBoosts]) root.set(n.id, n.id);
    const find = (x: EntityId): EntityId => {
      while (root.get(x) !== x) {
        root.set(x, root.get(root.get(x)!)!);
        x = root.get(x)!;
      }
      return x;
    };
    for (const p of this.world.pipes.values()) {
      if (!root.has(p.from) || !root.has(p.to)) continue;
      const [a, b] = [find(p.from), find(p.to)];
      if (a !== b) root.set(Math.max(a, b), Math.min(a, b));
    }
    for (const c of this.mine) {
      const r = find(c.id);
      this.info.get(c.id)!.piece = r;
      this.pieces.set(r, [...(this.pieces.get(r) ?? []), c]);
    }
    let best = -Infinity;
    for (const [r, list] of this.pieces) {
      const store = list.reduce((t, c) => t + c.nutrients, 0);
      if (store > best) {
        best = store;
        this.mainPiece = r;
      }
    }
  }

  /** Needs are set once expeditions have named their leads (bot-design.md, "need"). */
  computeNeeds(): void {
    for (const i of this.info.values()) {
      let need = 0;
      if (i.lasts < 45) need += 3;
      if (i.attackedBy.length > 0) need += 3;
      if (this.leads.has(i.node.id)) need += 2;
      if (i.income >= RATE && i.rate > 0) need -= 2;
      if (need === 0 && i.node.nutrients > COLONY * 2 && i.feedsColonies.length === 0) need -= 1;
      i.need = need;
    }
  }

  // ---------- rates and prices ----------

  holds(kind: BoostKind, player: PlayerId | null = this.me): boolean {
    return this.world.holds(player, kind);
  }

  /** What one of our hyphae out of this node brings in per second. */
  lineYield(from: GameNode): number {
    return RATE * (from.kind === "fall" && this.holds("harvest") ? HARVEST_MULTIPLIER : 1);
  }

  /** How hard a hypha of ours drains a node of `owner`. */
  drainRate(owner: PlayerId | null): number {
    const siphon = this.holds("siphon") ? SIPHON_MULTIPLIER : 1;
    const rind = this.holds("rind", owner) ? RIND_MULTIPLIER : 1;
    const flow = this.world.flowActive(this.me) ? FLOW_MULTIPLIER : 1;
    return RATE * siphon * rind * flow;
  }

  /** How hard a hypha of `owner` drains one of ours. */
  rateOnMe(owner: PlayerId): number {
    const siphon = this.holds("siphon", owner) ? SIPHON_MULTIPLIER : 1;
    const rind = this.holds("rind") ? RIND_MULTIPLIER : 1;
    const flow = this.world.flowActive(owner) ? FLOW_MULTIPLIER : 1;
    return RATE * siphon * rind * flow;
  }

  /** A new hypha out of a fall or boost: what it yields before the pool runs out. */
  tapValue(f: GameNode): number {
    const draws = (this.drawsOn.get(f.id) ?? 0) + 1;
    const lasts = f.nutrients / (RATE * draws);
    let v = this.lineYield(f) * Math.min(HORIZON, lasts);
    // Kill the source: a fall a rival is looping is their engine.
    if (f.kind === "fall" && (this.feedsInto.get(f.id) ?? []).some((p) => p.owner !== this.me)) v += COLONY * 0.5;
    return v;
  }

  /**
   * Draining rival colony `v`. On its own a drain pays what it takes — the same
   * as tapping a fall, while inviting a drain back — so it's priced a little
   * under a tap. What makes it worth more is a kill: when the drains on the
   * colony outpace what it takes in, it dies within the horizon, and what it
   * loses on the way counts too.
   */
  drainValue(v: GameNode): number {
    const rate = this.drainRate(v.owner);
    const after = v.rate - rate;
    const lasts = after < 0 ? v.nutrients / -after : Infinity;
    const taken = rate * Math.min(HORIZON, lasts);
    if (lasts >= HORIZON) return taken * 0.8;
    return taken * (1 + ENEMY_LOSS) + KILL + v.nutrients * 0.3;
  }

  /** What a colony of ours stands to lose to a drain of `rate` left alone. */
  stake(c: GameNode, rate: number): number {
    const i = this.info.get(c.id);
    const net = (i?.rate ?? c.rate) - rate;
    const dies = net < 0 && c.nutrients / -net < HORIZON;
    return Math.min(c.nutrients, rate * HORIZON) * (1 + ENEMY_LOSS) + (dies ? COLONY : 0);
  }

  /** Drain lines we may still add on this rival colony (profile.maxDrains). */
  drainRoom(target: GameNode): number {
    return this.profile.maxDrains - (this.myDrains.get(target.id)?.count ?? 0);
  }

  /** Emptied on purpose and left to wither (reflexes.ts, evacuate). */
  abandoned(c: GameNode): boolean {
    return (this.memory.abandoned.get(c.id) ?? -Infinity) > this.tick;
  }

  /** Food for a colony running down is worth its survival too. */
  rescueBonus(c: GameNode): number {
    if (this.abandoned(c)) return 0;
    const i = this.info.get(c.id);
    return i && i.lasts < HORIZON ? c.nutrients * 0.5 + COLONY * 0.5 : 0;
  }

  /** Holding a boost of this kind, now, to us (bot-design.md, Boosts). */
  boostWorth(kind: BoostKind): number {
    let m = BOOST_BASE[kind];
    const fullSlots = this.mine.filter((c) => !this.hasSlot(c)).length;
    switch (kind) {
      case "branch": if (fullSlots * 2 >= this.mine.length) m *= 1.5; break;
      case "harvest": m *= 1 + this.falls.filter((f) => this.tapping(f)).length / 4; break;
      case "siphon": if (this.myDrains.size > 0) m *= 1.5; break;
      case "rind": if (this.attacks.length > 0) m *= 2; break;
      case "sever": if (this.attacks.length > 0) m *= 1.5; break;
      case "chitin": m *= this.rivalHolds("sever") ? 3 : 0.5; break;
    }
    if (this.holds(kind)) m *= 0.2; // a second changes nothing
    return m * LINE;
  }

  rivalHolds(kind: BoostKind): boolean {
    return this.world.players.some((p) => p.id !== this.me && p.alive && this.world.holds(p.id, kind));
  }

  /** Whether a hypha of ours already draws on this node. */
  tapping(n: GameNode): boolean {
    return this.mine.some((c) => this.joined.has(pairKey(n.id, c.id)));
  }

  // ---------- geometry ----------

  inReach(c: GameNode, p: Vec): boolean {
    return dist(c.x, c.y, p.x, p.y) <= this.world.reachOf(c);
  }

  hasSlot(n: GameNode): boolean {
    return this.world.ownOutCount(n.id) < this.world.outputCap(n.id);
  }

  /** Our colonies that can reach a point, nearest first. */
  reaching(p: Vec): GameNode[] {
    return this.mine
      .filter((c) => this.inReach(c, p))
      .sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y));
  }

  /** Reach a colony thrown with `store` would have. */
  childReach(store: number): number {
    return reach(store) + (this.holds("reach") ? REACH_BONUS : 0);
  }

  canWallFrom(c: GameNode): boolean {
    return c.nutrients - WALL_COST >= EJECT_MIN_PARENT_REMAINING && this.world.wallCount(c.id) < MAX_WALLS_PER_COLONY;
  }

  /**
   * A wall of ours whose crossbar cuts the line a–b: tried at a few points along
   * it, from the colonies of ours nearest each point. Null if none fits.
   */
  wallAcross(a: Vec, b: Vec): Command | null {
    const anchors = this.mine.filter((c) => this.canWallFrom(c));
    for (const t of [0.35, 0.5, 0.65, 0.25, 0.75]) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const near = anchors
        .filter((c) => this.inReach(c, p) && dist(c.x, c.y, p.x, p.y) > 25)
        .sort((x, y) => dist(x.x, x.y, p.x, p.y) - dist(y.x, y.y, p.x, p.y))
        .slice(0, 3);
      for (const c of near) {
        const bar = this.world.crossbarFor(c, p);
        if (!segmentsIntersect(a, b, bar.a, bar.b)) continue;
        if (!this.world.canBuildWall(this.me, c.id, p).ok) continue;
        return { type: "wall", player: this.me, from: c.id, x: p.x, y: p.y };
      }
    }
    return null;
  }

  /**
   * The cost of throwing from `parent` (bot-design.md, Expansion): the throw's
   * cord drains it at the line rate. A gathering hub that can't afford that is
   * saved by a follow-up cut (an action); a relay that feeds others abandons that
   * supply; a tip or island just moves forward into its child. A relay in a piece
   * with nothing coming in — an idle ring — supplies nothing: it only circulates
   * its own store, and throwing from it costs no more than from a tip. (Pricing
   * it as a supply line is what left rings idling forever, far from any food.)
   */
  throwCost(parent: GameNode): number {
    const i = this.info.get(parent.id)!;
    const after = i.rate - RATE;
    if (i.income > 0) return after >= 0 ? UPKEEP_PER_SEC * HORIZON * 0.5 : RATE * 6;
    if (i.feedsColonies.length > 0 && this.pieceIncome(i.piece) > 0) return COLONY * 0.5;
    return 0;
  }

  /** What a piece of our network brings in from outside it, per second. */
  pieceIncome(piece: number): number {
    let income = 0;
    for (const c of this.pieces.get(piece) ?? []) income += this.info.get(c.id)?.income ?? 0;
    return income;
  }

  /**
   * Spots a colony could throw to: rings of directions at a few shares of its
   * reach, keeping only open ground outside rivals' territory. Plenty of them —
   * a grown network's own hyphae fence off most straight lines out of it (hyphae
   * never cross), and with too few spots every throw worth making was blocked
   * and the bot sat idle. The rest of the rules are checked on the chosen few.
   */
  throwSpots(parent: GameNode): { spot: Vec; carried: number; childReach: number }[] {
    const cached = this.spotCache.get(parent.id);
    if (cached) return cached;
    const spots = this.findThrowSpots(parent);
    this.spotCache.set(parent.id, spots);
    return spots;
  }

  private readonly spotCache = new Map<EntityId, { spot: Vec; carried: number; childReach: number }[]>();

  private findThrowSpots(parent: GameNode): { spot: Vec; carried: number; childReach: number }[] {
    const carried = this.world.ejectAmount(parent);
    if (carried < EJECT_MIN_AMOUNT * 2 || !this.hasSlot(parent)) return [];
    const r = this.world.reachOf(parent);
    const childReach = this.childReach(carried);
    const out: { spot: Vec; carried: number; childReach: number }[] = [];
    const turn = (this.me % 7) * 0.13;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2 + turn;
      for (const share of [0.92, 0.72, 0.5, 0.3]) {
        const spot = { x: parent.x + Math.cos(a) * r * share, y: parent.y + Math.sin(a) * r * share };
        if (this.world.isFreeSpot(spot, NODE_SPACING, this.me)) out.push({ spot, carried, childReach });
      }
    }
    return out;
  }

  // ---------- candidate builders ----------

  connect(value: number, from: GameNode, to: GameNode, category: Category, why: string, onChosen?: () => void): Candidate | null {
    if (this.joined.has(pairKey(from.id, to.id))) return null;
    return {
      value, category, why, onChosen,
      cmd: { type: "connect", player: this.me, from: from.id, to: to.id },
      valid: () => this.world.canConnect(this.me, from.id, to.id).ok,
    };
  }

  eject(value: number, parent: GameNode, spot: Vec, category: Category, why: string): Candidate {
    return {
      value, category, why,
      cmd: { type: "eject", player: this.me, from: parent.id, x: spot.x, y: spot.y },
      valid: () => this.world.canEject(this.me, parent.id, spot).ok,
    };
  }
}
