import { SIM_HZ } from "../config";
import type { PlayerId } from "./types";

/**
 * Match statistics: running tallies per player, plus a once-a-second history for
 * the graphs. The World keeps them as it steps; online, the server sends them on
 * (each player their own, spectators everyone's, everyone everyone's at round end).
 */

/** What the history samples. Flows are running totals; the charts turn them into rates. */
export const SERIES = ["held", "colonies", "gathered", "drained", "lost", "spent"] as const;
export type Series = (typeof SERIES)[number];
export type History = { time: number[] } & Record<Series, number[]>;

export interface StatTotals {
  /** Drawn in from falls and neutral boosts. */
  gathered: number;
  /** Drawn in from rivals' nodes. */
  drained: number;
  /** Drawn out of ours by rivals. */
  lost: number;
  /** Paid in upkeep by nodes not sustained. */
  upkeep: number;
  /** Paid for walls. */
  walls: number;
  throws: number;
  hyphae: number;
  wallsBuilt: number;
  boosts: number;
  /** Rival colonies that died while we were draining them. */
  kills: number;
  coloniesLost: number;
  /** Times wiped out (online respawns, so it can be more than one). */
  deaths: number;
  peakColonies: number;
  peakHeld: number;
  /** Tick of the last wipe-out, or null. */
  diedAt: number | null;
}

export interface PlayerStats extends StatTotals {
  /** One sample a second while the player has colonies; `time` is seconds into the match. */
  history: History;
}

export function newStats(): PlayerStats {
  return {
    gathered: 0, drained: 0, lost: 0, upkeep: 0, walls: 0,
    throws: 0, hyphae: 0, wallsBuilt: 0, boosts: 0, kills: 0, coloniesLost: 0, deaths: 0,
    peakColonies: 0, peakHeld: 0, diedAt: null,
    history: emptyHistory(),
  };
}

export function emptyHistory(): History {
  return { time: [], held: [], colonies: [], gathered: [], drained: [], lost: [], spent: [] };
}

/** Appends one sample of a player's state at `tick`. */
export function sample(s: PlayerStats, tick: number, held: number, colonies: number): void {
  const h = s.history;
  h.time.push(tick / SIM_HZ);
  h.held.push(held);
  h.colonies.push(colonies);
  h.gathered.push(s.gathered);
  h.drained.push(s.drained);
  h.lost.push(s.lost);
  h.spent.push(s.upkeep + s.walls);
  s.peakColonies = Math.max(s.peakColonies, colonies);
  s.peakHeld = Math.max(s.peakHeld, held);
}

// ---------- wire format ----------

/** A player's totals and the history samples from index `from` on. */
export interface StatsDTO extends StatTotals {
  id: PlayerId;
  from: number;
  history: History;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function toStatsDTO(id: PlayerId, s: PlayerStats, from: number): StatsDTO {
  const history = emptyHistory();
  for (const k of ["time", ...SERIES] as const) history[k] = s.history[k].slice(from).map(r1);
  return {
    ...s, id, from, history,
    gathered: r1(s.gathered), drained: r1(s.drained), lost: r1(s.lost), upkeep: r1(s.upkeep), peakHeld: r1(s.peakHeld),
  };
}

/** Merges a DTO into the client's copy: totals replaced, history spliced in at `from`. */
export function mergeStats(into: Map<PlayerId, PlayerStats>, dto: StatsDTO): void {
  const s = into.get(dto.id) ?? newStats();
  const { id: _id, from, history, ...totals } = dto;
  Object.assign(s, totals);
  for (const k of ["time", ...SERIES] as const) {
    s.history[k].length = Math.min(s.history[k].length, from);
    s.history[k].push(...history[k]);
  }
  into.set(dto.id, s);
}
