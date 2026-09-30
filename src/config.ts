// All gameplay tuning lives here. Values are first-pass guesses — see design doc §9.
// Economy rates are per SECOND (the design's "1 nutrient per tick" means a 1 s tick);
// the sim itself steps faster so commands and flow feel responsive.

export const SIM_HZ = 10; // sim steps per second
export const TICK_MS = 1000 / SIM_HZ;
export const DT = 1 / SIM_HZ; // seconds per sim step

// §6.2 Hyphae set the pace of the whole game.
export const PIPE_RATE_PER_SEC = 10; // nutrients per second drawn out of the source
/**
 * The game was first balanced with hyphae at 3/s. Everything colony-side —
 * stores, upkeep, costs, fall pools — is that original amount × NUTRIENT_SCALE;
 * reach and territory read a store in the original units, so a bigger number
 * doesn't mean a longer arm.
 *
 * This is the one dial for how fast the game drains. Throws, fights and
 * starvation are the same mechanic, so they move together: at 10/3 everything
 * empties exactly as it did at 3/s; at 1 everything empties 3.3× faster (a throw
 * pours an unfed parent into its child in seconds). 2 is the compromise: fights
 * resolve ~1.7× faster and a parent still has a few seconds after a throw.
 */
export const NUTRIENT_SCALE = 2;

// §5 Node economy
export const START_NUTRIENTS = 100 * NUTRIENT_SCALE;
export const UPKEEP_PER_SEC = 1 * NUTRIENT_SCALE;
/**
 * Ejecting carries a share of the parent's store rather than a flat amount, so a
 * rich colony throws a strong child that can immediately throw again — chained
 * expansion across the map, instead of stalling on a 30-nutrient stub with no
 * reach. Adjustable per throw with the wheel while dragging (§6.1).
 */
export const EJECT_FRACTION_DEFAULT = 0.65;
export const EJECT_FRACTION_MIN = 0.15;
export const EJECT_FRACTION_MAX = 0.9;
export const EJECT_MIN_AMOUNT = 12 * NUTRIENT_SCALE; // a throw smaller than this isn't worth making
export const EJECT_MIN_PARENT_REMAINING = 5 * NUTRIENT_SCALE; // parent must keep at least this after ejecting

// §6.2 Pipelines
// Every hypha is 1:1, falls included: ten out of a fall arrive as ten. So a
// sustain loop — feeding a fall while draining it — holds the pool flat and nets
// nothing. Holding Harvest (§6.7) changes that: your fall lines yield double, and
// a loop becomes an endless income. Colony-to-colony transfers are always 1:1 —
// any gain there would let a ring of colonies print nutrients with no fall at all.
/** Harvest: what your hyphae out of a fall yield per nutrient they draw. */
export const HARVEST_MULTIPLIER = 2;
/** Siphon: how much harder your hyphae draining a rival's node pull. */
export const SIPHON_MULTIPLIER = 2;
/** Rind: how hard a rival's hyphae draining your nodes pull. Cancels Siphon exactly. */
export const RIND_MULTIPLIER = 0.5;
// Only outgoing hyphae are capped; a colony can take in any number (funnelling,
// reinforcement). Falls are uncapped. The cap counts only hyphae the colony's
// owner grew: a rival's drain line hangs off your colony without using up a slot,
// so a developed hub can still be attacked (and can still expand while under attack).
export const MAX_OUT_PIPES_PER_COLONY = 4;

// Every hypha runs at PIPE_RATE_PER_SEC, whatever it draws from: a fall, your own
// colony or a rival's. Draining a rival is no special case — it takes what it
// takes, 1:1, and pulling harder means more hyphae on the target (§6.3 funnelling).

// §6.7 Boosts — capture points: feed one to own it, keep it fed to hold it.
// Starting numbers, all to be tuned in play.
export const BOOST_START = 2; // on the map when a round begins
export const BOOST_MAX = 5; // never more than this on the map at once
export const BOOST_SPAWN_SECONDS = 40; // a new one appears this often, anywhere open
export const BOOST_POOL = 400 * NUTRIENT_SCALE; // a fresh boost's store
/** Keeps boosts off the doorstep of a spawn or a colony, so they are worth a trip. */
export const BOOST_MIN_COLONY_DISTANCE = 700;
/** Boosts stand on their own ground, never among a fall cluster. */
export const BOOST_MIN_FALL_DISTANCE = 350;
export const BRANCH_OUT_PIPES = 8; // Branch: output slots per colony (normally 4)
export const REACH_BONUS = 200; // Reach: added to every colony's reach (cap 600 → 800)
export const VISION_BONUS = 1.5; // Vision: view radius multiplier
export const FLOW_MULTIPLIER = 2; // Flow: every hypha of yours carries this many times its rate
export const FLOW_SECONDS = 10;
export const FLOW_COOLDOWN_SECONDS = 45; // counted from when Flow ends
export const SEVER_COOLDOWN_SECONDS = 30;

