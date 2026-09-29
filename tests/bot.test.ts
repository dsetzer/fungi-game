import { describe, expect, it } from "vitest";
import { SIM_HZ } from "../src/config";
import { emptyArena } from "../src/sim/arena";
import { BOT_LEVELS, runBot } from "../src/sim/bot";
import { stepMatch } from "../src/sim/match";
import { World } from "../src/sim/world";

function botWorld() {
  const world = new World(emptyArena(3000));
  const bot = world.addPlayer("bot", true);
  return { world, bot };
}

describe("bots", () => {
  it("tap every fall in reach, not just one", () => {
    const { world, bot } = botWorld();
    const home = world.addColony(bot.id, 0, 0, 200);
    const near = [world.addFall(150, 0, 300), world.addFall(-150, 0, 300), world.addFall(0, 150, 300)];
    for (let i = 0; i < 6 * SIM_HZ; i++) stepMatch(world);
    for (const f of near) expect(world.pipeBetween(f.id, home.id), `fall ${f.id}`).toBeDefined();
  });

  it("throw toward food out of reach instead of sitting still", () => {
    const { world, bot } = botWorld();
    world.addColony(bot.id, 0, 0, 300);
    world.addFall(1500, 0, 900);
    for (let i = 0; i < 10 * SIM_HZ; i++) stepMatch(world);
    const colonies = [...world.nodes.values()].filter((n) => n.owner === bot.id);
    expect(colonies.length).toBeGreaterThan(1);
    expect(Math.max(...colonies.map((c) => c.x))).toBeGreaterThan(200); // headed for the fall
  });

  it("act no faster than their level allows", () => {
    for (const level of ["easy", "hard"] as const) {
      const { world, bot } = botWorld();
      world.addColony(bot.id, 0, 0, 500);
      for (let i = 0; i < 30; i++) world.addFall(Math.cos(i) * 200, Math.sin(i) * 200, 200);
      let commands = 0;
      const enqueue = world.enqueue.bind(world);
      world.enqueue = (cmd) => { commands++; enqueue(cmd); };
      const seconds = 10;
      const { thinkSeconds, actionsPerSecond } = BOT_LEVELS[level];
      for (let t = 0; t < seconds; t += thinkSeconds) runBot(world, bot.id, level);
      // A small starting burst, then the level's rate.
      expect(commands, level).toBeLessThanOrEqual(3 + actionsPerSecond * seconds);
    }
  });
});
