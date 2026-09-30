import {
  FLOW_SECONDS,
  HARVEST_MULTIPLIER,
  RIND_MULTIPLIER,
  SIPHON_MULTIPLIER,
  MAX_WALLS_PER_COLONY,
  NUTRIENT_SCALE,
  PIPE_RATE_PER_SEC,
  REACH_BONUS,
  SIM_HZ,
  UPKEEP_PER_SEC,
  WALL_COST,
  reach,
} from "../config";
import { dist, type Vec } from "./geometry";
import type { BoostKind, Command, EntityId, GameNode, PlayerId } from "./types";
import type { World } from "./world";

/**
 * Computer players.
 *
 * A bot gets one action at a time, as a person does — a throw, a new line, a cut
 * — so the whole of its skill is in choosing that action well. Each time its
 * hands are free it lists every move open to it, prices each one as the
 * nutrients it should win (or save, or take from a rival) over the next minute,
 * and makes the best. Nothing is scripted as "do this first": tapping a rich
 * fall, draining a rival, closing a loop and throwing toward food all compete on
 * the same scale, and whichever is worth most right now wins.
 *
 * The prices come from the rules themselves (config.ts): a hypha out of a fall
 * yields 10/s until the fall runs dry; a drain on a rival pulls 10/s like any
 * hypha and ends in a kill once the drains on a colony outpace what it takes in; a colony costs upkeep; a throw is worth the food and prey it brings into
 * reach. Bots issue ordinary Commands — no special access to the sim — so they
 * double as example scripts for a future coding API.
 *
 * Difficulty is only how fast it may act, like a player's hands: one action at
 * a time, with a gap after each set by the level. Nothing is saved up.
 */
export type BotLevel = "easy" | "normal" | "hard";

/**
 * Actions per second, one at a time. Every action here is a whole gesture — read
 * the board, pick a target, aim, drag, release — which takes a person 1–2 s even
 * when they know what they want (top RTS players manage roughly one meaningful
 * action a second, with hotkeys rather than aimed drags). Hard is a quick,
 * skilled player; easy a slow one. Bots look at the board every `thinkSeconds`
 * and act if their gap since the last action is up.
 */
export const BOT_LEVELS: Record<BotLevel, { actionsPerSecond: number; thinkSeconds: number }> = {
  easy: { actionsPerSecond: 0.2, thinkSeconds: 0.25 },
  normal: { actionsPerSecond: 0.5, thinkSeconds: 0.25 },
  hard: { actionsPerSecond: 0.7, thinkSeconds: 0.25 },
};

/** Colony stores and fixed prices below are in the game's original units. */
const S = NUTRIENT_SCALE;
/** Seconds of consequence a move is priced over. */
const HORIZON = 60;
/** What a nutrient taken from a rival is worth on top of the nutrient itself. */
const ENEMY_LOSS = 0.4;
/** A rival colony removed: its income gone, its ground and falls opened up. */
const KILL_BONUS = 150 * S;
/** A move must be worth at least this to spend an action on. */
const MIN_VALUE = 15 * S;
/** Candidates checked against the full rules, best first, before giving up. */
const MAX_CHECKED = 40;
/** Keeps the frame budget: past this a bot stops throwing. */
const MAX_COLONIES = 40;
/** Throw directions tried from each colony, and shares of its reach. */
const THROW_DIRECTIONS = 16;
const THROW_LENGTHS = [0.92, 0.65, 0.4];
/** What a throw's gains are worth next to a gain that starts now. */
const THROW_DELAY = 0.6;
/** How much harder a boost pulls throws toward it than its worth once in reach. */
const FAR_BOOST_PULL = 2.5;
/** Holding a boost, priced like nutrients. */
const BOOST_WORTH: Record<BoostKind, number> = {
  branch: 500 * S, reach: 700 * S, vision: 250 * S, harvest: 900 * S, siphon: 650 * S,
  rind: 500 * S, chitin: 250 * S, flow: 600 * S, sever: 600 * S,
};

/** The tick of each bot's last action, per world, so a new match starts fresh. */
const lastActed = new WeakMap<World, Map<PlayerId, number>>();

