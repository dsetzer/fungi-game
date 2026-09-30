import { FLOW_MULTIPLIER, FLOW_SECONDS, PIPE_RATE_PER_SEC, UPKEEP_PER_SEC, WALL_COST } from "../../config";
import { dist } from "../geometry";
import type { EntityId, GameNode } from "../types";
import type { Board } from "./board";
import { COLONY, HORIZON, LINE, THROW_DELAY, pairKey, seconds, type Candidate } from "./core";

const RATE = PIPE_RATE_PER_SEC;

/**
 * Reflexes (bot-design.md): the moves a bot considers on every look, whatever
 * its plans — gathering, keeping the network whole and fed, answering attacks,
 * fighting what's in reach. Tasks carry the multi-step plans; these keep the
 * network healthy between them.
 */
export function reflexes(board: Board): Candidate[] {
  const out: Candidate[] = [];
  const push = (c: Candidate | null) => {
    if (c) out.push(c);
  };
  tap(board, push);
  drainRivals(board, push);
  stripBoosts(board, push);
  supply(board, push);
  reverse(board, push);
  rings(board, push);
  relink(board, push);
  saveHubs(board, push);
  walls(board, push);
  flow(board, push);
  nearThrows(board, push);
  return out;
}

type Push = (c: Candidate | null) => void;

// ---------- economy ----------

/** Every fall in reach and not yet drawn on by us, into the colony that needs it most. */
function tap(board: Board, push: Push): void {
  for (const f of board.falls) {
    if (f.nutrients < 5 || board.tapping(f)) continue;
    const takers = board.reaching(f)
      .sort((a, b) => board.info.get(b.id)!.need - board.info.get(a.id)!.need)
      .slice(0, 3);
    const value = board.tapValue(f);
    for (const c of takers) push(board.connect(value + board.rescueBonus(c), f, c, "economy", `tap ${f.id}`));
  }
}

// ---------- fighting ----------

/**
 * Drain rival colonies in reach, the richest hunters first. A drain on a colony
 * that is draining us also answers the attack — and one hypha per pair means it
 * can never drain that colony of ours back. Joining a funnel already on a victim
 * is worth more: the lines add up to a kill.
 */
function drainRivals(board: Board, push: Push): void {
  for (const v of board.rivals) {
    if (v.kind !== "colony") continue;
    let value = board.drainValue(v) * 0.8;
    if (board.myDrains.has(v.id)) value += COLONY * 0.2;
    for (const a of board.attacks) if (a.attacker.id === v.id) value += board.stake(a.victim, a.rate) * 0.6;
    const hunters = board.reaching(v).sort((a, b) => b.nutrients - a.nutrients).slice(0, 3);
    const category = board.attacks.some((a) => a.attacker.id === v.id) ? "defend" : "fight";
    for (const h of hunters) push(board.connect(value, v, h, category, `drain ${v.id}`));
  }
}

/** Drain a rival's boost: it's food, and draining it dry takes the boost from them. */
function stripBoosts(board: Board, push: Push): void {
  for (const b of board.rivalBoosts) {
    if (!b.boost) continue;
    const value = board.tapValue(b) + board.boostWorth(b.boost) * 0.5;
    for (const c of board.reaching(b).slice(0, 2)) push(board.connect(value, b, c, "boost", `strip boost ${b.id}`));
  }
}

// ---------- the network ----------

/** Can this colony send a line's worth without starting to shrink or running dry? */
function affords(board: Board, c: GameNode): boolean {
  const i = board.info.get(c.id)!;
  return i.rate - RATE >= 0 || c.nutrients > COLONY * 2;
}

/** Supply lines: a colony with a surplus feeds a needier one it can reach. */
function supply(board: Board, push: Push): void {
  for (const r of board.mine) {
    const ri = board.info.get(r.id)!;
    if (ri.need > 0 || !affords(board, r) || !board.hasSlot(r)) continue;
    for (const f of board.mine) {
      if (f === r) continue;
      const fi = board.info.get(f.id)!;
      if (fi.need < 2 || fi.need <= ri.need || !board.inReach(r, f)) continue;
      const moved = Math.min(Math.max(r.nutrients - f.nutrients, COLONY) / 2, LINE);
      push(board.connect((moved * 0.4 + board.rescueBonus(f)) * (fi.need / 3), r, f, "network", `supply ${f.id}`));
    }
  }
}

/**
 * A line of ours flowing from a needy colony into a comfortable one gets flipped
 * — but only if the comfortable end can afford to become the source (flipped, it
 * loses what it was getting and sends it instead: twice the line rate worse
 * off), and not a line flipped in the last minute, or the two ends' needs
 * swap and it flips straight back.
 */
