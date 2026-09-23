import type { Command, EntityId, PlayerId } from "../sim/types";

/**
 * Wire format between client and server. Terrain is never sent — the client
 * regenerates the identical arena from the round's seed, player count and radius.
 * Snapshots carry only what the receiving player is allowed to see (fog of war),
 * so hidden state never reaches the client at all.
 */

export const PROTOCOL_VERSION = 1;

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
  alive: boolean;
}

/** Short keys: these go out ten times a second, per player. */
export interface NodeDTO {
  i: EntityId;
  /** 0 = colony, 1 = nutrient fall */
  k: 0 | 1;
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
  | { t: "welcome"; version: number; you: PlayerId; round: RoundInfo; players: PlayerDTO[] }
  | { t: "round"; round: RoundInfo; players: PlayerDTO[]; winner: PlayerDTO | null }
  | Snapshot
  | { t: "error"; message: string };

export type ClientMsg =
  | { t: "hello"; name: string; version: number }
  | { t: "cmd"; cmd: Command };

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
