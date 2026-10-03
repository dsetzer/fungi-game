import { BOOST_POOL, FLOW_MULTIPLIER, FLOW_SECONDS, HARVEST_MULTIPLIER, PIPE_RATE_PER_SEC } from "../../config";
import { dist } from "../geometry";
import type { EntityId, GameNode } from "../types";
import type { Board } from "./board";
import {
  COLONY,
  HORIZON,
  LINE,
  THROW_DELAY,
  pairKey,
  seconds,
  type Candidate,
  type Memory,
  type Task,
} from "./core";

const RATE = PIPE_RATE_PER_SEC;

/**
 * Tasks (bot-design.md): plans that take several actions and several looks to
 * carry out, each a small state machine the bot advances every time it looks.
 * A task proposes the moves its current state calls for; the bot weighs them
 * against everything else it could do, so a task never locks the bot's hands.
 */

// ---------------------------------------------------------------------------
// Expedition: travel to a target round the terrain.
// ---------------------------------------------------------------------------

export type Destination =
  | { kind: "food"; node: GameNode; worth: number }
  | { kind: "boost"; node: GameNode; worth: number }
  | { kind: "prey"; node: GameNode; worth: number }
  /** A stranded piece heading back to the main network. */
  | { kind: "regroup"; node: GameNode; worth: number; piece: number };

/** Give up on a destination the network hasn't got any closer to in this long. */
const STALL_SECONDS = 45;
/** …and leave it alone for this long before trying again. */
const GIVE_UP_SECONDS = 120;

/**
 * Throws toward a destination, valued by how much of the *walk* round the
 * terrain each one saves (the nav grid), not by straight-line distance.
 *
 * States: travel → (in reach) arrived. Stalls — no colony of ours any closer
 * for a while — end it and put the destination on the give-up list, so a bot
 * never sits throwing at a wall.
 */
export class Expedition implements Task {
  readonly key: string;
  state = "travel";
  done = false;
  readonly started: number;
  private best = Infinity;
  private bestAt: number;

  constructor(readonly to: Destination, tick: number) {
    // Per piece for a regroup: several stranded pieces may head for the same place.
    this.key = to.kind === "regroup" ? `expedition:regroup:${to.piece}:${to.node.id}` : `expedition:${to.kind}:${to.node.id}`;
    this.started = tick;
    this.bestAt = tick;
  }

