/**
 * Difficulty (bot-design.md, Difficulty). Three things separate the levels, and
 * none of them is how well a bot *thinks* — every level plays the same brain:
 *
 * - **Hands** — actions per second, one at a time with a gap after each. The gap
 *   varies by up to ACTION_JITTER either way, so the rhythm isn't machine-regular,
 *   and scales with how much aim the action took (ACTION_EFFORT): a click on a
 *   line is quicker than a drag onto a target. Throws land off target by a share
 *   of their length (aimError), as a hand-made drag would.
 * - **Reaction** — how long after something new appears in contact before the
 *   bot may respond to it at all: a rival colony landing within reach of one of
 *   ours (or ours within reach of it), a rival line starting to drain us. A person
 *   needs time to notice and respond; a bot that latches on the instant a colony
 *   lands is no fun to play against. This is separate from the action gap.
 * - **Temperament** — what it reaches for once it reacts. Easy is defensive: it
 *   walls a rival off on sight, even one it could drain, and never goes to war.
 *   Hard is offensive: it latches on and drains on sight, and goes to war on a
 *   smaller edge. Normal sits between.
 */
/** Each action gap is the level's average gap times 1 ± up to this. */
export const ACTION_JITTER = 0.4;

/**
 * How long each kind of action keeps the hands busy, as a share of the level's
 * gap. Throws and new hyphae are precise drags onto a target; a wall is a quick
 * drag in roughly the right direction; flipping, cutting or firing an ability is
 * a single click — a person flips a chain of five far faster than they throw.
 */
export const ACTION_EFFORT: Record<Command["type"], number> = {
  eject: 1, connect: 1, wall: 0.5, sever: 0.5, reverse: 0.25, cut: 0.25, demolish: 0.25, flow: 0.25,
};

import type { Command } from "../types";

export type BotLevel = "easy" | "normal" | "hard";

export interface BotProfile {
  /** Actions per second, one at a time. */
  actionsPerSecond: number;
  /** How often the bot looks; it acts only when its gap since the last action is up. */
  thinkSeconds: number;
  /** Seconds from a rival coming into contact (or starting to drain us) to the bot responding. */
  reactionSeconds: number;
  /** Multiplies what draining a rival is worth to it. */
  drainBias: number;
  /** Multiplies what walling a rival off is worth to it. */
  wallBias: number;
  /** Wall off a rival even when one of ours could drain it instead. */
  wallsFirst: boolean;
  /** Store over the local enemy's needed before going to war; Infinity never does. */
  warEdge: number;
  /** How far a throw lands off target, as a share of its length (on average). */
  aimError: number;
  /**
   * Saves a rich colony being drained by throwing most of it out and letting the
   * shell wither (reflexes.ts, evacuate) — rarely, so it isn't a dodge for every
   * fight.
   */
  evacuates: boolean;
}

export const BOT_LEVELS: Record<BotLevel, BotProfile> = {
  easy: {
    actionsPerSecond: 0.2, thinkSeconds: 0.25, reactionSeconds: 5,
    drainBias: 0.5, wallBias: 1.6, wallsFirst: true, warEdge: Infinity,
    aimError: 0.12, evacuates: false,
  },
  normal: {
    actionsPerSecond: 0.5, thinkSeconds: 0.25, reactionSeconds: 3,
    drainBias: 1, wallBias: 1, wallsFirst: false, warEdge: 1.5,
    aimError: 0.07, evacuates: false,
  },
  hard: {
    actionsPerSecond: 0.7, thinkSeconds: 0.25, reactionSeconds: 1.5,
    drainBias: 1.4, wallBias: 0.7, wallsFirst: false, warEdge: 1,
    aimError: 0.03, evacuates: true,
  },
};
