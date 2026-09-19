export type PlayerId = number;
export type EntityId = number;

export interface Player {
  id: PlayerId;
  name: string;
  color: string;
  isBot: boolean;
  alive: boolean;
}

export type NodeKind = "colony" | "fall";

export interface GameNode {
  id: EntityId;
  kind: NodeKind;
  /** null for neutral nutrient falls */
  owner: PlayerId | null;
  x: number;
  y: number;
  nutrients: number;
  /** Net nutrient change per second as of the last step (for "time until death" UI). */
  rate: number;
  /** Stable per-node value for cosmetic variation (blob shape). */
  seed: number;
}

export interface Pipe {
  id: EntityId;
  from: EntityId;
  to: EntityId;
  /** Player who grew this hypha. */
  owner: PlayerId;
}

export interface Wall {
  x: number;
  y: number;
  r: number;
}

/**
 * Everything a player can do goes through a Command. Locally these come from
 * input; later they're what the client sends to an authoritative server.
 */
export type Command =
  | { type: "eject"; player: PlayerId; from: EntityId; x: number; y: number }
  | { type: "connect"; player: PlayerId; from: EntityId; to: EntityId }
  | { type: "cut"; player: PlayerId; pipe: EntityId };

export type CheckResult = { ok: true } | { ok: false; reason: string };
