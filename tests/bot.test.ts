import { describe, expect, it } from "vitest";
import { SIM_HZ } from "../src/config";
import { emptyArena } from "../src/sim/arena";
import { BOT_LEVELS, aim, runBot } from "../src/sim/bot";
import { ACTION_EFFORT, ACTION_JITTER } from "../src/sim/bot/profile";
import { makeRng } from "../src/sim/geometry";
import { stepMatch } from "../src/sim/match";
import type { BoostKind, Command } from "../src/sim/types";
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

  it("act one thing at a time, no faster than their level allows", () => {
    for (const level of ["easy", "hard"] as const) {
      const { world, bot } = botWorld();
      world.addColony(bot.id, 0, 0, 500);
      for (let i = 0; i < 30; i++) world.addFall(Math.cos(i) * 200, Math.sin(i) * 200, 200);
      const ticks: number[] = [];
      const kinds: Command["type"][] = [];
      const enqueue = world.enqueue.bind(world);
      world.enqueue = (cmd) => { ticks.push(world.tick); kinds.push(cmd.type); enqueue(cmd); };
      const seconds = 10;
      // Asked every tick, far more often than it thinks in a match.
      for (let t = 0; t < seconds * SIM_HZ; t++) {
        runBot(world, bot.id, level);
        world.step();
      }
      // Each gap is at least the level's gap, less the jitter, scaled by how much
      // aim the action before it took.
      const minGap = (SIM_HZ / BOT_LEVELS[level].actionsPerSecond) * (1 - ACTION_JITTER);
      const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
      gaps.forEach((g, i) => expect(g, `${level} after ${kinds[i]}`).toBeGreaterThanOrEqual(Math.floor(minGap * ACTION_EFFORT[kinds[i]])));
      const minEffort = Math.min(...Object.values(ACTION_EFFORT));
      expect(ticks.length, level).toBeLessThanOrEqual((seconds * SIM_HZ) / (minGap * minEffort) + 1);
      // Jittered: not every gap the same.
      if (gaps.length > 2) expect(new Set(gaps).size, level).toBeGreaterThan(1);
    }
  });
});

describe("bot hands", () => {
  it("land throws off target by a share of their length; everything else is exact", () => {
    const world = new World(emptyArena(3000));
    const p = world.addPlayer("bot", true);
    const c = world.addColony(p.id, 0, 0, 500);
    const rng = makeRng(3);
    const misses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const thrown = aim(world, { type: "eject", player: p.id, from: c.id, x: 400, y: 0 }, 0.07, rng);
      if (thrown.type === "eject") misses.push(Math.hypot(thrown.x - 400, thrown.y));
    }
    expect(Math.max(...misses)).toBeLessThanOrEqual(400 * 0.07 * 2);
    const mean = misses.reduce((s, m) => s + m, 0) / misses.length;
    expect(mean).toBeGreaterThan(400 * 0.07 * 0.8);
    expect(mean).toBeLessThan(400 * 0.07 * 1.2);
    const link: Command = { type: "connect", player: p.id, from: c.id, to: 7 };
    expect(aim(world, link, 0.07, rng)).toBe(link);
  });

  it("are quicker at clicks than at aimed drags", () => {
    expect(ACTION_EFFORT.reverse).toBeLessThan(ACTION_EFFORT.wall);
    expect(ACTION_EFFORT.wall).toBeLessThan(ACTION_EFFORT.eject);
    expect(ACTION_EFFORT.connect).toBe(ACTION_EFFORT.eject);
  });
});

/** A bot and a rival that never acts on its own — the scenarios script it. */
function duel(walls: Parameters<typeof emptyArena>[1] = []) {
  const world = new World(emptyArena(3000, walls));
  world.endOnLastStanding = false;
  const bot = world.addPlayer("bot", true);
  const rival = world.addPlayer("rival", false);
  world.addColony(rival.id, 2600, 0, 100_000); // keeps the rival alive, far off
  return { world, bot, rival };
}

/** Gives a player a boost of a kind, held somewhere out of the way. */
function give(world: World, player: number, kind: BoostKind, at = { x: -2400, y: 800 }) {
  const b = world.addBoost(at.x, at.y, kind, 50_000);
  b.owner = player;
  world.boostsChanged();
  return b;
}

/** Records every command, with the tick it was issued on. */
function recorder(world: World) {
  const log: { tick: number; cmd: Command }[] = [];
  const enqueue = world.enqueue.bind(world);
  world.enqueue = (cmd) => {
    log.push({ tick: world.tick, cmd });
    enqueue(cmd);
  };
  return log;
}

