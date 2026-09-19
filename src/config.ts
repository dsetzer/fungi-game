// All gameplay tuning lives here. Values are first-pass guesses — see design doc §9.

export const TICK_RATE = 5; // sim ticks per second
export const TICK_MS = 1000 / TICK_RATE;

// §5 Node economy
export const START_NUTRIENTS = 300;
export const UPKEEP_PER_TICK = 1;
export const EJECT_BUFFER = 30; // nutrients moved from parent into a newly ejected node
export const EJECT_MIN_PARENT_REMAINING = 10; // parent must keep at least this after ejecting

// §6.2 Pipelines
export const PIPE_RATE = 3; // nutrients per tick along one hypha
export const MAX_PIPES_PER_COLONY = 4; // counts incoming + outgoing; falls are uncapped

// §6.4 Nutrient falls
export const FALL_COUNT = 12;
export const FALL_POOL_MIN = 300;
export const FALL_POOL_MAX = 900;
export const FALLS_PAY_UPKEEP = false; // open design question

// §4 Arena
export const ARENA_RADIUS = 1400;
export const INTERIOR_CLUSTERS = 9;

// Match
export const PLAYER_COUNT = 4; // player 1 is human, the rest are bots
export const BOT_THINK_INTERVAL = 5; // ticks
export const ROUND_RESTART_DELAY_MS = 4000;

// Derived curves: size / reach as a function of stored nutrients.
export function colonyRadius(nutrients: number): number {
  return Math.min(60, 6 + Math.sqrt(Math.max(0, nutrients)) * 1.1);
}

export function fallRadius(nutrients: number): number {
  return 8 + Math.sqrt(Math.max(0, nutrients)) * 0.7;
}

export function reach(nutrients: number): number {
  return 80 + Math.sqrt(Math.max(0, nutrients)) * 9;
}
