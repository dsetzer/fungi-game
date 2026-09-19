import { BOT_THINK_INTERVAL } from "../config";
import { runBot } from "./bot";
import type { World } from "./world";

/** One authoritative tick: let bots issue commands, then advance the world. */
export function stepMatch(world: World): void {
  if (world.tick % BOT_THINK_INTERVAL === 0) {
    for (const p of world.players) if (p.isBot && p.alive) runBot(world, p.id);
  }
  world.step();
}
