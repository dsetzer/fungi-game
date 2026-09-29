export type PlayerId = number;
export type EntityId = number;

export interface Player {
  id: PlayerId;
  name: string;
  color: string;
  isBot: boolean;
  alive: boolean;
  /** Nutrients drawn into this player's network from outside it — leaderboard rank. */
  score: number;
  /** Activated boosts' timers (§6.7), as sim ticks. */
  abilities: Abilities;
}

export interface Abilities {
  /** Flow doubles this player's hyphae until this tick. */
  flowUntil: number;
  /** First tick Flow may be fired again. */
  flowReadyAt: number;
  /** First tick Sever may cut again. */
  severReadyAt: number;
}

export type NodeKind = "colony" | "fall" | "boost";

/**
 * Boosts (§6.7): capture points drawn like falls. Branch, Reach and Vision are
 * passive while held; Flow and Sever are abilities the holder fires.
 */
export type BoostKind = "branch" | "reach" | "vision" | "flow" | "sever";
export const BOOST_KINDS: readonly BoostKind[] = ["branch", "reach", "vision", "sever", "flow"];

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
  /** Which boost this is; only set on boost nodes. */
  boost?: BoostKind;
}

export interface Pipe {
  id: EntityId;
  from: EntityId;
  to: EntityId;
  /** Player who grew this hypha. */
  owner: PlayerId;
}

/**
 * A player-built wall (§6.5): a stem from the anchor colony out to a crossbar.
 * Only the crossbar (a → b) blocks line of sight; the stem is just a tether.
 */
export interface Barrier {
  id: EntityId;
  owner: PlayerId;
  anchor: EntityId;
  /** Crossbar centre (end of the stem). */
  x: number;
  y: number;
  a: { x: number; y: number };
  b: { x: number; y: number };
}

/** Terrain: one circle of a circle-cluster arena wall (§4). */
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
  /** `fraction` is the share of the parent's store the throw carries (§6.1). */
  | { type: "eject"; player: PlayerId; from: EntityId; x: number; y: number; fraction?: number }
  | { type: "connect"; player: PlayerId; from: EntityId; to: EntityId }
  | { type: "cut"; player: PlayerId; pipe: EntityId }
  | { type: "reverse"; player: PlayerId; pipe: EntityId }
  | { type: "wall"; player: PlayerId; from: EntityId; x: number; y: number }
  | { type: "demolish"; player: PlayerId; wall: EntityId }
  /** Fire Flow: every hypha of yours carries double for a while (§6.7). */
  | { type: "flow"; player: PlayerId }
  /** Sever: cut any hypha on the map, whoever grew it (§6.7). */
  | { type: "sever"; player: PlayerId; pipe: EntityId };

export type CheckResult = { ok: true } | { ok: false; reason: string };
