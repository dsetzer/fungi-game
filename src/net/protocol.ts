import type { StatsDTO } from "../sim/stats";
import type { BoostKind, Command, EntityId, PlayerId } from "../sim/types";

/**
 * Wire format between client and server. Terrain is never sent — the client
 * regenerates the identical arena from the round's seed, player count and radius.
 * Snapshots carry only what the receiving player is allowed to see (fog of war),
 * so hidden state never reaches the client at all.
 */

export const PROTOCOL_VERSION = 2;

export interface RoundInfo {
  seed: number;
  /** Player count and radius the arena was generated with. */
  arenaPlayers: number;
  radius: number;
  /** Seconds left in the round, at the moment the message was sent. */
  endsIn: number;
  intermission: boolean;
}

export interface PlayerDTO {
  id: PlayerId;
  name: string;
  color: string;
  score: number;
  /** Nutrients held right now (the leaderboard). */
  h: number;
  alive: boolean;
  /** Activated boosts' timers, as sim ticks (compare with the snapshot's tick). */
  fu: number;
  fr: number;
  sr: number;
}

/** Short keys: these go out ten times a second, per player. */
export interface NodeDTO {
  i: EntityId;
  /** 0 = colony, 1 = nutrient fall, 2 = boost */
  k: 0 | 1 | 2;
  /** Which boost, on boosts only. */
  b?: BoostKind;
  o: PlayerId | null;
  x: number;
  y: number;
  /** nutrients */
  n: number;
  /** net nutrients per second */
  r: number;
  /** stable wobble seed */
  s: number;
}

export interface PipeDTO {
  i: EntityId;
  f: EntityId;
  t: EntityId;
  o: PlayerId;
}

export interface BarrierDTO {
  i: EntityId;
  o: PlayerId;
  a: EntityId;
  x: number;
  y: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface Snapshot {
  t: "snap";
  tick: number;
  endsIn: number;
  /** Players actually connected right now (the leaderboard also lists ones who left). */
  online: number;
  nodes: NodeDTO[];
  pipes: PipeDTO[];
  barriers: BarrierDTO[];
  players: PlayerDTO[];
}

export type ServerMsg =
  /** `you` is 0 for a spectator: no player has that id. */
  | { t: "welcome"; version: number; you: PlayerId; round: RoundInfo; players: PlayerDTO[] }
  /** `you` is your player id in the new round (0 for a spectator); absent at round end. */
  | { t: "round"; round: RoundInfo; players: PlayerDTO[]; winner: PlayerDTO | null; you?: PlayerId }
  /** Back in after a respawn request, as a new player. */
  | { t: "spawned"; you: PlayerId }
  | Snapshot
  /**
   * Match stats (sim/stats.ts), once a second: a player gets only their own — a
   * rival's live numbers would see through the fog — a spectator gets everyone's,
   * and at round end everyone gets everyone's. Each carries just the history the
   * member hasn't had yet.
   */
  | { t: "stats"; stats: StatsDTO[] }
  | { t: "error"; message: string };

export type ClientMsg =
  /** spectate: watch the whole arena without a colony; commands are ignored. */
  | { t: "hello"; name: string; version: number; spectate?: boolean }
  | { t: "cmd"; cmd: Command }
  /** Wiped out: play again, in the round that's running. */
  | { t: "respawn" };

export function encode(msg: ServerMsg | ClientMsg): string {
  return JSON.stringify(msg);
}

export function decode<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