  step(board: Board, memory: Memory): Candidate[] {
    const target = board.world.nodes.get(this.to.node.id);
    if (!target || (this.to.kind === "boost" && target.owner === board.me) || (this.to.kind !== "boost" && this.to.kind !== "regroup" && target.owner === board.me)) {
      this.done = true;
      return [];
    }
    const field = board.nav.field(`node:${target.id}`, target);
    // Who counts as travelling: the whole network, or just the stranded piece.
    const party = this.to.kind === "regroup" ? board.pieces.get(this.to.piece) ?? [] : board.mine;
    if (party.length === 0) {
      this.done = true;
      return [];
    }
    let lead: GameNode | null = null;
    let leadD = Infinity;
    for (const c of party) {
      const d = board.nav.distance(field, c);
      if (d < leadD) {
        leadD = d;
        lead = c;
      }
    }
    if (lead && board.inReach(lead, target)) {
      this.state = "arrived";
      this.done = true;
      return [];
    }
    if (leadD < this.best - 30) {
      this.best = leadD;
      this.bestAt = board.tick;
    } else if (board.tick - this.bestAt > seconds(STALL_SECONDS) || !Number.isFinite(leadD)) {
      memory.gaveUp.set(this.key, board.tick + seconds(GIVE_UP_SECONDS));
      this.done = true;
      return [];
    }
    if (lead) board.leads.add(lead.id);

    // Throw from the front: colonies not far behind the lead along the walk (the
    // lead's own ways out may all be fenced off by our hyphae).
    const out: Candidate[] = [];
    for (const parent of party) {
      const dParent = board.nav.distance(field, parent);
      if (!Number.isFinite(dParent) || dParent > leadD + 1500) continue;
      const cost = board.throwCost(parent);
      for (const { spot, childReach } of board.throwSpots(parent)) {
        const dSpot = board.nav.distance(field, spot);
        const progress = dParent - dSpot;
        if (!(progress > 20)) continue;
        const arrives = dist(spot.x, spot.y, target.x, target.y) <= childReach && dSpot < childReach * 1.5;
        const remaining = Math.max(1, dParent - childReach * 0.8);
        const share = arrives ? 1 : Math.min(1, progress / remaining);
        const value = this.to.worth * share * THROW_DELAY - cost;
        out.push(board.eject(value, parent, spot, this.to.kind === "regroup" ? "network" : "expand", `${this.key} ${Math.round(share * 100)}%`));
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Sever plan: wall first, then sever.
// ---------------------------------------------------------------------------

/**
 * Sever used correctly: a cut line is only gone for good if its ends can't see
 * each other — otherwise its owner simply latches on again while Sever recharges.
 *
 * States: wall (build a crossbar across the line) → sever (its ends are now
 * blind to each other: cut it) → done. If the wall comes down, back to wall.
 * Abandoned if the line goes, we lose Sever, or no wall can be placed in time.
 */
export class SeverPlan implements Task {
  readonly key: string;
  state = "wall";
  done = false;
  readonly started: number;
  private wallTries = 0;

  constructor(
    readonly pipeId: EntityId,
    readonly stake: () => number,
    readonly why: string,
    tick: number,
    /** What the plan responds to (Candidate.reactsTo): it waits out the bot's reaction time. */
    readonly reactsTo: string[] = [],
  ) {
    this.key = `sever:${pipeId}`;
    this.started = tick;
  }

  step(board: Board, memory: Memory): Candidate[] {
    const pipe = board.world.pipes.get(this.pipeId);
    if (!pipe || !board.holds("sever") || board.holds("chitin", pipe.owner)) {
      this.done = true;
      return [];
    }
    const a = board.world.nodes.get(pipe.from)!;
    const b = board.world.nodes.get(pipe.to)!;
    const blind = !board.world.hasLineOfSight(a, b);
    this.state = blind ? "sever" : "wall";
    const stake = this.stake();
    if (this.state === "wall") {
      const wall = board.wallAcross(a, b);
      if (!wall) {
        if (++this.wallTries > 12) {
          memory.gaveUp.set(this.key, board.tick + seconds(30));
          this.done = true;
        }
        return [];
      }
      return [{
        value: stake * 0.9, cmd: wall, category: "defend", why: `${this.key} wall (${this.why})`, reactsTo: this.reactsTo,
        valid: () => wall.type === "wall" && board.world.canBuildWall(board.me, wall.from, wall).ok,
      }];
    }
    if (!board.world.canSever(board.me, pipe.id).ok) return []; // recharging: wait, the wall holds
    return [{
      value: stake + COLONY * 0.3, category: "defend", why: `${this.key} sever (${this.why})`, reactsTo: this.reactsTo,
      cmd: { type: "sever", player: board.me, pipe: pipe.id },
      valid: () => board.world.canSever(board.me, pipe.id).ok && !board.world.hasLineOfSight(a, b),
      onChosen: () => {
        this.done = true;
      },
    }];
  }
}

// ---------------------------------------------------------------------------
// Harvest loop: fall → C → D → fall.
// ---------------------------------------------------------------------------

/**
 * A sustain loop (§6.4), which only pays while we hold Harvest: fall → C → D →
 * fall. The pool holds and C nets the Harvest surplus forever.
 *
 * States: link (make sure C feeds some D that reaches the fall) → close (D feeds
 * the fall) → hold (watch it; rebuild if a line goes). Ends when the fall is
 * gone or Harvest is lost.
 */
export class HarvestLoop implements Task {
  readonly key: string;
  state = "link";
  done = false;
  readonly started: number;

  constructor(readonly fallId: EntityId, tick: number) {
    this.key = `loop:${fallId}`;
    this.started = tick;
  }

  step(board: Board): Candidate[] {
    const fall = board.world.nodes.get(this.fallId);
    if (!fall || !board.holds("harvest")) {
      this.done = true;
      return [];
    }
    const into = [...board.world.pipes.values()].find((p) => p.from === fall.id && p.owner === board.me);
    const c = into && board.world.nodes.get(into.to);
    if (!c || c.owner !== board.me || c.kind !== "colony") {
      this.done = true; // we no longer draw on it
      return [];
    }
    const loopValue = (HARVEST_MULTIPLIER - 1) * RATE * HORIZON + (fall.nutrients < LINE ? COLONY * 0.3 : 0);
    // D: a colony C feeds that can reach the fall.
    const ds = board.info.get(c.id)!.feedsColonies
      .map((p) => board.world.nodes.get(p.to)!)
      .filter((d) => d && board.inReach(d, fall));
    const closed = ds.find((d) => board.joined.has(pairKey(d.id, fall.id)));
    if (closed) {
      this.state = "hold";
      return [];
    }
    if (ds.length > 0) {
      this.state = "close";
      const out: Candidate[] = [];
      for (const d of ds) {
        if (!board.hasSlot(d)) continue;
        const cand = board.connect(loopValue, d, fall, "economy", `${this.key} close`);
        if (cand) out.push(cand);
      }
      return out;
    }
    this.state = "link";
    if (!board.hasSlot(c)) return [];
    const out: Candidate[] = [];
    for (const d of board.mine) {
      if (d === c || !board.inReach(d, fall) || !board.inReach(c, d) || !board.hasSlot(d)) continue;
      const cand = board.connect(loopValue * 0.6, c, d, "economy", `${this.key} link`);
      if (cand) out.push(cand);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Boost hold: capture, keep fed, recycle.
// ---------------------------------------------------------------------------

/**
 * One boost, from neutral to held (§6.7).
 *
 * States: capture (feed it from a colony in reach; out of reach, an expedition
 * travels to it) → hold (keep a line feeding it — a fed boost pays no upkeep —
 * and recycle a large surplus back into the network). Ends if a rival takes it
 * first, or it dies.
 */
export class BoostHold implements Task {
  readonly key: string;
  state = "capture";
  done = false;
  readonly started: number;

  constructor(readonly boostId: EntityId, tick: number) {
    this.key = `boost:${boostId}`;
    this.started = tick;
  }

  step(board: Board): Candidate[] {
    const b = board.world.nodes.get(this.boostId);
    if (!b || !b.boost || (b.owner != null && b.owner !== board.me)) {
      this.done = true;
      return [];
    }
    const worth = board.boostWorth(b.boost);
    const out: Candidate[] = [];
    if (b.owner == null) {
      this.state = "capture";
      // One tick of feeding captures it, so even a poor colony can.
      for (const c of board.reaching(b)) {
        if (c.nutrients < 30 || !board.hasSlot(c)) continue;
        const cand = board.connect(worth, c, b, "boost", `${this.key} capture`);
        if (cand) out.push(cand);
      }
      return out;
    }
    this.state = "hold";
    const feeds = (board.feedsInto.get(b.id) ?? []).filter((p) => p.owner === board.me);
    if (feeds.length === 0 && b.nutrients < BOOST_POOL * 0.75) {
      for (const c of board.reaching(b)) {
        const i = board.info.get(c.id)!;
        const affords = i.rate >= 0 || c.nutrients > COLONY * 2;
        if (!affords || !board.hasSlot(c)) continue;
        const cand = board.connect(worth * 0.6, c, b, "boost", `${this.key} feed`);
        if (cand) out.push(cand);
      }
    }
    const recycling = [...board.world.pipes.values()].some((p) => p.from === b.id && p.owner === board.me);
    if (!recycling && b.nutrients > BOOST_POOL * 2 && board.hasSlot(b)) {
      for (const c of board.reaching(b)) {
        if (feeds.some((p) => p.from === c.id)) continue; // one hypha per pair
        const cand = board.connect(board.tapValue(b) * 0.5, b, c, "boost", `${this.key} recycle`);
        if (cand) out.push(cand);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Siege: funnel drains onto one rival colony and finish it.
// ---------------------------------------------------------------------------

const SIEGE_STALL_SECONDS = 90;
/** A victim dying slower than this is surrounded further: another colony thrown in to latch on. */
const SIEGE_KILL_SECONDS = 30;

/**
 * Bring down one rival colony (§6.3). Every hypha runs at the same rate, so a
 * kill takes more lines on the victim than its owner feeds it — and the way to
 * get them is to surround it: latch on, wall the latch, throw the next one.
 *
 * States: funnel (add drains from every colony of ours in reach; while it
 * isn't dying fast, throw another colony in to latch on, into the widest gap
 * in the ring round it; wall each latched colony off from the victim's
 * neighbours, who'd drain it back; plan Sever — wall first — on lines feeding
 * it) → finish (fire Flow if that ends it inside Flow's window). Ends when it
 * dies, or when it stops shrinking for too long.
 */
export class Siege implements Task {
  readonly key: string;
  state = "funnel";
  done = false;
  readonly started: number;
  private low = Infinity;
  private lowAt: number;

  constructor(readonly victimId: EntityId, tick: number) {
    this.key = `siege:${victimId}`;
    this.started = tick;
    this.lowAt = tick;
  }

  step(board: Board, memory: Memory): Candidate[] {
    const v = board.world.nodes.get(this.victimId);
    if (!v || v.owner === board.me || v.owner == null) {
      this.done = true;
      return [];
    }
    if (v.nutrients < this.low - 5) {
      this.low = v.nutrients;
      this.lowAt = board.tick;
    } else if (board.tick - this.lowAt > seconds(SIEGE_STALL_SECONDS)) {
      memory.gaveUp.set(this.key, board.tick + seconds(60));
      this.done = true;
      return [];
    }
    const out: Candidate[] = [];
    const shrinking = v.rate < -RATE * 0.5;
    this.state = shrinking ? "finish" : "funnel";
    // More lines on it, from every colony of ours that can reach.
    const lineValue = board.drainValue(v) * board.profile.drainBias + COLONY * 0.3;
    for (const h of board.reaching(v)) {
      const cand = board.connect(lineValue, v, h, "fight", `${this.key} funnel`);
      if (cand) out.push({ ...cand, reactsTo: [`node:${v.id}`] });
    }
    // Our colonies latched on, and the angles round the victim they hold.
    const latched = [...board.world.pipes.values()]
      .filter((p) => p.from === v.id && p.owner === board.me)
      .map((p) => board.world.nodes.get(p.to))
      .filter((c): c is GameNode => !!c && c.owner === board.me);
    const dying = v.rate < 0 && v.nutrients / -v.rate < SIEGE_KILL_SECONDS;
    if (!dying) out.push(...this.surround(board, v, latched, lineValue));
    // Its reinforcements: sever them, wall first.
    if (board.holds("sever")) {
      for (const p of board.feedsInto.get(v.id) ?? []) {
        if (p.owner !== v.owner) continue;
        const key = `sever:${p.id}`;
        if (memory.tasks.some((t) => t.key === key) || memory.gaveUp.has(key)) continue;
        memory.tasks.push(new SeverPlan(p.id, () => LINE * 0.5, "reinforcing a siege", board.tick, [`node:${v.id}`]));
      }
    }
    // Finish it with Flow when doubling our lines ends it inside the window.
    if (this.state === "finish" && board.world.canFlow(board.me).ok) {
      const ours = board.myDrains.get(v.id)?.rate ?? 0;
      const withFlow = v.rate - ours * (FLOW_MULTIPLIER - 1);
      if (withFlow < 0 && v.nutrients / -withFlow < FLOW_SECONDS) {
        out.push({
          value: COLONY + v.nutrients * 0.5, category: "fight", why: `${this.key} flow to finish`,
          cmd: { type: "flow", player: board.me },
          valid: () => board.world.canFlow(board.me).ok,
          reactsTo: [`node:${v.id}`],
        });
      }
    }
    return out;
  }

  /**
   * Throw the next colony in: to a spot that can latch onto the victim, in the
   * widest gap left in the ring of colonies already on it — so the ring closes
   * round it rather than piling up on one side. Spots a rival other than the
   * victim could drain are worth less.
   */
  private surround(board: Board, v: GameNode, latched: GameNode[], lineValue: number): Candidate[] {
    const angles = latched.map((c) => Math.atan2(c.y - v.y, c.x - v.x));
    const gap = (a: number) => {
      let best = Math.PI;
      for (const b of angles) best = Math.min(best, Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))));
      return best; // 0 (on top of one) … π (opposite all of them)
    };
    const others = board.rivals.filter((r) => r.kind === "colony" && r.id !== v.id);
    const out: Candidate[] = [];
    for (const parent of board.mine) {
      if (dist(parent.x, parent.y, v.x, v.y) > board.world.reachOf(parent) * 2) continue;
      const cost = board.throwCost(parent);
      for (const { spot, childReach } of board.throwSpots(parent)) {
        if (dist(spot.x, spot.y, v.x, v.y) > childReach * 0.9) continue;
        if (!board.world.hasLineOfSight(spot, v)) continue;
        const exposed = others.some((r) => dist(r.x, r.y, spot.x, spot.y) <= board.world.reachOf(r));
        const spread = latched.length === 0 ? 1 : gap(Math.atan2(spot.y - v.y, spot.x - v.x)) / Math.PI;
        const value = lineValue * (0.5 + 0.5 * spread) * (exposed ? 0.6 : 1) * THROW_DELAY - cost;
        out.push({ ...board.eject(value, parent, spot, "fight", `${this.key} surround`), reactsTo: [`node:${v.id}`] });
      }
    }
    return out;
  }
}


