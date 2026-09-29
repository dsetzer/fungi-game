import { MAX_WALLS_PER_COLONY, NODE_SPACING } from "../config";
import { dist, type Vec } from "./geometry";
import type { Command, GameNode, PlayerId } from "./types";
import type { World } from "./world";

/**
 * Computer players. Every bot plays to win: gathering is the fuel, rivals are the
 * obstacle. Each bot has the same brain — tap every fall it can reach, expand
 * toward food it can't, pick one rival as its enemy and bring the fight to it:
 * supply lines toward the front (reversing lines that flow the wrong way), focus
 * fire on the enemy's weakest colonies, walls where a stronger enemy threatens.
 * Difficulty is only how fast it may
 * act, the way a player is limited by reaction time and hands: each throw, new
 * line or cut spends one action, and actions refill at the level's rate.
 * Bots issue ordinary Commands — no special access to the sim — so they double as
 * example scripts for a future coding API.
 */
export type BotLevel = "easy" | "normal" | "hard";

export const BOT_LEVELS: Record<BotLevel, { actionsPerSecond: number; thinkSeconds: number }> = {
  easy: { actionsPerSecond: 0.5, thinkSeconds: 1 },
  normal: { actionsPerSecond: 1.5, thinkSeconds: 0.5 },
  hard: { actionsPerSecond: 4, thinkSeconds: 0.25 },
};

/** Unspent actions carry over, up to this many — a short burst, not a stockpile. */
const MAX_SAVED_ACTIONS = 3;
/** Throw directions tried when the straight line toward food is blocked. */
const THROW_ANGLES = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05];
/**
 * Shorter throws tried when the full one is refused. Late in a round most food
 * sits inside a rival's territory, where nobody can land — but it only has to be
 * in reach to drain, so landing on the near side of their territory works.
 */
const THROW_LENGTHS = [1, 0.75, 0.5, 0.3];
/** Enough to keep the frame budget: past this a bot stops throwing. */
const MAX_COLONIES = 40;

/** Actions each bot has banked, per world, so a new match starts fresh. */
const banked = new WeakMap<World, Map<PlayerId, number>>();

export function runBot(world: World, player: PlayerId, level: BotLevel = "normal"): void {
  const { actionsPerSecond, thinkSeconds } = BOT_LEVELS[level];
  const bank = banked.get(world) ?? new Map<PlayerId, number>();
  banked.set(world, bank);
  let actions = Math.min(MAX_SAVED_ACTIONS, (bank.get(player) ?? 1) + actionsPerSecond * thinkSeconds);

  // Colonies do the work; boosts the bot holds are handled on their own.
  const mine = [...world.nodes.values()].filter((n) => n.kind === "colony" && n.owner === player);
  if (mine.length > 0 && actions >= 1) {
    const bot = new Brain(world, player, mine, () => actions >= 1, (cmd) => {
      world.enqueue(cmd);
      actions -= 1;
    });
    // Most urgent first; each step stops looking once the actions run out.
    bot.defend();
    bot.useAbilities();
    bot.rescueStarving();
    bot.reconnectStranded();
    bot.tapFalls();
    bot.holdBoosts();
    bot.wallOffThreats();
    bot.attack();
    bot.supplyTheFront();
    bot.cutCordsWhenOverspending();
    bot.expand();
  }
  bank.set(player, actions);
}

class Brain {
  private readonly nodes: GameNode[];
  private readonly falls: GameNode[];
  /** Boosts nobody holds yet, and boosts rivals hold (§6.7). */
  private readonly neutralBoosts: GameNode[];
  private readonly rivalBoosts: GameNode[];
  /** Pairs already joined by a hypha (either direction) or given one this turn. */
  private readonly joined = new Set<string>();
  /** The rival being fought: the nearest, weighted toward weaker ones. Null when alone. */
  private readonly enemy: PlayerId | null;
  /** The enemy's colonies — what the front faces. */
  private readonly enemyColonies: GameNode[];