describe("bot behaviour (bot-design.md)", () => {
  it("hard evacuates a rich colony being funnelled, then not again for a while", () => {
    const { world, bot, rival } = duel();
    const rich = world.addColony(bot.id, 0, 0, 900);
    world.addColony(bot.id, -500, 0, 300);
    const a = world.addColony(rival.id, 380, 120, 5000);
    const b = world.addColony(rival.id, 380, -120, 5000);
    world.enqueue({ type: "connect", player: rival.id, from: rich.id, to: a.id });
    world.enqueue({ type: "connect", player: rival.id, from: rich.id, to: b.id });
    world.step();
    const log = recorder(world);
    for (let i = 0; i < 12 * SIM_HZ; i++) {
      runBot(world, bot.id, "hard");
      world.step();
    }
    const evacuations = log.filter((l) => l.cmd.type === "eject" && l.cmd.from === rich.id && l.cmd.fraction === 0.9);
    expect(evacuations).toHaveLength(1);
    const child = [...world.nodes.values()].find((n) => n.owner === bot.id && n.kind === "colony" && n.id > b.id);
    expect(child).toBeDefined();
    expect(child!.nutrients).toBeGreaterThan(500); // most of it got out
  });

  describe("drain lines on one rival", () => {
    // Four colonies of ours round a weak rival colony, all of them in reach.
    function ring(level: "easy" | "normal" | "hard", rivalLines: number) {
      const { world, bot, rival } = duel();
      const prey = world.addColony(rival.id, 0, 0, 300);
      const ours = [0, 1, 2, 3].map((k) => world.addColony(bot.id, Math.cos(k * 1.57) * 300, Math.sin(k * 1.57) * 300, 600));
      // The rival's own lines on us, from colonies of its far off.
      for (let k = 0; k < rivalLines; k++) {
        const hunter = world.addColony(rival.id, Math.cos(k * 1.57 + 0.8) * 650, Math.sin(k * 1.57 + 0.8) * 650, 5000);
        world.enqueue({ type: "connect", player: rival.id, from: ours[k].id, to: hunter.id });
      }
      world.step();
      // The most lines it ever held on the prey (hard may well kill it).
      let most = 0;
      for (let i = 0; i < 25 * SIM_HZ; i++) {
        runBot(world, bot.id, level);
        world.step();
        most = Math.max(most, [...world.pipes.values()].filter((p) => p.from === prey.id && p.owner === bot.id).length);
      }
      return most;
    }

    it("normal runs at most two on one colony, even when attacked", () => {
      expect(ring("normal", 0)).toBe(2);
      expect(ring("normal", 4)).toBeLessThanOrEqual(2);
    });
    it("hard stacks more than normal can", () => {
      expect(ring("hard", 0)).toBeGreaterThanOrEqual(3);
    });
  });

  it("normal never evacuates", () => {
    const { world, bot, rival } = duel();
    const rich = world.addColony(bot.id, 0, 0, 900);
    const a = world.addColony(rival.id, 380, 120, 5000);
    const b = world.addColony(rival.id, 380, -120, 5000);
    world.enqueue({ type: "connect", player: rival.id, from: rich.id, to: a.id });
    world.enqueue({ type: "connect", player: rival.id, from: rich.id, to: b.id });
    world.step();
    const log = recorder(world);
    for (let i = 0; i < 12 * SIM_HZ; i++) {
      runBot(world, bot.id, "normal");
      world.step();
    }
    expect(log.some((l) => l.cmd.type === "eject" && l.cmd.fraction === 0.9)).toBe(false);
  });

  it("cuts its Harvest loop once Harvest is lost, so the fall gets eaten", () => {
    const { world, bot } = duel();
    world.addColony(bot.id, 0, 0, 800);
    world.addColony(bot.id, 120, 80, 800);
    const fall = world.addFall(150, -60, 5000);
    const harvest = give(world, bot.id, "harvest");
    const feeding = () => [...world.pipes.values()].some((p) => p.to === fall.id);
    for (let i = 0; i < 30 * SIM_HZ && !feeding(); i++) {
      runBot(world, bot.id, "hard");
      world.step();
    }
    expect(feeding()).toBe(true); // the loop, while it pays
    harvest.owner = null;
    world.boostsChanged();
    for (let i = 0; i < 20 * SIM_HZ && feeding(); i++) {
      runBot(world, bot.id, "hard");
      world.step();
    }
    expect(feeding()).toBe(false);
    const left = fall.nutrients;
    for (let i = 0; i < 5 * SIM_HZ; i++) world.step();
    expect(fall.nutrients).toBeLessThan(left); // being eaten, not held flat
  });

  it("leaves an idle ring to go after food, instead of circulating it forever", () => {
    // A closed ring with nothing coming in pays no upkeep, so it would idle for
    // ever; every colony in it is a relay, which once made every throw too dear.
    const { world, bot } = duel();
    const ring = [0, 1, 2].map((k) => world.addColony(bot.id, -1500 + Math.cos(k * 2.1) * 120, Math.sin(k * 2.1) * 120, 300));
    for (let k = 0; k < 3; k++) world.enqueue({ type: "connect", player: bot.id, from: ring[k].id, to: ring[(k + 1) % 3].id });
    world.step();
    expect(world.pipes.size).toBe(3);
    // Food well beyond a single throw: only an expedition gets there.
    world.addFall(1500, 0, 2000);
    const log = recorder(world);
    for (let i = 0; i < 60 * SIM_HZ; i++) {
      runBot(world, bot.id, "normal");
      world.step();
      if (log.some((l) => l.cmd.type === "eject")) break;
    }
    expect(log.some((l) => l.cmd.type === "eject")).toBe(true);
  });

  it("goes round a terrain wall to reach a boost, instead of throwing at the wall", () => {
    // A wall of rock straight between the colony and the boost, open only at the top.
    const walls = [];
    for (let y = -2950; y <= 700; y += 70) walls.push({ x: 0, y, r: 55 });
    const { world, bot } = duel(walls);
    world.addColony(bot.id, -600, 0, 4000);
    const boost = world.addBoost(600, 0, "branch");
    expect(world.hasLineOfSight({ x: -600, y: 0 }, boost)).toBe(false);
    for (let i = 0; i < 150 * SIM_HZ; i++) {
      runBot(world, bot.id, "hard");
      world.step();
      if (boost.owner === bot.id) break;
    }
    expect(boost.owner).toBe(bot.id);
    // It got there by going over the top of the wall.
    const colonies = [...world.nodes.values()].filter((n) => n.owner === bot.id && n.kind === "colony");
    expect(Math.max(...colonies.map((c) => c.y))).toBeGreaterThan(700);
  });

  it("walls a drain off before severing it, so it can't simply latch on again", () => {
    const { world, bot, rival } = duel();
    const victim = world.addColony(bot.id, 0, 0, 3000);
    const attacker = world.addColony(rival.id, 350, 0, 800);
    give(world, bot.id, "sever");
    world.enqueue({ type: "connect", player: rival.id, from: victim.id, to: attacker.id });
    world.step();
    const log = recorder(world);
    let severedBlind: boolean | null = null;
    for (let i = 0; i < 40 * SIM_HZ && severedBlind === null; i++) {
      runBot(world, bot.id, "hard");
      const sever = log.find((e) => e.cmd.type === "sever");
      if (sever) severedBlind = !world.hasLineOfSight(victim, attacker);
      world.step();
    }
    const firstWall = log.findIndex((e) => e.cmd.type === "wall");
    const firstSever = log.findIndex((e) => e.cmd.type === "sever");
    expect(firstSever).toBeGreaterThan(-1);
    expect(firstWall).toBeGreaterThan(-1);
    expect(firstWall).toBeLessThan(firstSever);
    expect(severedBlind).toBe(true);
    world.step();
    expect(world.pipeBetween(victim.id, attacker.id)).toBeUndefined();
    expect(world.canConnect(rival.id, victim.id, attacker.id).ok).toBe(false); // walled off
  });

  it("builds a Harvest loop round a fall it draws on", () => {
    const { world, bot } = duel();
    world.addColony(bot.id, 0, 0, 1500);
    world.addColony(bot.id, 120, 220, 1500);
    const fall = world.addFall(260, 0, 400);
    give(world, bot.id, "harvest");
    const loops = () => {
      const out = [...world.pipes.values()].filter((p) => p.from === fall.id);
      const back = [...world.pipes.values()].filter((p) => p.to === fall.id && p.owner === bot.id);
      return out.some((o) => back.some((b) => world.pipeBetween(o.to, b.from)?.from === o.to));
    };
    for (let i = 0; i < 40 * SIM_HZ && !loops(); i++) {
      runBot(world, bot.id, "hard");
      world.step();
    }
    expect(loops()).toBe(true);
    const pool = fall.nutrients;
    for (let i = 0; i < 20 * SIM_HZ; i++) world.step();
    expect(fall.nutrients).toBeCloseTo(pool, 0); // the loop holds the pool
  });

  it("captures a boost and keeps it fed", () => {
    const { world, bot } = duel();
    world.addColony(bot.id, 0, 0, 2000);
    world.addFall(-200, 0, 3000);
    const boost = world.addBoost(300, 0, "reach");
    for (let i = 0; i < 90 * SIM_HZ; i++) {
      runBot(world, bot.id, "normal");
      world.step();
    }
    expect(world.nodes.has(boost.id)).toBe(true);
    expect(boost.owner).toBe(bot.id);
    expect([...world.pipes.values()].some((p) => p.to === boost.id && p.owner === bot.id)).toBe(true);
  });

  it("flips a line that drains a starving colony into a rich one", () => {
    const { world, bot } = duel();
    const rich = world.addColony(bot.id, 0, 0, 3000);
    const poor = world.addColony(bot.id, 300, 0, 120);
    world.addFall(-200, 0, 5000);
    world.enqueue({ type: "connect", player: bot.id, from: poor.id, to: rich.id });
    world.step();
    const line = world.pipeBetween(poor.id, rich.id)!;
    for (let i = 0; i < 15 * SIM_HZ && world.pipes.get(line.id)?.from === poor.id; i++) {
      runBot(world, bot.id, "hard");
      world.step();
    }
    expect(world.nodes.has(poor.id)).toBe(true);
    expect(world.pipes.get(line.id)?.from).toBe(rich.id);
  });

  it("walls off a rival colony that can reach one of its own but can't be reached back", () => {
    const { world, bot, rival } = duel();
    const hub = world.addColony(bot.id, 0, 0, 400);
    world.addFall(-200, 0, 5000); // it gathers: worth protecting
    const threat = world.addColony(rival.id, 720, 0, 20_000);
    give(world, rival.id, "reach", { x: 2400, y: 1500 });
    expect(world.reachOf(threat)).toBeGreaterThan(720);
    expect(world.reachOf(hub)).toBeLessThan(720);
    for (let i = 0; i < 30 * SIM_HZ && world.hasLineOfSight(hub, threat); i++) {
      runBot(world, bot.id, "hard");
      world.step();
    }
    expect(world.hasLineOfSight(hub, threat)).toBe(false);
    expect(world.canConnect(rival.id, hub.id, threat.id).ok).toBe(false);
  });

  it("waits its reaction time before answering a colony that lands in reach", () => {
    for (const level of ["hard", "normal", "easy"] as const) {
      const { world, bot, rival } = duel();
      world.addColony(bot.id, 0, 0, 2000);
      world.addFall(-200, 0, 5000);
      for (let i = 0; i < 5 * SIM_HZ; i++) {
        runBot(world, bot.id, level);
        world.step();
      }
      // A rival colony lands right next to it.
      const landed = world.tick;
      const intruder = world.addColony(rival.id, 300, 0, 400);
      const log = recorder(world);
      for (let i = 0; i < 12 * SIM_HZ; i++) {
        runBot(world, bot.id, level);
        world.step();
      }
      const answer = log.find((e) =>
        (e.cmd.type === "connect" && (e.cmd.from === intruder.id || e.cmd.to === intruder.id)) || e.cmd.type === "wall");
      expect(answer, level).toBeDefined();
      expect((answer!.tick - landed) / SIM_HZ, level).toBeGreaterThanOrEqual(BOT_LEVELS[level].reactionSeconds);
    }
  });

  it("easy walls a rival off on sight; hard latches on and drains it", () => {
    const answer = (level: "easy" | "hard") => {
      const { world, bot, rival } = duel();
      world.addColony(bot.id, 0, 0, 1500);
      world.addFall(-200, 0, 5000);
      const intruder = world.addColony(rival.id, 330, 0, 600);
      const log = recorder(world);
      for (let i = 0; i < 25 * SIM_HZ; i++) {
        runBot(world, bot.id, level);
        world.step();
      }
      return log.find((e) => e.cmd.type === "wall" || (e.cmd.type === "connect" && e.cmd.from === intruder.id))?.cmd.type;
    };
    expect(answer("easy")).toBe("wall");
    expect(answer("hard")).toBe("connect");
  });
});
