import { PIPE_RATE_PER_SEC } from "../../config";
import { dist } from "../geometry";
import type { GameNode } from "../types";
import type { Board } from "./board";
import { COLONY, LINE, seconds, type Category, type Memory, type Posture } from "./core";
import { BoostHold, Expedition, HarvestLoop, SeverPlan, Siege, type Destination } from "./tasks";

const RATE = PIPE_RATE_PER_SEC;

/**
 * Strategy (bot-design.md): the bot's posture — a state machine driven by its
 * live stats — and which multi-step tasks to start.
 *
 *   opening     → the first minute, a handful of colonies: eat and spread.
 *   expand      → the default: gather, reach new ground, take boosts.
 *   consolidate → too much of the network starving or in pieces: repair first.
 *   war         → rivals in reach and we're not the weaker: press them.
 *   defend      → being drained: answer it before anything else.
 *
 * A posture holds for at least a few seconds (defend can always cut in), so the
 * bot doesn't flicker between plans.
 */
export const WEIGHTS: Record<Posture, Record<Category, number>> = {
  opening:     { economy: 1.3, network: 0.8, expand: 1.2, fight: 0.5, defend: 1.2, boost: 0.9 },
  expand:      { economy: 1.0, network: 1.0, expand: 1.0, fight: 0.8, defend: 1.2, boost: 1.1 },
  consolidate: { economy: 1.1, network: 1.4, expand: 0.75, fight: 0.8, defend: 1.3, boost: 0.9 },
  war:         { economy: 1.0, network: 1.0, expand: 0.9, fight: 1.3, defend: 1.3, boost: 1.0 },
  defend:      { economy: 1.0, network: 1.1, expand: 0.75, fight: 1.1, defend: 1.6, boost: 1.0 },
};

const HOLD_SECONDS = 8;
/** Stranded pieces travelling at once. Each idle one left out just sits there. */
const MAX_REGROUPS = 8;

export function choosePosture(board: Board, memory: Memory): Posture {
  const s = board.stats;
  const count = board.mine.length;
  let next: Posture;
  // Defend when the drains on us matter against the size of the network: they
  // take more than half of what we gather, or hit a real share of our colonies.
  if (s.drainOnMe > Math.max(RATE * 2, s.income * 0.5) || s.drainedColonies > Math.max(2, count * 0.2)) next = "defend";
  else if (board.tick < seconds(60) && count <= 4) next = "opening";
  else if (s.starving > count * 0.3 || board.pieces.size > Math.max(2, count / 4)) next = "consolidate";
  // War only with a real edge: rivals in reach and clearly more to fight with.
  // How big an edge it takes is temperament (profile.ts): easy never goes to war.
  else if (s.preyInReach > 0 && s.store >= s.localEnemyStore * board.profile.warEdge) next = "war";
  else next = "expand";
  const held = board.tick - memory.postureSince < seconds(HOLD_SECONDS);
  if (next !== memory.posture && (!held || next === "defend")) {
    memory.posture = next;
    memory.postureSince = board.tick;
  }
  return memory.posture;
}