  constructor(
    private world: World,
    private player: PlayerId,
    private mine: GameNode[],
    private canAct: () => boolean,
    private act: (cmd: Command) => void,
  ) {
    this.nodes = [...world.nodes.values()];
    this.falls = this.nodes.filter((n) => n.kind === "fall");
    this.neutralBoosts = this.nodes.filter((n) => n.kind === "boost" && n.owner == null);
    this.rivalBoosts = this.nodes.filter((n) => n.kind === "boost" && n.owner != null && n.owner !== player);
    for (const p of world.pipes.values()) this.joined.add(pairKey(p.from, p.to));
    this.enemy = this.pickEnemy();
    this.enemyColonies = this.nodes.filter((n) => n.kind === "colony" && n.owner === this.enemy);
  }

  /**
   * The rival to fight: close ones first, and among those the weaker — a nearby
   * weakling is the kill to go for, a distant giant is not.
   */
  private pickEnemy(): PlayerId | null {
    const ours = this.mine.reduce((t, c) => t + c.nutrients, 0) || 1;
    const seen = new Map<PlayerId, { near: number; total: number }>();
    for (const n of this.nodes) {
      if (n.kind !== "colony" || n.owner == null || n.owner === this.player) continue;
      const near = Math.min(...this.mine.map((c) => dist(c.x, c.y, n.x, n.y)));
      const e = seen.get(n.owner) ?? { near: Infinity, total: 0 };
      e.near = Math.min(e.near, near);
      e.total += n.nutrients;
      seen.set(n.owner, e);
    }
    let best: PlayerId | null = null;
    let bestScore = Infinity;
    for (const [id, e] of seen) {
      const score = e.near * (1 + e.total / ours);
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  private readonly frontCache = new Map<number, number>();

  /** How far a colony is from the front: its distance to the nearest enemy colony. */
  private frontDistance(n: GameNode): number {
    const cached = this.frontCache.get(n.id);
    if (cached !== undefined) return cached;
    let d = Infinity;
    for (const e of this.enemyColonies) d = Math.min(d, dist(n.x, n.y, e.x, e.y));
    this.frontCache.set(n.id, d);
    return d;
  }

  private connect(from: GameNode, to: GameNode): boolean {
    const key = pairKey(from.id, to.id);
    if (this.joined.has(key) || !this.inReach(from, to)) return false;
    if (!this.world.canConnect(this.player, from.id, to.id).ok) return false;
    this.joined.add(key);
    this.act({ type: "connect", player: this.player, from: from.id, to: to.id });
    return true;
  }

  /** Cheap distance test before the full check, which traces line of sight. */
  private inReach(a: GameNode, b: GameNode): boolean {
    const mineEnd = a.owner === this.player ? a : b;
    const other = mineEnd === a ? b : a;
    const r = Math.max(this.world.reachOf(mineEnd), other.owner === this.player ? this.world.reachOf(other) : 0);
    return dist(a.x, a.y, b.x, b.y) <= r;
  }

  private byDistanceTo(n: GameNode) {
    return (a: GameNode, b: GameNode) => dist(a.x, a.y, n.x, n.y) - dist(b.x, b.y, n.x, n.y);
  }

  /**
   * Being drained: send the victim nutrients from its richest sibling that
   * reaches it, and drain the attacking colony back from another colony.
   */
  defend(): void {
    for (const p of this.world.pipes.values()) {
      if (!this.canAct()) return;
      if (p.owner === this.player) continue;
      const victim = this.world.nodes.get(p.from);
      const attacker = this.world.nodes.get(p.to);
      if (victim?.owner !== this.player || attacker?.kind !== "colony") continue;
      const others = this.mine.filter((m) => m !== victim).sort((a, b) => b.nutrients - a.nutrients);
      for (const helper of others) {
        if (helper.nutrients > victim.nutrients && this.connect(helper, victim)) break;
      }
      if (!this.canAct()) return;
      for (const avenger of others) if (this.connect(attacker, avenger)) break;
    }
  }

  /**
   * Boosts (§6.7). Scissors cuts a rival's line draining one of ours — the answer
   * to an attacker out of reach — or else a line feeding an enemy colony. Flow is
   * fired whenever it's ready: doubling every hypha only ever speeds up what the
   * network already does, and matters most mid-attack.
   */
  useAbilities(): void {
    if (this.canAct() && this.world.canFlow(this.player).ok) {
      this.act({ type: "flow", player: this.player });
    }
    if (!this.canAct() || !this.world.holds(this.player, "scissors")) return;
    let target: number | null = null;
    for (const p of this.world.pipes.values()) {
      if (p.owner === this.player) continue;
      const from = this.world.nodes.get(p.from);
      const to = this.world.nodes.get(p.to);
      if (from?.owner === this.player) {
        target = p.id; // draining us: cut it first
        break;
      }
      if (target == null && from?.owner === this.enemy && to?.owner === this.enemy && to.kind === "colony") target = p.id;
    }
    if (target != null && this.world.canScissors(this.player, target).ok) {
      this.act({ type: "scissors", player: this.player, pipe: target });
    }
  }

  /**
   * Capture a neutral boost in reach by feeding it; keep boosts we hold fed, and
   * once one is well stocked, drain it back into the colony feeding it — the
   * feed-and-drain loop that holds it for free, as with a fall. A rival's boost in
   * reach is drained, to strip it from them.
   */
  holdBoosts(): void {
    const fedBy = new Map<number, number[]>(); // boost → colonies of ours feeding it
    const drainedTo = new Set<number>(); // boosts of ours we already drain
    for (const p of this.world.pipes.values()) {
      if (p.owner !== this.player) continue;
      const to = this.world.nodes.get(p.to);
      const from = this.world.nodes.get(p.from);
      if (to?.kind === "boost") fedBy.set(to.id, [...(fedBy.get(to.id) ?? []), p.from]);
      if (from?.kind === "boost") drainedTo.add(from.id);
    }
    const feeders = (b: GameNode, least: number) =>
      this.mine.filter((c) => c.nutrients >= least && dist(c.x, c.y, b.x, b.y) <= this.world.reachOf(c)).sort(this.byDistanceTo(b));
    // Capturing takes a single tick of feeding, so even a poor colony can do it.
    for (const b of this.neutralBoosts) {
      if (!this.canAct()) return;
      for (const c of feeders(b, 30)) if (this.connect(c, b)) break;
    }
    for (const b of this.nodes) {
      if (!this.canAct()) return;
      if (b.kind !== "boost" || b.owner !== this.player) continue;
      const feeding = fedBy.get(b.id) ?? [];
      if (feeding.length === 0) {
        if (b.nutrients < 250) for (const c of feeders(b, 120)) if (this.connect(c, b)) break;
        continue;
      }
      if (b.nutrients <= 250 || drainedTo.has(b.id)) continue;
      // Close the loop into a *different* colony — one pair holds one hypha. With
      // no second colony in reach, stop feeding a well-stocked boost instead, and
      // start again when it runs low.
      const takers = this.mine.filter(
        (c) => !feeding.includes(c.id) && dist(c.x, c.y, b.x, b.y) <= Math.max(this.world.reachOf(c), this.world.reachOf(b)),
      );
      let looped = false;
      for (const c of takers.sort(this.byDistanceTo(b))) if ((looped = this.connect(b, c))) break;
      if (!looped && b.nutrients > 600) {
        const feed = [...this.world.pipes.values()].find((p) => p.owner === this.player && p.to === b.id);
        if (feed) this.act({ type: "cut", player: this.player, pipe: feed.id });
      }
    }
    for (const b of this.rivalBoosts) {
      if (!this.canAct()) return;
      const takers = this.mine.filter((c) => dist(c.x, c.y, b.x, b.y) <= this.world.reachOf(c));
      for (const c of takers.sort(this.byDistanceTo(b))) if (this.connect(b, c)) break;
    }
  }

  /** A colony with nothing flowing in is on a countdown: feed it from a richer sibling. */
  rescueStarving(): void {
    const fed = new Set([...this.world.pipes.values()].map((p) => p.to));
    for (const n of this.mine) {
      if (!this.canAct()) return;
      if (fed.has(n.id) || n.nutrients > 60) continue;
      const donors = this.mine.filter((m) => m !== n && m.nutrients > n.nutrients + 60).sort(this.byDistanceTo(n));
      for (const d of donors) if (this.connect(d, n)) break;
    }
  }

  /**
   * Every fall in reach of one of our colonies gets a line to the nearest colony
   * that can take it, richest falls first. Lines coming into a colony use none of
   * its output slots, so one colony can drain many falls — this is gathering.
   */
  tapFalls(): void {
    const falls = [...this.falls].sort((a, b) => b.nutrients - a.nutrients);
    for (const fall of falls) {
      if (!this.canAct()) return;
      if (this.mine.some((c) => this.joined.has(pairKey(fall.id, c.id)))) continue;
      const takers = this.mine.filter((c) => dist(c.x, c.y, fall.x, fall.y) <= this.world.reachOf(c));
      for (const c of takers.sort(this.byDistanceTo(fall))) if (this.connect(fall, c)) break;
    }
  }

  /**
   * Cords — the hyphae throws grow from parent to child — are kept: they keep the
   * network connected, so nutrients flow out to the frontier where throwing
   * happens, and a colony whose falls run dry drains its store forward instead of
   * sitting stranded. (Cutting every cord once a child fed itself left islands.)
   * The one cord worth cutting is one that makes a colony overspend: shrinking and
   * nearly empty, it would soon run dry and die. Then it drops a cord to a child
   * that has a fall of its own and doesn't need it.
   */
  cutCordsWhenOverspending(): void {
    const fedByFall = new Set<number>();
    for (const p of this.world.pipes.values()) {
      if (p.owner === this.player && this.world.nodes.get(p.from)?.kind === "fall") fedByFall.add(p.to);
    }
    for (const colony of this.mine) {
      if (!this.canAct()) return;
      if (colony.rate >= 0 || colony.nutrients > 60) continue;
      for (const p of this.world.pipes.values()) {
        const child = this.world.nodes.get(p.to);
        if (p.owner !== this.player || p.from !== colony.id || child?.owner !== this.player) continue;
        if (!fedByFall.has(child.id)) continue;
        this.act({ type: "cut", player: this.player, pipe: p.id });
        break;
      }
    }
  }

  /**
   * A colony cut off from the network — no hypha of ours touching it — has a
   * store nobody can use. Link it to the nearest colony of ours that sits closer
   * to the front, so its nutrients go where the fighting is.
   */
  reconnectStranded(): void {
    const linked = new Set<number>();
    for (const p of this.world.pipes.values()) {
      if (p.owner !== this.player) continue;
      const a = this.world.nodes.get(p.from);
      const b = this.world.nodes.get(p.to);
      if (a?.owner === this.player && b?.owner === this.player) {
        linked.add(a.id);
        linked.add(b.id);
      }
    }
    if (this.mine.length < 2) return;
    for (const n of this.mine) {
      if (!this.canAct()) return;
      if (linked.has(n.id) || n.nutrients < 40) continue;
      const here = this.frontDistance(n);
      const toward = this.mine
        .filter((m) => m !== n && this.frontDistance(m) <= here)
        .sort(this.byDistanceTo(n));
      for (const m of toward) if (this.connect(n, m)) break;
    }
  }

  /**
   * An enemy colony that could latch onto one of ours, and is stronger than it,
   * gets walled off: a crossbar across the line between them blocks new
   * connections either way. A colony that is the stronger one doesn't wall — the
   * wall would block its own attack just the same.
   */
  wallOffThreats(): void {
    for (const colony of this.mine) {
      if (!this.canAct()) return;
      // Only colonies worth protecting: walls cost, and each one also blocks our own lines.
      if (colony.nutrients < 150 || this.world.wallCount(colony.id) >= MAX_WALLS_PER_COLONY) continue;
      for (const threat of this.enemyColonies) {
        if (threat.nutrients <= colony.nutrients) continue;
        const d = dist(colony.x, colony.y, threat.x, threat.y);
        if (d > this.world.reachOf(threat) || this.joined.has(pairKey(colony.id, threat.id))) continue;
        if (!this.world.hasLineOfSight(colony, threat)) continue; // already blocked
        const along = Math.min(this.world.reachOf(colony) * 0.8, d * 0.4);
        const spot = { x: colony.x + ((threat.x - colony.x) / d) * along, y: colony.y + ((threat.y - colony.y) / d) * along };
        if (this.world.canBuildWall(this.player, colony.id, spot).ok) {
          this.act({ type: "wall", player: this.player, from: colony.id, ...spot });
          break;
        }
      }
    }
  }

  /**
   * Drain the enemy — focus fire: its weakest colonies first, and several of ours
   * on the same victim, so kills finish. Other rivals are only drained when much
   * weaker. A hunter needs enough to out-pull what the victim can be fed.
   */
  attack(): void {
    const rivals = this.nodes.filter((n) => n.kind === "colony" && n.owner != null && n.owner !== this.player);
    const prey = rivals
      .map((r) => ({ r, bias: r.owner === this.enemy ? 0.5 : 1 }))
      .sort((a, b) => a.r.nutrients * a.bias - b.r.nutrients * b.bias);
    for (const hunter of [...this.mine].sort((a, b) => b.nutrients - a.nutrients)) {
      if (!this.canAct() || hunter.nutrients < 150) return;
      for (const { r } of prey) {
        const worth = r.owner === this.enemy ? r.nutrients < hunter.nutrients * 1.5 : r.nutrients < hunter.nutrients * 0.8;
        if (worth && this.connect(r, hunter)) break;
      }
    }
  }

  /**
   * Move nutrients to the front. A rich colony well back from the enemy, with a
   * slot to spare, feeds a colony of ours closer to it; and a line of ours that
   * carries nutrients away from the front — to a colony that feeds itself from a
   * fall — is reversed to flow toward it instead.
   */
  supplyTheFront(): void {
    if (this.enemyColonies.length === 0) return;
    const fedByFall = new Set<number>();
    for (const p of this.world.pipes.values()) {
      if (p.owner === this.player && this.world.nodes.get(p.from)?.kind === "fall") fedByFall.add(p.to);
    }
    for (const p of this.world.pipes.values()) {
      if (!this.canAct()) return;
      if (p.owner !== this.player) continue;
      const src = this.world.nodes.get(p.from);
      const dst = this.world.nodes.get(p.to);
      if (src?.owner !== this.player || dst?.owner !== this.player || !fedByFall.has(dst.id)) continue;
      if (this.frontDistance(dst) > this.frontDistance(src) + 100 && this.world.canReverse(this.player, p.id).ok) {
        this.act({ type: "reverse", player: this.player, pipe: p.id });
      }
    }
    for (const n of [...this.mine].sort((a, b) => b.nutrients - a.nutrients)) {
      if (!this.canAct() || n.nutrients < 300) return;
      if (this.world.ownOutCount(n.id) >= this.world.outputCap(n.id)) continue;
      const here = this.frontDistance(n);
      const toward = this.mine
        .filter((m) => m !== n && this.frontDistance(m) < here - 150)
        .sort((a, b) => this.frontDistance(a) - this.frontDistance(b));
      for (const m of toward) if (this.connect(n, m)) break;
    }
  }

  /**
   * Throw one colony toward the most valuable target we can't reach yet: food
   * (big pools, close by) or a weaker rival colony to land within draining range
   * of. Targets are tried best-first — when the best is walled off by terrain, a
   * wall, a hypha or rival territory, the next is tried, so exploration never
   * freezes on one unreachable fall. Each target gets angled throws too.
   */
  expand(): void {
    if (!this.canAct() || this.mine.length >= MAX_COLONIES) return;
    // A throw grows a hypha from the thrower, so it needs a free output slot. Kept
    // cords fill interior hubs' slots, so the throwers are whoever has one free —
    // usually the frontier. (Picking the nearest rich colony regardless stalled
    // expansion entirely once hubs filled up.)
    const throwers = this.mine.filter(
      (c) => c.nutrients >= 80 && this.world.ownOutCount(c.id) < this.world.outputCap(c.id),
    );
    if (throwers.length === 0) return;
    const nearest = (t: GameNode) =>
      throwers.reduce((a, b) => (dist(a.x, a.y, t.x, t.y) <= dist(b.x, b.y, t.x, t.y) ? a : b));

    type Target = { at: GameNode; from: GameNode; score: number };
    const food: Target[] = [];
    const foes: Target[] = [];
    for (const fall of this.falls) {
      if (fall.nutrients < 40) continue;
      if (this.mine.some((c) => this.joined.has(pairKey(fall.id, c.id)))) continue;
      const from = nearest(fall);
      food.push({ at: fall, from, score: fall.nutrients / (dist(from.x, from.y, fall.x, fall.y) + 300) });
    }
    // Boosts are worth a long trip: they break stalemates, and they come back.
    for (const boost of [...this.neutralBoosts, ...this.rivalBoosts]) {
      if (this.mine.some((c) => this.joined.has(pairKey(boost.id, c.id)))) continue;
      const from = nearest(boost);
      food.push({ at: boost, from, score: 2500 / (dist(from.x, from.y, boost.x, boost.y) + 300) });
    }
    for (const rival of this.nodes) {
      if (rival.kind !== "colony" || rival.owner == null || rival.owner === this.player) continue;
      const from = nearest(rival);
      const edge = from.nutrients - rival.nutrients; // how much stronger we are there
      if (edge <= 0) continue;
      // Bring the fight to the enemy: its colonies weigh far more than anyone else's.
      const weight = rival.owner === this.enemy ? 6 : 2;
      foes.push({ at: rival, from, score: (edge * weight) / (dist(from.x, from.y, rival.x, rival.y) + 300) });
    }
    // Separate shortlists, tried in turn: walled-off rivals must never crowd food
    // out of consideration (a single ranked list stalled every bot once the
    // enemies nearby were all behind walls, with food still all over the map).
    const best = (list: Target[]) => list.sort((a, b) => b.score - a.score).slice(0, 5);
    const topFoes = best(foes);
    const topFood = best(food);
    const targets: Target[] = [];
    for (let i = 0; i < 5; i++) {
      if (topFoes[i]) targets.push(topFoes[i]);
      if (topFood[i]) targets.push(topFood[i]);
    }

    for (const { at, from } of targets) {
      const d = dist(from.x, from.y, at.x, at.y);
      // A throw has to make progress: land nearer the target than any colony we
      // already have. Otherwise, while the last child is too poor to throw on, its
      // parent keeps throwing siblings to the same spot — rows of parallel lines.
      const closest = Math.min(...this.mine.map((c) => dist(c.x, c.y, at.x, at.y)));
      const reach = this.world.reachOf(from);
      // Land just short of it, or as far as this colony can throw.
      const step = Math.min(reach * 0.9, Math.max(NODE_SPACING * 3, d - this.world.radiusOf(at) - NODE_SPACING * 2));
      const heading = Math.atan2(at.y - from.y, at.x - from.x);
      for (const length of THROW_LENGTHS) {
        const reachFromSpot = dist(from.x, from.y, at.x, at.y) - step * length;
        if (length < 1 && reachFromSpot > reach) break; // too short to reach it from there
        for (const turn of THROW_ANGLES) {
          const spot: Vec = {
            x: from.x + Math.cos(heading + turn) * step * length,
            y: from.y + Math.sin(heading + turn) * step * length,
          };
          if (dist(spot.x, spot.y, at.x, at.y) > closest - NODE_SPACING * 3) continue;
          if (!this.world.canEject(this.player, from.id, spot).ok) continue;
          // Going for a rival colony: land only where it can actually be latched
          // onto — in sight past terrain, walls and hyphae. This is how a bot goes
          // round a wall instead of landing uselessly behind it.
          if (at.kind === "colony" && !(this.world.hasLineOfSight(spot, at) && !this.world.crossesHypha(spot, at))) continue;
          this.act({ type: "eject", player: this.player, from: from.id, ...spot });
          return;
        }
      }
    }
  }
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