export function runBot(world: World, player: PlayerId, level: BotLevel = "normal"): void {
  const gap = SIM_HZ / BOT_LEVELS[level].actionsPerSecond;
  const last = lastActed.get(world) ?? new Map<PlayerId, number>();
  lastActed.set(world, last);
  if (world.tick - (last.get(player) ?? -Infinity) < gap) return; // hands still busy

  const mind = new Mind(world, player);
  if (mind.mine.length === 0) return;
  const move = mind.bestMove();
  if (!move) return;
  world.enqueue(move.cmd);
  last.set(player, world.tick);
}

interface Move {
  value: number;
  cmd: Command;
  /** The full rule check, run only on the moves near the top of the list. */
  valid: () => boolean;
}

/** One look at the board: every move open to a player, priced. */
class Mind {
  readonly mine: GameNode[];
  private readonly nodes: GameNode[];
  private readonly rivals: GameNode[];
  private readonly falls: GameNode[];
  private readonly boosts: GameNode[];
  /** Pairs already joined by a hypha (one hypha per pair). */
  private readonly joined = new Set<string>();
  /** Hyphae drawing on each node, whoever grew them. */
  private readonly drainers = new Map<EntityId, number>();
  /** For each rival colony draining one of ours: the victims, and how fast. */
  private readonly attackers = new Map<EntityId, { victim: GameNode; rate: number; pipe: EntityId }[]>();
  /** Hyphae of ours bringing food in from outside the network: falls, boosts, rivals. */
  private readonly income = new Map<EntityId, number>();
  /** Own hyphae in and out of each of our nodes. */
  private readonly ownIn = new Map<EntityId, number>();
  private readonly ownOut = new Map<EntityId, EntityId[]>();
  /** Falls one of our colonies can already reach: a throw toward them adds nothing. */
  private readonly covered = new Set<EntityId>();
  private readonly reachBonus: number;
  /** What a fall line of ours yields per nutrient drawn: 2 with Harvest, else 1. */
  private readonly fallGain: number;
  /** How hard our drains on rivals pull, per line. */
  private readonly drainRate: number;
  private readonly moves: Move[] = [];

  constructor(private world: World, private me: PlayerId) {
    this.nodes = [...world.nodes.values()];
    this.mine = this.nodes.filter((n) => n.kind === "colony" && n.owner === me);
    this.rivals = this.nodes.filter((n) => n.owner != null && n.owner !== me);
    this.falls = this.nodes.filter((n) => n.kind === "fall");
    this.boosts = this.nodes.filter((n) => n.kind === "boost");
    this.reachBonus = world.holds(me, "reach") ? REACH_BONUS : 0;
    this.fallGain = world.holds(me, "harvest") ? HARVEST_MULTIPLIER : 1;
    this.drainRate = PIPE_RATE_PER_SEC * (world.holds(me, "siphon") ? SIPHON_MULTIPLIER : 1);
    for (const p of world.pipes.values()) {
      this.joined.add(pairKey(p.from, p.to));
      this.drainers.set(p.from, (this.drainers.get(p.from) ?? 0) + 1);
      const from = world.nodes.get(p.from);
      const to = world.nodes.get(p.to);
      if (!from || !to) continue;
      if (p.owner === me) {
        if (to.owner === me) this.ownIn.set(to.id, (this.ownIn.get(to.id) ?? 0) + 1);
        if (to.owner === me && from.owner !== me) this.income.set(to.id, (this.income.get(to.id) ?? 0) + 1);
        if (from.owner === me) this.ownOut.set(from.id, [...(this.ownOut.get(from.id) ?? []), p.id]);
      } else if (from.owner === me && to.kind === "colony") {
        const list = this.attackers.get(to.id) ?? [];
        const siphon = world.holds(p.owner, "siphon") ? SIPHON_MULTIPLIER : 1;
        const rind = world.holds(me, "rind") ? RIND_MULTIPLIER : 1;
        list.push({ victim: from, rate: PIPE_RATE_PER_SEC * siphon * rind, pipe: p.id });
        this.attackers.set(to.id, list);
      }
    }
    for (const f of [...this.falls, ...this.boosts]) {
      if (this.mine.some((c) => dist(c.x, c.y, f.x, f.y) <= world.reachOf(c))) this.covered.add(f.id);
    }
  }