/** Start the tasks the situation calls for; tasks end themselves when done. */
export function planTasks(board: Board, memory: Memory): void {
  memory.tasks = memory.tasks.filter((t) => !t.done);
  const has = (key: string) => memory.tasks.some((t) => t.key === key) || memory.gaveUp.has(key);
  const count = (prefix: string) => memory.tasks.filter((t) => t.key.startsWith(prefix)).length;

  // Defend: every line draining us, cut — wall first — if we hold Sever.
  if (board.holds("sever")) {
    for (const a of board.attacks) {
      const key = `sever:${a.pipe.id}`;
      if (has(key) || board.holds("chitin", a.pipe.owner)) continue;
      memory.tasks.push(new SeverPlan(a.pipe.id, () => board.stake(a.victim, a.rate), "draining us", board.tick, [`pipe:${a.pipe.id}`]));
    }
  }

  // Harvest loops round the falls we draw on, while Harvest makes them pay.
  if (board.holds("harvest")) {
    const falls = board.falls.filter((f) => board.tapping(f)).sort((a, b) => a.nutrients - b.nutrients);
    for (const f of falls) {
      if (count("loop:") >= 3) break;
      if (!has(`loop:${f.id}`)) memory.tasks.push(new HarvestLoop(f.id, board.tick));
    }
  }

  // Boosts: every one we hold, and the best neutral ones.
  for (const b of board.myBoosts) if (!has(`boost:${b.id}`)) memory.tasks.push(new BoostHold(b.id, board.tick));
  const neutral = board.boosts
    .filter((b) => b.owner == null && b.boost)
    .map((b) => ({ b, score: board.boostWorth(b.boost!) / (1 + nearest(board.mine, b) / 1000) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 2);
  for (const { b } of neutral) if (!has(`boost:${b.id}`)) memory.tasks.push(new BoostHold(b.id, board.tick));

  // Siege: bring rival colonies down. In war, two at once; otherwise one, so a
  // network that's busy defending still finishes what it can (endless matches
  // came from bots that only ever traded drains). Whoever is draining us first,
  // then the one that dies soonest. Easy never goes to war, and never sieges.
  const sieges = memory.posture === "war" ? 2 : Number.isFinite(board.profile.warEdge) ? 1 : 0;
  if (count("siege:") < sieges) {
    const attackers = new Set(board.attacks.map((a) => a.attacker.id));
    const prey = board.rivals
      .filter((v) => v.kind === "colony" && board.reaching(v).length > 0 && !has(`siege:${v.id}`))
      .sort((a, b) => Number(attackers.has(b.id)) - Number(attackers.has(a.id)) || a.nutrients - b.nutrients)[0];
    if (prey) memory.tasks.push(new Siege(prey.id, board.tick));
  }

  // A stranded piece with nothing coming in is a small expedition of its own: it
  // heads for the nearest food it can find — growth, not a walk home — and only
  // goes back to the main network when there's no food near it.
  const main = board.pieces.get(board.mainPiece) ?? [];
  for (const [id, piece] of board.pieces) {
    if (id === board.mainPiece || main.length === 0) continue;
    const gathering = piece.some((c) => (board.info.get(c.id)?.income ?? 0) > 0);
    const store = piece.reduce((t, c) => t + c.nutrients, 0);
    if (gathering || store < COLONY * 0.3) continue; // an outpost that feeds itself is fine
    const reachable = piece.some((a) => main.some((b) => board.inReach(a, b) || board.inReach(b, a)));
    if (reachable) continue; // relink will join them
    if (memory.tasks.some((t) => t instanceof Expedition && t.to.kind === "regroup" && t.to.piece === id)) continue;
    const food = board.falls
      .filter((f) => f.nutrients >= 60 && !board.tapping(f) && nearest(piece, f) < 2000)
      .sort((a, b) => nearest(piece, a) / Math.min(a.nutrients, LINE) - nearest(piece, b) / Math.min(b.nutrients, LINE))[0];
    const home = main.reduce((best, c) => (nearest(piece, c) < nearest(piece, best) ? c : best));
    const to: Destination = {
      kind: "regroup", node: food ?? home, piece: id,
      worth: (food ? Math.min(board.tapValue(food), LINE) : 0) + store * 0.3 + COLONY * 0.3 * piece.length,
    };
    const e = new Expedition(to, board.tick);
    if (!has(e.key) && count("expedition:regroup") < MAX_REGROUPS) memory.tasks.push(e);
  }

  // Expeditions: travel to the best destinations out of reach.
  const limit = memory.posture === "expand" || memory.posture === "opening" ? 2 : 1;
  const travelling = memory.tasks.filter((t) => t instanceof Expedition && t.to.kind !== "regroup").length;
  if (travelling < limit) {
    for (const d of destinations(board)) {
      if (memory.tasks.filter((t) => t instanceof Expedition && t.to.kind !== "regroup").length >= limit) break;
      const e = new Expedition(d, board.tick);
      if (!has(e.key)) memory.tasks.push(e);
    }
  }
}

/**
 * Places worth travelling to that no colony of ours reaches yet, best first by
 * worth over walking distance: groups of falls, boosts, weaker rival colonies.
 */
function destinations(board: Board): Destination[] {
  const out: { d: Destination; score: number }[] = [];
  const uncovered = board.falls.filter((f) => f.nutrients >= 60 && !board.mine.some((c) => board.inReach(c, f)));
  const taken = new Set<number>();
  for (const f of [...uncovered].sort((a, b) => b.nutrients - a.nutrients)) {
    if (taken.has(f.id)) continue;
    let worth = 0;
    for (const g of uncovered) {
      if (taken.has(g.id) || dist(f.x, f.y, g.x, g.y) > 300) continue;
      taken.add(g.id);
      worth += Math.min(board.tapValue(g), LINE);
    }
    out.push({ d: { kind: "food", node: f, worth }, score: worth });
  }
  for (const b of board.boosts) {
    if (!b.boost || b.owner === board.me || board.mine.some((c) => board.inReach(c, b))) continue;
    const worth = board.boostWorth(b.boost) * (b.owner == null ? 1 : 0.6);
    out.push({ d: { kind: "boost", node: b, worth }, score: worth * 1.2 });
  }
  for (const v of board.rivals) {
    if (v.kind !== "colony" || board.mine.some((c) => board.inReach(c, v))) continue;
    const worth = board.drainValue(v) * 0.6;
    out.push({ d: { kind: "prey", node: v, worth }, score: worth * (board.memory.posture === "war" ? 1.3 : 0.7) });
  }
  // Walking maps cost a search each: rank by straight distance first, and only
  // walk the few best.
  return out
    .map((o) => ({ ...o, score: o.score / (1 + nearest(board.mine, o.d.node) / 1200) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((o) => ({ ...o, score: o.score * (1 + nearest(board.mine, o.d.node) / 1200) / (1 + walk(board, o.d.node) / 1200) }))
    .filter((o) => Number.isFinite(o.score) && o.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((o) => o.d);
}

/** Walking distance from our nearest colony to a node, round the terrain. */
function walk(board: Board, n: GameNode): number {
  const field = board.nav.field(`node:${n.id}`, n);
  let best = Infinity;
  for (const c of board.mine) best = Math.min(best, board.nav.distance(field, c));
  return best;
}

function nearest(list: GameNode[], p: GameNode): number {
  let best = Infinity;
  for (const c of list) best = Math.min(best, dist(c.x, c.y, p.x, p.y));
  return best;
}