// §6.5 Walls — stem from a colony to a crossbar; the crossbar blocks line of sight
export const WALL_BAR_LENGTH = 170;
export const WALL_COST = 15 * NUTRIENT_SCALE; // one-off, paid by the anchor colony
export const MAX_WALLS_PER_COLONY = 3;
// A new crossbar does NOT sever hyphae already crossing it: walling over your own
// established lines while denying the ground to anyone else is the point of placing
// one well. A wall blocks line of sight, so it stops *new* connections and ejections
// across it, and that is all it does.
export const WALLS_CUT_EXISTING_PIPES = false;

// §6.4 Nutrient falls — small, loose groups: 1–6 falls, of which only 1–3 sit
// right next to each other and the rest are scattered around. Sizes vary wildly
// and have nothing to do with position, so no two groups look alike.
export const NEUTRAL_FALL_CLUSTERS = 70; // in addition to one group per spawn
export const FALL_CLUSTER_BLOBS_MIN = 1;
export const FALL_CLUSTER_BLOBS_MAX = 6;
export const FALL_CLUSTER_TIGHT_MAX = 3; // falls packed right next to each other
export const FALL_CLUSTER_TIGHT_GAP = 45; // between those
export const FALL_CLUSTER_LOOSE_MIN = 150; // the rest: this far from the group's centre…
export const FALL_CLUSTER_LOOSE_MAX = 350; // …up to this
export const FALL_CLUSTER_GAP = 700; // group centres never closer than this to another fall
export const FALL_POOL_MIN = 60 * NUTRIENT_SCALE; // pools are spread evenly between these on a log scale:
export const FALL_POOL_MAX = 1200 * NUTRIENT_SCALE; // as many small ones as middling, a few rich
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

// Camera
/** Time constant of the eased fly-to: lower is snappier. */
export const CAMERA_FLY_TAU_MS = 160;
/** Drag-panning eases too, but tighter, so the map still feels held by the mouse. */
export const CAMERA_PAN_TAU_MS = 70;
/** Follow a newly thrown colony to where it lands. */
export const CAMERA_FLY_ON_EJECT = true;

// Match (solo/offline mode)
export const PLAYER_COUNT = 4; // player 1 is human, the rest are bots
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
 * The offset matters as much as the scale: without it, a colony too weak to even
 * throw still drew a substantial blob, so the map told you that you were strong
 * when you were not. Size now collapses toward the dot as a colony empties.
 *
 * In original units (store ÷ NUTRIENT_SCALE): 12 (can barely throw) → 18,
 * 30 → 45, 100 (spawn) → 114, 300 → 228, 1000 → 470, 2500 → 800, beyond → capped.
 */
export const AURA_SCALE = 11;
export const AURA_OFFSET = 25;
export const MAX_COLONY_AURA = 900;

export function colonyAura(nutrients: number): number {
  const grown = Math.max(0, nutrients / NUTRIENT_SCALE) ** 0.55 * AURA_SCALE - AURA_OFFSET;
  return Math.min(MAX_COLONY_AURA, Math.max(NODE_CORE_RADIUS + 4, grown));
}

export function fallAura(nutrients: number): number {
  return Math.min(420, 3 + Math.sqrt(Math.max(0, nutrients / NUTRIENT_SCALE)) * 2.5);
}

/**
 * However rich a colony gets, it never reaches across the map: past this, more
 * nutrients only make it a stronger thrower of children, not a longer arm. Without
 * a ceiling one fat colony could tap falls and drain rivals from far away and never
 * need to expand. The start reach (420) sits well under it.
 */
export const MAX_REACH = 600;

export function reach(nutrients: number): number {
  return Math.min(MAX_REACH, 220 + Math.sqrt(Math.max(0, nutrients / NUTRIENT_SCALE)) * 20);
}
