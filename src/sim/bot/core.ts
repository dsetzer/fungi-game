import { PIPE_RATE_PER_SEC, SIM_HZ } from "../../config";
import { dist, makeRng } from "../geometry";
import type { BoostKind, Command, EntityId, PlayerId } from "../types";
import type { World } from "../world";

/**
 * The shared vocabulary of the bot (bot-design.md): the price scale every move is
 * measured on, what a candidate move is, and what a bot remembers between looks.
 */

// ---------- the price scale ----------

/** Seconds of consequence a move is priced over. */
export const HORIZON = 60;
/** One hypha running for the horizon: the unit everything else is measured in. */
export const LINE = PIPE_RATE_PER_SEC * HORIZON;
/**
 * One colony of ours, worth just by existing — its reach, its ground, its place
 * in the network. On the same scale as a tap or an attack, so keeping colonies
 * alive and connected competes with them for the bot's hands.
 */
export const COLONY = LINE * 0.5;
/** A rival colony removed: its income gone, its ground and food opened up. */
export const KILL = COLONY;
/** What a nutrient taken from a rival is worth on top of the nutrient itself. */
export const ENEMY_LOSS = 0.4;
/** Nothing below this is worth spending an action on. */
export const MIN_VALUE = 15;
/** A throw's gains only pay once more actions follow it; a tap pays at once. */
export const THROW_DELAY = 0.6;
/** Holding each boost, as a share of LINE, before situational adjustment. */
export const BOOST_BASE: Record<BoostKind, number> = {
  branch: 0.8, reach: 1.0, vision: 0.3, harvest: 1.5, siphon: 1.0,
  rind: 0.8, chitin: 0.4, flow: 0.9, sever: 1.0,
};

export const seconds = (s: number) => Math.round(s * SIM_HZ);

export function pairKey(a: EntityId, b: EntityId): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// ---------- candidates ----------

/**
 * What a move serves, so the bot's posture can weigh it: gathering, keeping the
 * network whole, reaching new ground, fighting, defending, boosts.
 */
export type Category = "economy" | "network" | "expand" | "fight" | "defend" | "boost";

export interface Candidate {
  value: number;
  cmd: Command;
  category: Category;
  /** The full rule check — run only on candidates near the top of the list. */
  valid: () => boolean;
  /** Short reason, for debugging and tests. */
  why: string;
  /** Runs when this candidate is the one acted on (e.g. remember a cut). */
  onChosen?: () => void;
  /**
   * What this move responds to — `node:<id>` for a rival node in contact,
   * `pipe:<id>` for a rival line draining us. It may only be made once the bot
   * has had its reaction time since each of them appeared (profile.ts).
   */
  reactsTo?: string[];
}

// ---------- memory ----------

export type Posture = "opening" | "expand" | "consolidate" | "war" | "defend";

/** A persistent multi-step plan: a small state machine the bot advances each look. */
export interface Task {
  /** Identifies the task, so the same one isn't started twice. */
  readonly key: string;
  state: string;
  readonly started: number;
  done: boolean;
  /** Advance the state machine against the board, and propose this state's moves. */
  step(board: import("./board").Board, memory: Memory): Candidate[];
}

/** What one bot remembers between looks. Kept per world, so a new match starts fresh. */
export interface Memory {
  /** Tick of the last action taken. */
  lastAction: number;
  /** Ticks after `lastAction` before the next one — re-rolled after every action. */
  gap: number;
  /** The bot's own dice, so its timing never disturbs the world's random stream. */
  rng: () => number;
  /** Tick of the last evacuation (reflexes.ts) — they're rationed. */
  evacuatedAt: number;
  /** Colonies emptied and left to wither, until this tick: nothing feeds them. */
  abandoned: Map<EntityId, number>;
  posture: Posture;
  postureSince: number;
  tasks: Task[];
  /** Task keys given up on, until this tick — no point trying again at once. */
  gaveUp: Map<string, number>;
  /** Pairs we cut on purpose, until this tick — don't link them straight back. */
  recentCuts: Map<string, number>;
  /** Each colony's net rate, smoothed over the last second or so. */
  rateEma: Map<EntityId, number>;
  /** Last tick the memory was refreshed. */
  observed: number;
  /**
   * When each thing the bot must react to first appeared: a rival node coming
   * into contact (`node:<id>`), a rival line starting to drain us (`pipe:<id>`).
   * Dropped when contact ends, so a fresh contact needs a fresh reaction.
   */
  noticed: Map<string, number>;
}

const memories = new WeakMap<World, Map<PlayerId, Memory>>();

export function memoryOf(world: World, player: PlayerId): Memory {
  let byPlayer = memories.get(world);
  if (!byPlayer) {
    byPlayer = new Map();
    memories.set(world, byPlayer);
  }
  let m = byPlayer.get(player);
  if (!m) {
    m = {
      lastAction: -Infinity,
      gap: 0,
      rng: makeRng(Math.imul(player + 1, 0x9e3779b1) ^ world.tick),
      evacuatedAt: -Infinity,
      abandoned: new Map(),
      posture: "opening",
      postureSince: world.tick,
      tasks: [],
      gaveUp: new Map(),
      recentCuts: new Map(),
      rateEma: new Map(),
      observed: -1,
      noticed: new Map(),
    };
    byPlayer.set(player, m);
  }
  return m;
}

/**
 * Real-time tracking, every look whether or not the hands are free: each colony's
 * rate is smoothed so one noisy tick doesn't read as a colony dying, and expired
 * entries are dropped.
 */
export function observe(world: World, player: PlayerId, memory: Memory): void {
  if (memory.observed === world.tick) return;
  memory.observed = world.tick;
  const seen = new Set<EntityId>();
  for (const n of world.nodes.values()) {
    if (n.owner !== player) continue;
    seen.add(n.id);
    const was = memory.rateEma.get(n.id);
    memory.rateEma.set(n.id, was === undefined ? n.rate : was * 0.6 + n.rate * 0.4);
  }
  for (const id of memory.rateEma.keys()) if (!seen.has(id)) memory.rateEma.delete(id);
  for (const [k, until] of memory.gaveUp) if (until <= world.tick) memory.gaveUp.delete(k);
  for (const [k, until] of memory.recentCuts) if (until <= world.tick) memory.recentCuts.delete(k);
  notice(world, player, memory);
}

/** How close, beyond whichever side reaches further, counts as contact. */
const CONTACT_MARGIN = 100;

/**
 * Stimuli the bot reacts to (profile.ts, Reaction): a rival colony or boost
 * coming within reach of one of ours, or one of ours within its reach — the
 * moment either side could act on the other — and a rival line draining one of
 * ours. Each is stamped the first look it's there and forgotten when it goes.
 */
function notice(world: World, player: PlayerId, memory: Memory): void {
  const mine = [...world.nodes.values()].filter((n) => n.owner === player && n.kind === "colony");
  const present = new Set<string>();
  for (const v of world.nodes.values()) {
    if (v.owner == null || v.owner === player || v.kind === "fall") continue;
    const reachV = world.reachOf(v);
    const inContact = mine.some((c) => dist(c.x, c.y, v.x, v.y) <= Math.max(world.reachOf(c), reachV) + CONTACT_MARGIN);
    if (inContact) present.add(`node:${v.id}`);
  }
  for (const p of world.pipes.values()) {
    if (p.owner !== player && world.nodes.get(p.from)?.owner === player) present.add(`pipe:${p.id}`);
  }
  for (const k of present) if (!memory.noticed.has(k)) memory.noticed.set(k, world.tick);
  for (const k of memory.noticed.keys()) if (!present.has(k)) memory.noticed.delete(k);
}
