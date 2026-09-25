// All gameplay tuning lives here. Values are first-pass guesses — see design doc §9.
// Economy rates are per SECOND (the design's "1 nutrient per tick" means a 1 s tick);
// the sim itself steps faster so commands and flow feel responsive.

export const SIM_HZ = 10; // sim steps per second
export const TICK_MS = 1000 / SIM_HZ;
export const DT = 1 / SIM_HZ; // seconds per sim step

// §5 Node economy
export const START_NUTRIENTS = 100;
export const UPKEEP_PER_SEC = 1;
/**
 * Ejecting carries a share of the parent's store rather than a flat amount, so a
 * rich colony throws a strong child that can immediately throw again — chained
 * expansion across the map, instead of stalling on a 30-nutrient stub with no
 * reach. Adjustable per throw with the wheel while dragging (§6.1).
 */
export const EJECT_FRACTION_DEFAULT = 0.5;
export const EJECT_FRACTION_MIN = 0.15;
export const EJECT_FRACTION_MAX = 0.9;
export const EJECT_MIN_AMOUNT = 25; // a throw smaller than this isn't worth making
export const EJECT_MIN_PARENT_REMAINING = 10; // parent must keep at least this after ejecting

// §6.2 Pipelines
export const PIPE_RATE_PER_SEC = 3; // nutrients per second drawn out of the source
// Draining a nutrient fall yields more than it costs the fall: the fall loses
// PIPE_RATE_PER_SEC, the colony gains this multiple of it. Colony-to-colony
// transfers stay 1:1 — doubling those would let a loop of colonies print nutrients.
export const FALL_DRAIN_GAIN = 2;
// Only outgoing hyphae are capped; a colony can take in any number (funnelling,
// reinforcement). Falls are uncapped.
export const MAX_OUT_PIPES_PER_COLONY = 4;

// §6.5 Walls — stem from a colony to a crossbar; the crossbar blocks line of sight
export const WALL_BAR_LENGTH = 170;
export const WALL_COST = 15; // one-off, paid by the anchor colony
export const MAX_WALLS_PER_COLONY = 3;
export const WALLS_CUT_EXISTING_PIPES = true; // a new crossbar severs hyphae crossing it

// §6.4 Nutrient falls — spawned as clusters of blobs, biggest in the middle
export const NEUTRAL_FALL_CLUSTERS = 70; // in addition to one cluster per spawn
export const FALL_CLUSTER_BLOBS_MIN = 4;
export const FALL_CLUSTER_BLOBS_MAX = 8;
export const FALL_CLUSTER_SPREAD = 160; // max blob distance from cluster centre
export const FALL_POOL_CENTER = 900; // pool of a blob at the cluster centre
export const FALL_POOL_EDGE = 120; // pool of a blob at the cluster's outer edge
export const SPAWN_CLUSTER_DISTANCE = 500; // spawn → its cluster centre (just beyond start reach)
export const FALLS_PAY_UPKEEP = false; // open design question

// §4 Arena
export const ARENA_RADIUS = 5400; // ~15x the area of the first prototype map
export const TERRAIN_CELL = 90; // cave-generation grid cell size
export const TERRAIN_FILL = 0.52; // initial wall chance before smoothing
export const TERRAIN_SMOOTHING = 4; // cellular-automata passes
export const SPAWN_CLEAR_RADIUS = 800; // terrain carved open around each spawn

// §8 Fog of war — colonies light up a radius; explored ground stays remembered
export const VISION_REACH_SCALE = 1.15; // vision as a multiple of a colony's reach
export const VISION_MIN = 520;
export const FOG_CELL = 240; // resolution of the explored-ground memory
export const FOG_EXPLORED_ALPHA = 0.28; // how much fog remains over remembered ground
// Fog edges are hard-edged circles, so it renders at full resolution.
export const FOG_RENDER_SCALE = 1;

// Multiplayer rounds
export const ROUND_SECONDS = 600;
export const INTERMISSION_SECONDS = 12;
export const SNAPSHOT_HZ = 10;
export const SERVER_PORT = 8787;
/** Arena radius scales with the player count so density stays roughly constant. */
export function radiusForPlayers(players: number): number {
  return Math.round(Math.min(12000, Math.max(2800, ARENA_RADIUS * Math.sqrt(Math.max(1, players) / 4))));
}

// Match (solo/offline mode)
export const PLAYER_COUNT = 4; // player 1 is human, the rest are bots
export const BOT_THINK_SECONDS = 1;
export const ROUND_RESTART_DELAY_MS = 4000;

// Nodes are points: a fixed-size core dot (used for hit-testing and spacing).
export const NODE_CORE_RADIUS = 7;
export const NODE_SPACING = 22; // min clearance between a new node and existing cores

/**
 * Visual only: the fluid "aura" around each core grows with stored nutrients, and
 * auras of one owner merge into a single contiguous mass (metaballs).
 *
 * Sized so territory is modest at spawn and sprawling once you have eaten your
 * starting cluster — by then a colony covers most of a screen and a network's
 * colonies have merged into one mass, as in the original.
 *
 * 30 (fresh colony) → 89, 100 (spawn) → 171, 300 → 312, 1000 → 643,
 * 3000 (starting cluster eaten) → 1236, beyond that → capped.
 *
 * AURA_SCALE alone grows or shrinks all territory; the exponent sets how quickly
 * a rich colony outgrows a poor one.
 */
export const AURA_SCALE = 11;
export const MAX_COLONY_AURA = 900;

export function colonyAura(nutrients: number): number {
  return Math.min(MAX_COLONY_AURA, 12 + Math.max(0, nutrients) ** 0.55 * AURA_SCALE);
}

export function fallAura(nutrients: number): number {
  return Math.min(420, 3 + Math.sqrt(Math.max(0, nutrients)) * 2.5);
}

export function reach(nutrients: number): number {
  return 220 + Math.sqrt(Math.max(0, nutrients)) * 20;
}
