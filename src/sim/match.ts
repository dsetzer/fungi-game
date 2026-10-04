import { SIM_HZ } from "../config";
import { BOT_LEVELS, runBot, type BotLevel } from "./bot";
import type { World } from "./world";

/**
 * The bots in a solo match, by the difficulty picked (cycled when there are
 * more seats): a mix, so no two bots are quite equal and matches don't stall in
 * a tie. A hard match has no easy bot — a weak one is a free meal that whoever
 * eats first snowballs on.
 */
const MIX: Record<BotLevel, BotLevel[]> = {
  easy: ["easy"],
  normal: ["normal", "normal", "easy"],
  hard: ["hard", "hard", "normal"],
};

/** Sets a match's difficulty: each bot gets its level from the mix, shown in its name. */
export function setDifficulty(world: World, level: BotLevel): void {
  world.botLevel = level;
  const mix = MIX[level];
  let n = 0;
  for (const p of world.players) {
    if (!p.isBot) continue;
    p.level = mix[n % mix.length];
    n++;
    p.name = `Bot ${n} · ${p.level}`;
  }
}

/** One authoritative tick: let bots issue commands, then advance the world. */
export function stepMatch(world: World): void {
  for (const p of world.players) {
    if (!p.isBot || !p.alive) continue;
    const level = p.level ?? world.botLevel;
    const every = Math.max(1, Math.round(BOT_LEVELS[level].thinkSeconds * SIM_HZ));
    if (world.tick % every === 0) runBot(world, p.id, level);
  }
  world.step();
}
