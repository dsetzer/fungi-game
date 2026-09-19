// All gameplay tuning lives here. Values are first-pass guesses — see design doc §9.
// Economy rates are per SECOND (the design's "1 nutrient per tick" means a 1 s tick);
// the sim itself steps faster so commands and flow feel responsive.

export const SIM_HZ = 10; // sim steps per second
export const TICK_MS = 1000 / SIM_HZ;
export const DT = 1 / SIM_HZ; // seconds per sim step

// §5 Node economy
export const START_NUTRIENTS = 100;
export const UPKEEP_PER_SEC = 1;
export const EJECT_BUFFER = 30; // nutrients moved from parent into a newly ejected node
export const EJECT_MIN_PARENT_REMAINING = 10; // parent must keep at least this after ejecting

// §6.2 Pipelines
export const PIPE_RATE_PER_SEC = 3; // nutrients per second along one hypha
// Only outgoing hyphae are capped; a colony can take in any number (funnelling,
// reinforcement). Falls are uncapped.
export const MAX_OUT_PIPES_PER_COLONY = 4;

// §6.5 Walls — stem from a colony to a crossbar; the crossbar blocks line of sight
export const WALL_BAR_LENGTH = 80;
export const WALL_COST = 15; // one-off, paid by the anchor colony
export const MAX_WALLS_PER_COLONY = 3;
export const WALLS_CUT_EXISTING_PIPES = true; // a new crossbar severs hyphae crossing it

// §6.4 Nutrient falls — spawned as clusters of blobs, biggest in the middle
export const NEUTRAL_FALL_CLUSTERS = 5; // in addition to one cluster per spawn
export const FALL_CLUSTER_BLOBS_MIN = 4;
export const FALL_CLUSTER_BLOBS_MAX = 8;
export const FALL_CLUSTER_SPREAD = 90; // max blob distance from cluster centre
export const FALL_POOL_CENTER = 900; // pool of a blob at the cluster centre
export const FALL_POOL_EDGE = 120; // pool of a blob at the cluster's outer edge
export const SPAWN_CLUSTER_DISTANCE = 220; // spawn → its cluster centre (just beyond start reach)
export const FALLS_PAY_UPKEEP = false; // open design question

// §4 Arena
export const ARENA_RADIUS = 1400;
export const INTERIOR_CLUSTERS = 9;

// Match
export const PLAYER_COUNT = 4; // player 1 is human, the rest are bots
export const BOT_THINK_SECONDS = 1;
export const ROUND_RESTART_DELAY_MS = 4000;

// Nodes are points: a fixed-size core dot (used for hit-testing and spacing).
export const NODE_CORE_RADIUS = 7;
export const NODE_SPACING = 22; // min clearance between a new node and existing cores

// Visual only: the fluid "aura" around each core grows with stored nutrients.
// Auras of the same owner merge into one contiguous shape (metaballs).
// Almost no fixed base, so a nearly-empty node visibly shrinks back toward its dot
// (16 → ~16, fresh eject 30 → ~21, start 100 → ~36, 400 → ~69).
export function colonyAura(nutrients: number): number {
  return 3 + Math.sqrt(Math.max(0, nutrients)) * 3.3;
}

export function fallAura(nutrients: number): number {
  return 2 + Math.sqrt(Math.max(0, nutrients)) * 1.9;
}

export function reach(nutrients: number): number {
  return 80 + Math.sqrt(Math.max(0, nutrients)) * 9;
}