  bestMove(): Move | null {
    this.tapFalls();
    this.attack();
    this.defend();
    this.keepAlive();
    this.loopFalls();
    this.takeBoosts();
    this.fireFlow();
    this.wall();
    this.throwColonies();
    this.moves.sort((a, b) => b.value - a.value);
    for (const move of this.moves.slice(0, MAX_CHECKED)) {
      if (move.valid()) return move;
    }
    return null;
  }

  // ---------- pricing ----------

  /**
   * A new hypha out of a fall (or boost): 10/s into our colony (20/s from a fall
   * with Harvest) until the pool is gone, sooner the more hyphae draw on it.
   */
  private tapValue(f: GameNode): number {
    const draws = (this.drainers.get(f.id) ?? 0) + 1;
    const lasts = f.nutrients / (PIPE_RATE_PER_SEC * draws);
    const gain = f.kind === "fall" ? this.fallGain : 1;
    return PIPE_RATE_PER_SEC * gain * Math.min(HORIZON, lasts);
  }

  /**
   * Draining rival colony `v`: we gain what the hypha pulls, they lose it, and if
   * the extra drain puts them into a decline they can't outlast, the colony dies.
   */
  private drainValue(v: GameNode): number {
    const rind = this.world.holds(v.owner, "rind") ? RIND_MULTIPLIER : 1;
    const rate = this.drainRate * rind * (this.world.flowActive(this.me) ? 2 : 1);
    const after = v.rate - rate; // their net once this hypha pulls too
    const lasts = after < 0 ? v.nutrients / -after : Infinity;
    const taken = rate * Math.min(HORIZON, lasts);
    const kill = lasts < HORIZON ? KILL_BONUS + v.nutrients * 0.3 : 0;
    return taken * (1 + ENEMY_LOSS) + kill;
  }

  /** What a colony's losses would cost if it were drained dry by `rate`. */
  private threatened(c: GameNode, rate: number): number {
    return Math.min(c.nutrients, rate * HORIZON) + 40 * S;
  }

  private add(value: number, cmd: Command, valid: () => boolean): void {
    if (value >= MIN_VALUE) this.moves.push({ value, cmd, valid });
  }

  private connect(value: number, from: GameNode, to: GameNode): void {
    if (this.joined.has(pairKey(from.id, to.id))) return;
    this.add(value, { type: "connect", player: this.me, from: from.id, to: to.id }, () =>
      this.world.canConnect(this.me, from.id, to.id).ok,
    );
  }

  private inReach(c: GameNode, p: Vec): boolean {
    return dist(c.x, c.y, p.x, p.y) <= this.world.reachOf(c);
  }

  private hasSlot(c: GameNode): boolean {
    return this.world.ownOutCount(c.id) < this.world.outputCap(c.id);
  }

