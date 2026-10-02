import { SIM_HZ } from "../../config";
import type { PlayerId } from "../types";
import type { World } from "../world";
import { Board } from "./board";
import { MIN_VALUE, memoryOf, observe, type Candidate } from "./core";
import { reflexes } from "./reflexes";
import { BOT_LEVELS, type BotLevel } from "./profile";
import { WEIGHTS, choosePosture, planTasks } from "./strategy";

export { BOT_LEVELS, type BotLevel, type BotProfile } from "./profile";

/**
 * Computer players — see bot-design.md for the whole design.
 *
 * Three layers, re-run every time the bot looks:
 *   1. Strategy: a posture (opening, expand, consolidate, war, defend) chosen by
 *      a state machine from live stats, and which multi-step tasks to start.
 *   2. Tasks: persistent state machines — expeditions that path round terrain,
 *      wall-then-sever plans, Harvest loops, boost holds, sieges.
 *   3. Reflexes: what a healthy network needs every moment — taps, supply lines,
 *      reversals, rings, relinking, walls, drains, Flow.
 * Every candidate move from all three is priced on one scale, weighted by the
 * posture, and checked against the real rules best-first; the best legal one
 * is the action taken.
 *
 * Eyes are instant, hands are slow: the bot re-reads its network every look,
 * but acts one thing at a time with a gap after each, set by its level.
 * Bots issue ordinary Commands — no special access to the sim — so they double
 * as example scripts for a future coding API.
 */
/** Candidates checked against the rules, best first, before giving up this look. */
const MAX_CHECKED = 400;

export function runBot(world: World, player: PlayerId, level: BotLevel = "normal"): void {
  const memory = memoryOf(world, player);
  observe(world, player, memory);
  const profile = BOT_LEVELS[level];
  const gap = SIM_HZ / profile.actionsPerSecond;
  if (world.tick - memory.lastAction < gap) return; // hands still busy

  const board = new Board(world, player, memory, profile);
  if (board.mine.length === 0) return;
  const choice = decide(board);
  if (!choice) return;
  world.enqueue(choice.cmd);
  choice.onChosen?.();
  memory.lastAction = world.tick;
}

/** Every move the bot could make right now, weighted and ranked; the best legal one. */
export function decide(board: Board): Candidate | null {
  const memory = board.memory;
  const posture = choosePosture(board, memory);
  planTasks(board, memory);
  const candidates: Candidate[] = [];
  for (const task of memory.tasks) if (!task.done) candidates.push(...task.step(board, memory));
  board.computeNeeds(); // after expeditions have named their leads
  candidates.push(...reflexes(board));

  const weights = WEIGHTS[posture];
  for (const c of candidates) c.value *= weights[c.category];
  candidates.sort((a, b) => b.value - a.value);
  let checked = 0;
  for (const c of candidates) {
    if (c.value < MIN_VALUE || checked >= MAX_CHECKED) break;
    // Not yet: the bot hasn't had its reaction time since what this answers appeared.
    if (c.reactsTo && !c.reactsTo.every((k) => board.ready(k))) continue;
    checked++;
    if (c.valid()) return c;
  }
  return null;
}