function reverse(board: Board, push: Push): void {
  for (const i of board.info.values()) {
    for (const p of i.feedsColonies) {
      const to = board.info.get(p.to);
      if (!to || i.need - to.need < 3 || to.need > 0 || board.memory.recentFlips.has(p.id)) continue;
      if (to.rate - RATE * 2 < 0 && to.node.nutrients < COLONY * 2) continue;
      push({
        value: LINE * 0.25 + board.rescueBonus(i.node), category: "network", why: `reverse ${p.id}`,
        cmd: { type: "reverse", player: board.me, pipe: p.id },
        valid: () => board.world.canReverse(board.me, p.id).ok,
        onChosen: () => board.memory.recentFlips.set(p.id, board.tick + seconds(60)),
      });
    }
  }
}

/**
 * Rings (§6.6). A colony whose inflow covers what it sends is sustained and pays
 * no upkeep, so a chain closed into a cycle idles for free and doesn't collapse
 * into its tip when its food runs out. For a colony of ours paying upkeep, close
 * the cycle: a line back to it from a colony its own lines already lead to.
 */
function rings(board: Board, push: Push): void {
  for (const i of board.info.values()) {
    if (i.sustained || i.feedsColonies.length === 0 || i.income > 0) continue;
    const c = i.node;
    const depth = new Map<EntityId, number>([[c.id, 0]]);
    const queue = [c.id];
    while (queue.length > 0) {
      const at = queue.shift()!;
      const d = depth.get(at)!;
      if (d >= 6) continue;
      for (const p of board.info.get(at)?.feedsColonies ?? []) {
        if (depth.has(p.to)) continue;
        depth.set(p.to, d + 1);
        queue.push(p.to);
        const y = board.world.nodes.get(p.to)!;
        if (d + 1 < 2 || !board.hasSlot(y) || !board.inReach(y, c)) continue;
        const length = d + 2;
        push(board.connect(UPKEEP_PER_SEC * HORIZON * length + COLONY * 0.3 + board.rescueBonus(c), y, c, "network", `ring ${c.id}`));
      }
    }
  }
}

/**
 * One network, not scattered pieces. A piece split off from the main one is
 * linked back wherever a colony of each is in reach, fed from whichever side can
 * afford it. (A piece out of reach travels back instead — see strategy.)
 */
function relink(board: Board, push: Push): void {
  if (board.pieces.size < 2) return;
  const main = board.pieces.get(board.mainPiece) ?? [];
  for (const [id, piece] of board.pieces) {
    if (id === board.mainPiece) continue;
    const store = piece.reduce((t, c) => t + c.nutrients, 0);
    const value = store * 0.3 + COLONY * 0.3 * piece.length;
    const pairs: [GameNode, GameNode][] = [];
    for (const a of piece) {
      for (const b of main) {
        if (board.memory.recentCuts.has(pairKey(a.id, b.id))) continue;
        if (board.inReach(a, b) || board.inReach(b, a)) pairs.push([a, b]);
      }
    }
    pairs.sort(([a, b], [c, d]) => dist(a.x, a.y, b.x, b.y) - dist(c.x, c.y, d.x, d.y));
    for (const [a, b] of pairs.slice(0, 4)) {
      for (const [from, to] of [[b, a], [a, b]] as const) {
        if (!board.hasSlot(from) || !affords(board, from)) continue;
        push(board.connect(value, from, to, "network", `relink piece ${id}`));
      }
    }
  }
}

/**
 * Save gathering hubs from their own throws. A throw's cord drains its parent at
 * the line rate; a hub whose food can't cover that is cut free of the child once
 * it has landed (the child keeps what it carried). Cords out of relays and tips
 * are left alone: that's the chain moving forward. Never a cut just because a
 * colony is shrinking — that only strands islands.
 */
function saveHubs(board: Board, push: Push): void {
  for (const i of board.info.values()) {
    if (i.income <= 0 || i.rate >= 0 || i.lasts > HORIZON) continue;
    const cords = [...i.feedsColonies].sort((a, b) => b.id - a.id); // newest first
    for (const p of cords) {
      const child = board.info.get(p.to);
      if (!child || child.need >= 2) continue;
      const pair = pairKey(p.from, p.to);
      push({
        value: COLONY + i.node.nutrients * 0.2, category: "network", why: `save hub ${i.node.id}`,
        cmd: { type: "cut", player: board.me, pipe: p.id },
        valid: () => board.world.pipes.has(p.id),
        onChosen: () => board.memory.recentCuts.set(pair, board.tick + seconds(60)),
      });
      break;
    }
  }
}

// ---------- walls ----------

/**
 * Walls where a rival colony can reach a colony of ours worth keeping that
 * can't reach back (where it can, draining is the better answer), and across
 * the line from a rival colony to a fall we depend on.
 */