  /** Our colonies that can reach a point, nearest first. */
  private reaching(p: Vec): GameNode[] {
    return this.mine.filter((c) => this.inReach(c, p)).sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y));
  }

  // ---------- moves ----------

  /** Every fall in reach and not yet drawn on by us, into the colony that needs it most. */
  private tapFalls(): void {
    for (const f of this.falls) {
      if (f.nutrients < 5 * S) continue;
      const takers = this.reaching(f);
      if (takers.length === 0 || takers.some((c) => this.joined.has(pairKey(f.id, c.id)))) continue;
      const value = this.tapValue(f);
      // A colony on its way out is saved by food more than a healthy one gains.
      for (const c of takers.slice(0, 3)) this.connect(value + this.rescueBonus(c), f, c);
    }
  }

  /** Food for a colony that is running down is worth its survival too. */
  private rescueBonus(c: GameNode): number {
    if (c.rate >= 0) return 0;
    const lasts = c.nutrients / -c.rate;
    return lasts < HORIZON ? c.nutrients * 0.5 + 30 * S : 0;
  }

  /**
   * Drain every rival colony (and held boost) that one of ours can reach. A drain
   * on a colony that is draining us also answers it — and one hypha per pair
   * means it can never drain that colony of ours back.
   */
  private attack(): void {
    for (const v of this.rivals) {
      const hunters = this.reaching(v).sort((a, b) => b.nutrients - a.nutrients).slice(0, 3);
      for (const h of hunters) {
        let value: number;
        if (v.kind === "colony") {
          value = this.drainValue(v);
          for (const a of this.attackers.get(v.id) ?? []) value += this.threatened(a.victim, a.rate) * 0.6;
        } else {
          value = this.tapValue(v) + (v.kind === "boost" && v.boost ? BOOST_WORTH[v.boost] * 0.5 : 0);
        }
        this.connect(value, v, h);
      }
    }
  }

  /** Sever through a rival's hypha that is draining us. */
  private defend(): void {
    if (!this.world.holds(this.me, "sever")) return;
    for (const list of this.attackers.values()) {
      for (const a of list) {
        this.add(this.threatened(a.victim, a.rate) + 30 * S, { type: "sever", player: this.me, pipe: a.pipe }, () =>
          this.world.canSever(this.me, a.pipe).ok,
        );
      }
    }
  }

  /**
   * Upkeep. A colony that is shrinking will run dry and die, and its store and
   * its place in the network go with it. Before that happens:
   * - it is spending on lines of ours: flip one whose other end has a surplus to
   *   send back, or — when time is short — cut it;
   * - a neighbour with a surplus can feed it;
   * - nothing comes into it at all (its food ran out): send its store on to a
   *   colony that is gathering, rather than let upkeep eat it.
   */
  private keepAlive(): void {
    for (const c of this.mine) {
      if (c.rate >= 0) continue;
      const lasts = c.nutrients / -c.rate;
      if (lasts > 90) continue;
      const urgent = lasts < 30;
      const saved = c.nutrients * (urgent ? 1 : 0.6) + 60 * S;
      for (const pipeId of this.ownOut.get(c.id) ?? []) {
        const pipe = this.world.pipes.get(pipeId);
        const other = pipe && this.world.nodes.get(pipe.to);
        if (!pipe || !other) continue;
        if (other.kind === "fall") continue; // the far side of a sustain loop: keep it
        // Flipped, the other end loses what it was getting and sends it instead:
        // twice the line rate worse off. Only worth it when it still has a surplus after that.
        if (other.kind === "colony" && other.rate > PIPE_RATE_PER_SEC * 2 + 1) {
          this.add(saved + 10 * S, { type: "reverse", player: this.me, pipe: pipeId }, () =>
            this.world.canReverse(this.me, pipeId).ok,
          );
        }
        if (urgent) this.add(saved, { type: "cut", player: this.me, pipe: pipeId }, () => this.world.pipes.has(pipeId));
      }
      for (const d of this.mine) {
        if (d === c || d.rate <= PIPE_RATE_PER_SEC + 1 || !this.hasSlot(d) || !this.inReach(d, c)) continue;
        this.connect(saved * 0.8, d, c);
      }
      if (!this.income.get(c.id) && this.hasSlot(c)) {
        const home = this.mine
          .filter((m) => m !== c && (this.income.get(m.id) ?? 0) > 0 && this.inReach(c, m))
          .sort((a, b) => dist(a.x, a.y, c.x, c.y) - dist(b.x, b.y, c.x, c.y))[0];
        if (home) this.connect(c.nutrients * 0.8 + 30 * S, c, home);
      }
    }
  }

  /**
   * A sustain loop (§6.4) around a fall about to run dry — only worth building
   * while holding Harvest, the one thing that makes a fall line yield more than
   * it draws: the fall feeds colony C, C feeds colony D, and D feeds the fall
   * back. The pool holds, D passes on exactly what it gets, and C nets the
   * Harvest surplus for as long as the loop stands. Only
   * offered where C already feeds D (usually the cord from a throw) — a D with
   * nothing coming in would just drain itself into the fall.
   */
  private loopFalls(): void {
    if (this.fallGain <= 1) return;
    for (const f of this.falls) {
      if (f.nutrients > 150 * S || (this.drainers.get(f.id) ?? 0) !== 1) continue;
      let into: GameNode | undefined;
      let fed = false;
      for (const p of this.world.pipes.values()) {
        if (p.from === f.id && p.owner === this.me) into = this.world.nodes.get(p.to);
        if (p.to === f.id) fed = true;
      }
      if (!into || fed) continue;
      const value = HORIZON * (this.fallGain - 1) * PIPE_RATE_PER_SEC + (150 * S - f.nutrients) * 0.3;
      for (const pipeId of this.ownOut.get(into.id) ?? []) {
        const d = this.world.nodes.get(this.world.pipes.get(pipeId)?.to ?? -1);
        if (d?.kind === "colony" && d.owner === this.me && this.hasSlot(d) && this.inReach(d, f)) this.connect(value, d, f);
      }
    }
  }

  /** Capture neutral boosts, keep ours fed, and loop a stocked one for income. */
  private takeBoosts(): void {
    for (const b of this.boosts) {
      if (!b.boost) continue;
      const worth = BOOST_WORTH[b.boost] * (this.world.holds(this.me, b.boost) && b.owner !== this.me ? 0.15 : 1);
      if (b.owner == null) {
        // One tick of feeding captures it, so even a poor colony can.
        for (const c of this.reaching(b)) if (c.nutrients > 30 * S && this.hasSlot(c)) this.connect(worth, c, b);
      } else if (b.owner === this.me) {
        const fed = [...this.world.pipes.values()].some((p) => p.to === b.id && p.owner === this.me);
        if (!fed && b.nutrients < 200 * S) {
          for (const c of this.reaching(b)) if (c.nutrients > 100 * S && this.hasSlot(c)) this.connect(worth * 0.6, c, b);
        }
        if (fed && b.nutrients > 250 * S) {
          for (const c of this.reaching(b)) this.connect(this.tapValue(b) * 0.5, b, c);
        }
      }
    }
  }

  /** Flow doubles every hypha of ours for a while: worth what they carry meanwhile. */
  private fireFlow(): void {
    if (!this.world.canFlow(this.me).ok) return;
    let perSecond = 0;
    for (const p of this.world.pipes.values()) {
      if (p.owner !== this.me) continue;
      const from = this.world.nodes.get(p.from);
      const to = this.world.nodes.get(p.to);
      if (!from || !to || from.owner === this.me) continue;
      perSecond += from.kind === "fall" ? PIPE_RATE_PER_SEC * this.fallGain : from.kind === "colony" ? this.drainRate : PIPE_RATE_PER_SEC;
    }
    this.add(perSecond * FLOW_SECONDS - 40, { type: "flow", player: this.me }, () => this.world.canFlow(this.me).ok);
  }

  /**
   * A rival colony that can latch onto a colony of ours worth keeping, where ours
   * can't reach back, gets a wall across the line between them before it does.
   * (Where ours can reach it, draining it is the better answer: it takes their
   * nutrients, and one hypha per pair means they can't drain us back.) Priced as
   * the drain it prevents, and the colony too if that drain would finish it.
   */
  private wall(): void {
    for (const c of this.mine) {
      if (c.nutrients < 60 * S || this.world.wallCount(c.id) >= MAX_WALLS_PER_COLONY) continue;
      for (const x of this.rivals) {
        if (x.kind !== "colony") continue;
        const d = dist(c.x, c.y, x.x, x.y);
        if (d > this.world.reachOf(x) || d <= this.world.reachOf(c) || this.joined.has(pairKey(c.id, x.id))) continue;
        const along = Math.min(this.world.reachOf(c) * 0.8, d * 0.4);
        const spot = { x: c.x + ((x.x - c.x) / d) * along, y: c.y + ((x.y - c.y) / d) * along };
        const after = c.rate - PIPE_RATE_PER_SEC;
        const dies = after < 0 && c.nutrients / -after < HORIZON;
        const value = Math.min(c.nutrients, PIPE_RATE_PER_SEC * HORIZON) * (1 + ENEMY_LOSS) + (dies ? 100 * S : 0) - WALL_COST;
        this.add(value, { type: "wall", player: this.me, from: c.id, ...spot }, () =>
          this.world.hasLineOfSight(c, x) && !this.world.crossesHypha(c, x) && this.world.canBuildWall(this.me, c.id, spot).ok,
        );
      }
    }
  }

  /**
   * Throw a colony. A landing spot is worth the food and prey it brings into reach
   * that no colony of ours reaches yet (shared over the actions it takes to tap
   * them), plus progress toward richer ground further off: a
   * throw that covers a third of the way to a cluster is worth a third of that
   * cluster, so a bot with nothing in reach still heads somewhere good, and a
   * throw that gets no nearer anything is worth nothing. Against that: the new
   * colony's upkeep.
   */
  private throwColonies(): void {
    if (this.mine.length >= MAX_COLONIES) return;
    const food = [...this.falls, ...this.boosts.filter((b) => b.owner !== this.me)]
      .filter((f) => f.nutrients >= 30 * S && !this.covered.has(f.id))
      // A boost far off is worth a long trip: its benefit lasts minutes, not the
      // one minute a fall's tap is priced over.
      .map((f) => ({ node: f, worth: f.kind === "boost" && f.boost ? BOOST_WORTH[f.boost] * FAR_BOOST_PULL : this.tapValue(f) }));
    const prey = this.rivals.filter((r) => r.kind === "colony");
    // What waits at each far target: it and the food around it, a group's worth.
    const cluster = food.map((f) => {
      let worth = 0;
      for (const g of food) if (dist(f.node.x, f.node.y, g.node.x, g.node.y) <= 300) worth += g.worth;
      return { node: f.node, worth };
    });

    for (const parent of this.mine) {
      if (!this.hasSlot(parent)) continue;
      const carried = this.world.ejectAmount(parent);
      if (carried < 25 * S) continue;
      const childReach = reach(carried) + this.reachBonus;
      // The child is fed by a cord out of the parent, 10/s for as long as it
      // stands: a parent that can't afford that is thrown into its own decline.
      const after = parent.rate - PIPE_RATE_PER_SEC;
      const left = parent.nutrients - carried;
      // Only a parent that is gathering is lost by that; one with nothing coming in
      // just moves its store forward into the child.
      const gathering = (this.income.get(parent.id) ?? 0) > 0;
      const parentRisk = gathering && after < 0 && left / -after < HORIZON * 2 ? left * 0.5 + 40 * S : 0;
      // A parent with nothing coming in is only moving its store forward: the
      // child costs nothing it wasn't already losing to upkeep.
      const cost = gathering ? UPKEEP_PER_SEC * HORIZON + parentRisk : 0;
      const r = this.world.reachOf(parent);
      // Far targets, with the distance still to cover before they are in reach.
      const far = cluster
        .map((c) => ({ ...c, d: dist(parent.x, parent.y, c.node.x, c.node.y) }))
        .filter((c) => c.d > childReach)
        .map((c) => ({ ...c, trip: c.d - childReach * 0.8, discount: 1 / (1 + c.d / 2500) }));
      for (let i = 0; i < THROW_DIRECTIONS; i++) {
        const a = (i / THROW_DIRECTIONS) * Math.PI * 2 + (this.me % 7) * 0.1;
        for (const length of THROW_LENGTHS) {
          const spot = { x: parent.x + Math.cos(a) * r * length, y: parent.y + Math.sin(a) * r * length };
          const gains: number[] = [];
          for (const f of food) if (dist(spot.x, spot.y, f.node.x, f.node.y) <= childReach) gains.push(f.worth);
          for (const v of prey) {
            if (dist(spot.x, spot.y, v.x, v.y) <= childReach) gains.push(this.drainValue(v) * 0.6);
          }
          // Per action: the throw, then one more action to tap each thing it brings
          // into reach. Otherwise three falls a throw away outbid one already in
          // reach, and colonies spread out before tapping what they can.
          gains.sort((x, y) => y - x);
          const best = gains.slice(0, 3);
          const near = best.reduce((t, g) => t + g, 0) / (best.length + 1);
          let toward = 0;
          for (const c of far) {
            const covered = (c.d - dist(spot.x, spot.y, c.node.x, c.node.y)) / c.trip;
            if (covered > 0) toward = Math.max(toward, c.worth * Math.min(1, covered) * c.discount * 0.7);
          }
          // Nothing a throw brings pays until more actions follow it, while a tap
          // pays from the moment it's made: take what's in front of you first.
          const value = (near + toward) * THROW_DELAY - cost;
          this.add(value, { type: "eject", player: this.me, from: parent.id, ...spot }, () =>
            this.world.canEject(this.me, parent.id, spot).ok,
          );
        }
      }
    }
  }
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
