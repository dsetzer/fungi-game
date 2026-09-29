import { SIM_HZ } from "../config";
import { BOT_LEVELS, runBot } from "./bot";
import type { World } from "./world";

/** One authoritative tick: let bots issue commands, then advance the world. */
export function stepMatch(world: World): void {
  const every = Math.max(1, Math.round(BOT_LEVELS[world.botLevel].thinkSeconds * SIM_HZ));
  if (world.tick % every === 0) {
    for (const p of world.players) if (p.isBot && p.alive) runBot(world, p.id, world.botLevel);
  }
  world.step();
}
