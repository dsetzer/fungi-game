/**
 * Difficulty (bot-design.md, Difficulty). Three things separate the levels, and
 * none of them is how well a bot *thinks* — every level plays the same brain:
 *
 * - **Hands** — actions per second, one at a time with a gap after each.
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
}

export const BOT_LEVELS: Record<BotLevel, BotProfile> = {
  easy: {
    actionsPerSecond: 0.2, thinkSeconds: 0.25, reactionSeconds: 5,
    drainBias: 0.5, wallBias: 1.6, wallsFirst: true, warEdge: Infinity,
  },
  normal: {
    actionsPerSecond: 0.5, thinkSeconds: 0.25, reactionSeconds: 3,
    drainBias: 1, wallBias: 1, wallsFirst: false, warEdge: 1.5,
  },
  hard: {
    actionsPerSecond: 0.7, thinkSeconds: 0.25, reactionSeconds: 1.5,
    drainBias: 1.4, wallBias: 0.7, wallsFirst: false, warEdge: 1,
  },
};
