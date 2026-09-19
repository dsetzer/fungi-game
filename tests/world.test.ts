import { describe, expect, it } from "vitest";
import {
  EJECT_BUFFER,
  MAX_IN_PIPES_PER_COLONY,
  MAX_OUT_PIPES_PER_COLONY,
  MAX_WALLS_PER_COLONY,
  PIPE_RATE_PER_SEC,
  SIM_HZ,
  UPKEEP_PER_SEC,
  WALL_COST,
  reach,
} from "../src/config";
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

  it("waives upkeep for a relay that passes on what it receives", () => {
    const { world, me } = soloWorld();
    const fall = world.addFall(-120, 0, 500);
    const relay = world.addColony(me.id, 0, 0, 20);
    const home = world.addColony(me.id, 120, 0, 100);
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: relay.id });
    world.enqueue({ type: "connect", player: me.id, from: relay.id, to: home.id });
    world.step();
    const r0 = relay.nutrients;
    const h0 = home.nutrients;
    runSeconds(world, 30);
    expect(relay.nutrients).toBeCloseTo(r0);
    expect(relay.rate).toBeCloseTo(0);
    expect(home.nutrients).toBeCloseTo(h0 + 30 * PIPE_RATE_PER_SEC);
  });

  it("destroys a node drained to 0 even while it's still being fed", () => {
    const { world, me } = soloWorld();
    const rival = world.addPlayer("rival", true);
    const fall = world.addFall(-80, 0, 500); // within the victim's small reach
    const victim = world.addColony(me.id, 0, 0, 5);
    const r1 = world.addColony(rival.id, 120, 0, 100);
    const r2 = world.addColony(rival.id, 0, 120, 100);
    // Fed at 3/s, drained at 6/s by two rival hyphae.
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: victim.id });
    world.enqueue({ type: "connect", player: rival.id, from: victim.id, to: r1.id });
    world.enqueue({ type: "connect", player: rival.id, from: victim.id, to: r2.id });
    world.step();
    expect(world.pipes.size).toBe(3);
    runSeconds(world, 10);
    expect(world.nodes.has(victim.id)).toBe(false);
    expect([...world.pipes.values()].some((p) => p.from === victim.id || p.to === victim.id)).toBe(false);
  });

  it("keeps a nearly-empty relay alive while its inflow still covers its outflow", () => {
    const { world, me } = soloWorld();
    // Close together: an almost-empty relay has very little reach of its own.
    const fall = world.addFall(-70, 0, 500);
    const relay = world.addColony(me.id, 0, 0, 0.05);
    const home = world.addColony(me.id, 70, 0, 100);
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: relay.id });
    world.enqueue({ type: "connect", player: me.id, from: relay.id, to: home.id });
    world.step();
    expect(world.pipes.size).toBe(2);
    runSeconds(world, 10);
    expect(world.nodes.has(relay.id)).toBe(true);
    expect(relay.nutrients).toBeGreaterThan(0);
  });

  it("charges upkeep when a colony sends out more than it receives", () => {
    const { world, me } = soloWorld();
    const fall = world.addFall(-120, 0, 500);
    const hub = world.addColony(me.id, 0, 0, 100);
    const a = world.addColony(me.id, 120, 0, 100);
    const b = world.addColony(me.id, 0, 120, 100);
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: hub.id });
    world.enqueue({ type: "connect", player: me.id, from: hub.id, to: a.id });
    world.enqueue({ type: "connect", player: me.id, from: hub.id, to: b.id });
    world.step();
    const h0 = hub.nutrients;
    runSeconds(world, 1);
    // in 3, out 6 → net -3, plus upkeep because it isn't sustained
    expect(hub.nutrients).toBeCloseTo(h0 - PIPE_RATE_PER_SEC - UPKEEP_PER_SEC);
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
  it("moves the buffer to a new colony and auto-connects parent → child", () => {
    const { world, me } = soloWorld();
    const parent = world.addColony(me.id, 0, 0, 200);
    world.enqueue({ type: "eject", player: me.id, from: parent.id, x: 100, y: 0 });
    world.step();
    const child = [...world.nodes.values()].find((n) => n !== parent)!;
    expect([...world.pipes.values()]).toMatchObject([{ from: parent.id, to: child.id }]);
    // Child is fed from the first step, so it's sustained and pays no upkeep.
    const pipeStep = PIPE_RATE_PER_SEC / SIM_HZ;
    const upkeepStep = UPKEEP_PER_SEC / SIM_HZ;
    expect(child.nutrients).toBeCloseTo(EJECT_BUFFER + pipeStep);
    expect(parent.nutrients).toBeCloseTo(200 - EJECT_BUFFER - pipeStep - upkeepStep);
  });

  it("still connects a child ejected at max reach, even though paying for it shrinks the parent's reach", () => {
    const { world, me } = soloWorld();
    const parent = world.addColony(me.id, 0, 0, 100);
    const edge = world.reachOf(parent) - 1;
    world.enqueue({ type: "eject", player: me.id, from: parent.id, x: edge, y: 0 });
    world.step();
    expect(world.reachOf(parent)).toBeLessThan(edge); // a separate connect would now fail…
    expect(world.pipes.size).toBe(1); // …but the auto-connect already happened
    runSeconds(world, 5);
    expect(world.pipes.size).toBe(1);
  });

  it("can't eject when the parent has no free output", () => {
    const { world, me } = soloWorld();
    const parent = world.addColony(me.id, 0, 0, 500);
    for (let i = 0; i < MAX_OUT_PIPES_PER_COLONY; i++) {
      const a = (i / MAX_OUT_PIPES_PER_COLONY) * Math.PI * 2;
      world.enqueue({ type: "eject", player: me.id, from: parent.id, x: Math.cos(a) * 100, y: Math.sin(a) * 100 });
    }
    world.step();
    expect(world.pipes.size).toBe(MAX_OUT_PIPES_PER_COLONY);
    expect(world.canEject(me.id, parent.id, { x: 70, y: 70 })).toEqual({
      ok: false,
      reason: "output limit reached",
    });
  });

  it("caps inputs and outputs separately", () => {
    const { world, me } = soloWorld();
    const hub = world.addColony(me.id, 0, 0, 500);
    const ring = (i: number, n: number, r: number) => {
      const a = (i / n) * Math.PI * 2 + 0.3;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    };
    // Fill every output…
    for (let i = 0; i < MAX_OUT_PIPES_PER_COLONY; i++) {
      world.enqueue({ type: "eject", player: me.id, from: hub.id, ...ring(i, MAX_OUT_PIPES_PER_COLONY, 100) });
    }
    world.step();
    // …and inputs are still all free.
    const sources = Array.from({ length: MAX_IN_PIPES_PER_COLONY + 1 }, (_, i) =>
      world.addFall(ring(i, MAX_IN_PIPES_PER_COLONY + 1, 200).x, ring(i, MAX_IN_PIPES_PER_COLONY + 1, 200).y, 500),
    );
    for (const s of sources.slice(0, MAX_IN_PIPES_PER_COLONY)) {
      expect(world.canConnect(me.id, s.id, hub.id).ok).toBe(true);
      world.enqueue({ type: "connect", player: me.id, from: s.id, to: hub.id });
    }
    world.step();
    expect(world.inCount(hub.id)).toBe(MAX_IN_PIPES_PER_COLONY);
    expect(world.outCount(hub.id)).toBe(MAX_OUT_PIPES_PER_COLONY);
    expect(world.canConnect(me.id, sources.at(-1)!.id, hub.id)).toEqual({
      ok: false,
      reason: "input limit reached",
    });
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
    // a has no inflow so still pays upkeep; b is being fed so it doesn't.
    expect(a.nutrients).toBeCloseTo(a0 - PIPE_RATE_PER_SEC - UPKEEP_PER_SEC);
    expect(b.nutrients).toBeCloseTo(b0 + PIPE_RATE_PER_SEC);
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

describe("walls", () => {
  // Rival at (0,0), me at (200,0). A wall from me with its crossbar at (100,0)
  // sits across the line between us.
  function standoff() {
    const { world, me } = soloWorld();
    const rival = world.addPlayer("rival", true);
    const mine = world.addColony(me.id, 200, 0, 300);
    const theirs = world.addColony(rival.id, 0, 0, 300);
    return { world, me, rival, mine, theirs };
  }

  it("crossbar blocks an opponent's hypha and costs the anchor colony", () => {
    const { world, me, rival, mine, theirs } = standoff();
    expect(world.canConnect(rival.id, mine.id, theirs.id).ok).toBe(true);
    world.enqueue({ type: "wall", player: me.id, from: mine.id, x: 100, y: 0 });
    world.step();
    expect(world.barriers.size).toBe(1);
    expect(mine.nutrients).toBeCloseTo(300 - WALL_COST - UPKEEP_PER_SEC / SIM_HZ);
    expect(world.canConnect(rival.id, mine.id, theirs.id)).toEqual({
      ok: false,
      reason: "no line of sight",
    });
  });

  it("only the crossbar blocks — lines that cross just the stem are fine", () => {
    const { world, me, mine } = standoff();
    world.enqueue({ type: "wall", player: me.id, from: mine.id, x: 100, y: 0 });
    world.step();
    // Both lines run along x=150, crossing the stem (y=0) but not the crossbar (x=100).
    const a = world.addFall(150, -80, 100);
    const c = world.addColony(me.id, 150, 70, 100);
    expect(world.hasLineOfSight(a, { x: 150, y: 80 })).toBe(true);
    expect(world.canConnect(me.id, a.id, c.id).ok).toBe(true);
  });

  it("severs an existing drain that crosses the new crossbar", () => {
    const { world, me, rival, mine, theirs } = standoff();
    world.enqueue({ type: "connect", player: rival.id, from: mine.id, to: theirs.id });
    world.step();
    expect(world.pipes.size).toBe(1);
    world.enqueue({ type: "wall", player: me.id, from: mine.id, x: 100, y: 0 });
    world.step();
    expect(world.pipes.size).toBe(0);
  });

  it("disappears with its colony and can be demolished only by its owner", () => {
    const { world, me, rival, mine } = standoff();
    world.enqueue({ type: "wall", player: me.id, from: mine.id, x: 100, y: 0 });
    world.step();
    const [wall] = world.barriers.values();
    expect(world.canDemolish(rival.id, wall.id).ok).toBe(false);
    mine.nutrients = 0.01;
    world.step();
    expect(world.barriers.size).toBe(0);
  });

  it("enforces the per-colony wall limit", () => {
    const { world, me, mine } = standoff();
    for (let i = 0; i < MAX_WALLS_PER_COLONY; i++) {
      world.enqueue({ type: "wall", player: me.id, from: mine.id, x: 300, y: -150 + i * 150 });
    }
    world.step();
    expect(world.barriers.size).toBe(MAX_WALLS_PER_COLONY);
    expect(world.canBuildWall(me.id, mine.id, { x: 200, y: 150 }).ok).toBe(false);
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