function walls(board: Board, push: Push): void {
  for (const i of board.info.values()) {
    const x = i.node;
    const valuable = x.nutrients >= COLONY || i.income > 0;
    if (!valuable || !board.canWallFrom(x)) continue;
    for (const a of board.rivals) {
      if (a.kind !== "colony" || board.joined.has(pairKey(x.id, a.id))) continue;
      const d = dist(x.x, x.y, a.x, a.y);
      if (d > board.world.reachOf(a) || d <= board.world.reachOf(x)) continue;
      if (!board.world.hasLineOfSight(x, a) || board.world.crossesHypha(x, a)) continue;
      const rate = board.rateOnMe(a.owner!);
      const value = (Math.min(x.nutrients, rate * HORIZON) + i.income * HORIZON * 0.3) * 0.5 - WALL_COST;
      const wall = board.wallAcross(x, a);
      if (wall) push(wallCandidate(board, value, wall, `wall off ${a.id}`));
    }
  }
  for (const f of board.falls) {
    if (!board.tapping(f) || f.nutrients < 100) continue;
    for (const a of board.rivals) {
      if (a.kind !== "colony" || board.joined.has(pairKey(f.id, a.id))) continue;
      if (dist(f.x, f.y, a.x, a.y) > board.world.reachOf(a)) continue;
      if (!board.world.hasLineOfSight(f, a) || board.world.crossesHypha(f, a)) continue;
      const wall = board.wallAcross(f, a);
      if (wall) push(wallCandidate(board, Math.min(f.nutrients, LINE) * 0.4 - WALL_COST, wall, `guard fall ${f.id}`));
    }
  }
}

function wallCandidate(board: Board, value: number, wall: Candidate["cmd"], why: string): Candidate {
  return {
    value, cmd: wall, category: "defend", why,
    valid: () => wall.type === "wall" && board.world.canBuildWall(board.me, wall.from, wall).ok,
  };
}

// ---------- abilities ----------

/**
 * Flow doubles every hypha of ours for a while: worth what the doubling carries
 * meanwhile. Never fired when a colony of ours that's already shrinking would run
 * dry while its deficit is doubled.
 */
function flow(board: Board, push: Push): void {
  if (!board.world.canFlow(board.me).ok) return;
  for (const i of board.info.values()) {
    if (i.rate < 0 && i.node.nutrients < -i.rate * FLOW_MULTIPLIER * FLOW_SECONDS) return;
  }
  let extra = 0;
  for (const i of board.info.values()) extra += i.income;
  for (const d of board.myDrains.values()) extra += d.rate;
  const value = extra * (FLOW_MULTIPLIER - 1) * FLOW_SECONDS - COLONY * 0.2;
  push({
    value, category: "fight", why: "flow",
    cmd: { type: "flow", player: board.me },
    valid: () => board.world.canFlow(board.me).ok,
  });
}

// ---------- local expansion ----------

/**
 * Throws that bring food, boosts or prey into reach from where they land —
 * expansion close to home, alongside the longer expeditions. Worth what they
 * bring in, shared over the actions it takes to collect it.
 */
function nearThrows(board: Board, push: Push): void {
  const food = [...board.falls, ...board.boosts.filter((b) => b.owner !== board.me)]
    .filter((f) => f.nutrients >= 30 && !board.mine.some((c) => board.inReach(c, f)));
  const worth = new Map(food.map((f) => [f.id, f.kind === "boost" && f.boost ? board.boostWorth(f.boost) : board.tapValue(f)]));
  const prey = board.rivals.filter((v) => v.kind === "colony");
  for (const parent of board.mine) {
    // Only what a throw from here could possibly bring into reach.
    const range = board.world.reachOf(parent) + board.childReach(board.world.ejectAmount(parent));
    const nearFood = food.filter((f) => dist(parent.x, parent.y, f.x, f.y) <= range);
    const nearPrey = prey.filter((v) => dist(parent.x, parent.y, v.x, v.y) <= range);
    if (nearFood.length === 0 && nearPrey.length === 0) continue;
    const cost = board.throwCost(parent);
    for (const { spot, childReach } of board.throwSpots(parent)) {
      const gains: number[] = [];
      for (const f of nearFood) if (dist(spot.x, spot.y, f.x, f.y) <= childReach) gains.push(worth.get(f.id)!);
      for (const v of nearPrey) if (dist(spot.x, spot.y, v.x, v.y) <= childReach) gains.push(board.drainValue(v) * 0.5);
      if (gains.length === 0) continue;
      gains.sort((a, b) => b - a);
      const best = gains.slice(0, 3);
      const value = (best.reduce((t, g) => t + g, 0) / (best.length + 1)) * THROW_DELAY - cost;
      push(board.eject(value, parent, spot, "expand", `near throw from ${parent.id}`));
    }
  }
}
