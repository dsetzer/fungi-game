import { describe, expect, it } from "vitest";
import { EJECT_BUFFER, PIPE_RATE_PER_SEC, SIM_HZ, UPKEEP_PER_SEC, reach } from "../src/config";
import type { Arena } from "../src/sim/arena";
import { dist } from "../src/sim/geometry";
import { World } from "../src/sim/world";

const openArena = (walls: Arena["walls"] = []): Arena => ({ radius: 2000, walls, spawns: [] });

function soloWorld(walls: Arena["walls"] = []) {
  const world = new World(openArena(walls));
  const me = world.addPlayer("me", false);
  return { world, me };
}

function runSeconds(world: World, seconds: number) {
  for (let i = 0; i < Math.round(seconds * SIM_HZ); i++) world.step();
}

describe("upkeep", () => {
  it("costs UPKEEP_PER_SEC per second, not per sim step", () => {
    const { world, me } = soloWorld();
    const n = world.addColony(me.id, 0, 0, 100);
    runSeconds(world, 1);
    expect(n.nutrients).toBeCloseTo(100 - UPKEEP_PER_SEC);
    expect(n.rate).toBeCloseTo(-UPKEEP_PER_SEC);
  });

  it("withers a colony once upkeep empties it", () => {
    const { world, me } = soloWorld();
    const n = world.addColony(me.id, 0, 0, 3 * UPKEEP_PER_SEC);
    runSeconds(world, 2.5);
    expect(world.nodes.has(n.id)).toBe(true);
    runSeconds(world, 1);
    expect(world.nodes.has(n.id)).toBe(false);
    expect(world.ended).toBe(true);
  });

  it("does not charge nutrient falls upkeep", () => {
    const { world, me } = soloWorld();
    world.addColony(me.id, 0, 0, 100);
    const fall = world.addFall(300, 0, 50);
    runSeconds(world, 1);
    expect(fall.nutrients).toBe(50);
  });
});

describe("eject", () => {
  it("moves the buffer from parent to a new colony", () => {
    const { world, me } = soloWorld();
    const parent = world.addColony(me.id, 0, 0, 200);
    world.enqueue({ type: "eject", player: me.id, from: parent.id, x: 100, y: 0 });
    world.step();
    const child = [...world.nodes.values()].find((n) => n !== parent)!;
    const upkeepStep = UPKEEP_PER_SEC / SIM_HZ;
    expect(child.nutrients).toBeCloseTo(EJECT_BUFFER - upkeepStep);
    expect(parent.nutrients).toBeCloseTo(200 - EJECT_BUFFER - upkeepStep);
  });

  it("rejects targets beyond reach or behind a wall", () => {
    const { world, me } = soloWorld([{ x: 100, y: 0, r: 20 }]);
    const parent = world.addColony(me.id, 0, 0, 200);
    expect(world.canEject(me.id, parent.id, { x: 5000, y: 0 }).ok).toBe(false);
    expect(world.canEject(me.id, parent.id, { x: 160, y: 0 })).toEqual({
      ok: false,
      reason: "no line of sight",
    });
    expect(world.canEject(me.id, parent.id, { x: 0, y: 120 }).ok).toBe(true);
  });
});

describe("pipes", () => {
  it("moves PIPE_RATE_PER_SEC per second from start to end", () => {
    const { world, me } = soloWorld();
    const a = world.addColony(me.id, 0, 0, 100);
    const b = world.addColony(me.id, 120, 0, 100);
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: b.id });
    world.step(); // command applies on this step
    const a0 = a.nutrients;
    const b0 = b.nutrients;
    runSeconds(world, 1);
    expect(a.nutrients).toBeCloseTo(a0 - PIPE_RATE_PER_SEC - UPKEEP_PER_SEC);
    expect(b.nutrients).toBeCloseTo(b0 + PIPE_RATE_PER_SEC - UPKEEP_PER_SEC);
  });

  it("allows only one pipe per pair, in either direction", () => {
    const { world, me } = soloWorld();
    const a = world.addColony(me.id, 0, 0, 100);
    const b = world.addColony(me.id, 120, 0, 100);
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: b.id });
    world.step();
    expect(world.canConnect(me.id, b.id, a.id).ok).toBe(false);
  });

  it("can drain a nutrient fall into an owned colony until it's gone", () => {
    const { world, me } = soloWorld();
    const c = world.addColony(me.id, 0, 0, 100);
    const fall = world.addFall(150, 0, 2 * PIPE_RATE_PER_SEC);
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: c.id });
    runSeconds(world, 2.5);
    expect(world.nodes.has(fall.id)).toBe(false);
    expect(world.pipes.size).toBe(0);
  });

  it("feeding a fall while draining it keeps it alive (sustain trick, §6.4)", () => {
    const { world, me } = soloWorld();
    const a = world.addColony(me.id, -150, 0, 500);
    const b = world.addColony(me.id, 150, 0, 100);
    const fall = world.addFall(0, 0, 10);
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: fall.id });
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: b.id });
    runSeconds(world, 20);
    expect(fall.nutrients).toBeCloseTo(10);
  });

  it("cannot connect two nodes neither of which you own", () => {
    const { world, me } = soloWorld();
    const rival = world.addPlayer("rival", true);
    world.addColony(me.id, 500, 500, 100);
    const r = world.addColony(rival.id, 0, 0, 100);
    const f = world.addFall(100, 0, 100);
    expect(world.canConnect(me.id, f.id, r.id).ok).toBe(false);
  });
});

describe("match", () => {
  it("declares the last network standing the winner", () => {
    const world = new World(openArena());
    const a = world.addPlayer("a", false);
    const b = world.addPlayer("b", true);
    world.addColony(a.id, 0, 0, 100);
    world.addColony(b.id, 500, 0, 0.05);
    world.step();
    expect(world.ended).toBe(true);
    expect(world.winner).toBe(a.id);
  });

  it("generates a playable match deterministically from a seed", () => {
    const w1 = World.createMatch(42);
    const w2 = World.createMatch(42);
    expect(w1.arena.walls).toEqual(w2.arena.walls);
    expect([...w1.nodes.values()].map((n) => [n.x, n.y])).toEqual(
      [...w2.nodes.values()].map((n) => [n.x, n.y]),
    );
    expect(w1.players.length).toBeGreaterThan(1);
  });

  it("gives every spawn a fall in starting reach and a richer one just beyond", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const world = World.createMatch(seed);
      const falls = [...world.nodes.values()].filter((n) => n.kind === "fall");
      for (const home of [...world.nodes.values()].filter((n) => n.kind === "colony")) {
        const startReach = reach(home.nutrients);
        const inReach = falls.filter(
          (f) => dist(home.x, home.y, f.x, f.y) <= startReach && world.hasLineOfSight(home, f),
        );
        expect(inReach.length, `seed ${seed} player ${home.owner}`).toBeGreaterThan(0);
        const bestInReach = Math.max(...inReach.map((f) => f.nutrients));
        const nearby = falls.filter((f) => dist(home.x, home.y, f.x, f.y) <= startReach * 1.6);
        expect(Math.max(...nearby.map((f) => f.nutrients))).toBeGreaterThan(bestInReach);
      }
    }
  });
});
