import { MAX_OUT_PIPES_PER_COLONY, NODE_SPACING } from "../config";
import { dist, type Vec } from "./geometry";
import type { Command, GameNode, PlayerId } from "./types";
import type { World } from "./world";

/**
 * Computer players. Every bot has the same goal as a human — gather the most —
 * and the same brain: tap every fall it can reach, expand toward food it can't,
 * defend what it has and drain weaker rivals. Difficulty is only how fast it may
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

  const mine = [...world.nodes.values()].filter((n) => n.owner === player);
  if (mine.length > 0 && actions >= 1) {
    const bot = new Brain(world, player, mine, () => actions >= 1, (cmd) => {
      world.enqueue(cmd);
      actions -= 1;
    });
    // Most urgent first; each step stops looking once the actions run out.
    bot.defend();
    bot.rescueStarving();
    bot.tapFalls();
    bot.cutCordsWhenOverspending();
    bot.attack();
    bot.expand();
  }
  bank.set(player, actions);
}

class Brain {
  private readonly nodes: GameNode[];
  private readonly falls: GameNode[];
  /** Pairs already joined by a hypha (either direction) or given one this turn. */
  private readonly joined = new Set<string>();

  constructor(
    private world: World,
    private player: PlayerId,
    private mine: GameNode[],
    private canAct: () => boolean,
    private act: (cmd: Command) => void,
  ) {
    this.nodes = [...world.nodes.values()];
    this.falls = this.nodes.filter((n) => n.kind === "fall");
    for (const p of world.pipes.values()) this.joined.add(pairKey(p.from, p.to));
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

  /** Drain the weakest rival colony a stronger colony of ours can reach. */
  attack(): void {
    const rivals = this.nodes.filter((n) => n.kind === "colony" && n.owner != null && n.owner !== this.player);
    for (const hunter of [...this.mine].sort((a, b) => b.nutrients - a.nutrients)) {
      if (!this.canAct() || hunter.nutrients < 150) return;
      const prey = rivals.filter((r) => r.nutrients < hunter.nutrients * 0.8).sort((a, b) => a.nutrients - b.nutrients);
      for (const r of prey) if (this.connect(r, hunter)) return;
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
      (c) => c.nutrients >= 80 && this.world.ownOutCount(c.id) < MAX_OUT_PIPES_PER_COLONY,
    );
    if (throwers.length === 0) return;
    const nearest = (t: GameNode) =>
      throwers.reduce((a, b) => (dist(a.x, a.y, t.x, t.y) <= dist(b.x, b.y, t.x, t.y) ? a : b));

    const targets: { at: GameNode; from: GameNode; score: number }[] = [];
    for (const fall of this.falls) {
      if (fall.nutrients < 40) continue;
      if (this.mine.some((c) => this.joined.has(pairKey(fall.id, c.id)))) continue;
      const from = nearest(fall);
      targets.push({ at: fall, from, score: fall.nutrients / (dist(from.x, from.y, fall.x, fall.y) + 300) });
    }
    for (const rival of this.nodes) {
      if (rival.kind !== "colony" || rival.owner == null || rival.owner === this.player) continue;
      const from = nearest(rival);
      const edge = from.nutrients - rival.nutrients; // how much stronger we are there
      if (edge <= 0) continue;
      targets.push({ at: rival, from, score: (edge * 2) / (dist(from.x, from.y, rival.x, rival.y) + 300) });
    }
    targets.sort((a, b) => b.score - a.score);

    for (const { at, from } of targets.slice(0, 8)) {
      const d = dist(from.x, from.y, at.x, at.y);
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
          if (this.world.canEject(this.player, from.id, spot).ok) {
            this.act({ type: "eject", player: this.player, from: from.id, ...spot });
            return;
          }
        }
      }
    }
  }
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
