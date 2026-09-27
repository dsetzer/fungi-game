import { describe, expect, it } from "vitest";
import {
  ATTACK_RATE_BASE,
  DT,
  EJECT_FRACTION_DEFAULT,
  EJECT_MIN_AMOUNT,
  FALL_DRAIN_GAIN,
  FALL_YIELD_PER_SEC,
  MAX_OUT_PIPES_PER_COLONY,
  MAX_WALLS_PER_COLONY,
  NODE_SPACING,
  PIPE_RATE_PER_SEC,
  SIM_HZ,
  START_NUTRIENTS,
  UPKEEP_PER_SEC,
  WALL_COST,
  attackRate,
  reach,
} from "../src/config";
import { emptyArena } from "../src/sim/arena";
import { dist } from "../src/sim/geometry";
import { spawnInto } from "../src/sim/spawn";
import { World } from "../src/sim/world";

const openArena = (walls: Parameters<typeof emptyArena>[1] = []) => emptyArena(2000, walls);

function soloWorld(walls: Parameters<typeof emptyArena>[1] = [], radius = 2000) {
  const world = new World(emptyArena(radius, walls));
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

  it("gives a colony more than the fall loses when draining it", () => {
    const { world, me } = soloWorld();
    const fall = world.addFall(-120, 0, 500);
    const c = world.addColony(me.id, 0, 0, 100);
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: c.id });
    world.step();
    const f0 = fall.nutrients;
    const c0 = c.nutrients;
    runSeconds(world, 1);
    expect(f0 - fall.nutrients).toBeCloseTo(PIPE_RATE_PER_SEC);
    expect(c.nutrients - c0).toBeCloseTo(PIPE_RATE_PER_SEC * FALL_DRAIN_GAIN);
  });

  it("waives upkeep for a relay that passes on what it receives", () => {
    const { world, me } = soloWorld();
    // Fed by a colony, so the flow in is 1:1 with the flow out.
    const fall = world.addColony(me.id, -120, 0, 5000);
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
    // Fed at 6/s by the fall, drained at 9/s by three rival hyphae.
    const rivals = [
      world.addColony(rival.id, 120, 0, 100),
      world.addColony(rival.id, 0, 120, 100),
      world.addColony(rival.id, 0, -120, 100),
    ];
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: victim.id });
    for (const r of rivals) {
      world.enqueue({ type: "connect", player: rival.id, from: victim.id, to: r.id });
    }
    world.step();
    expect(world.pipes.size).toBe(4);
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
    const fall = world.addColony(me.id, -120, 0, 5000); // colony source: 1:1
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
    const carried = 200 * EJECT_FRACTION_DEFAULT;
    expect(child.nutrients).toBeCloseTo(carried + pipeStep);
    expect(parent.nutrients).toBeCloseTo(200 - carried - pipeStep - upkeepStep);
  });

  it("carries a share of the parent, so a rich colony throws a strong child", () => {
    const { world, me } = soloWorld();
    const rich = world.addColony(me.id, 0, 0, 800);
    const poor = world.addColony(me.id, 900, 0, 120);
    world.enqueue({ type: "eject", player: me.id, from: rich.id, x: 300, y: 0 });
    world.enqueue({ type: "eject", player: me.id, from: poor.id, x: 1200, y: 0 });
    world.step();
    const kids = [...world.nodes.values()].filter((n) => n !== rich && n !== poor);
    const [richKid, poorKid] = kids.sort((a, b) => b.nutrients - a.nutrients);
    expect(richKid.nutrients).toBeGreaterThan(poorKid.nutrients * 3);
  });

  it("lets a throw chain onward without stopping to refill", () => {
    const { world, me } = soloWorld([], 9000);
    let tip = world.addColony(me.id, 0, 0, 800);
    const start = { x: tip.x, y: tip.y };
    // Throw as far as reach allows, then immediately throw again from the new tip.
    for (let hop = 0; hop < 4; hop++) {
      const step = world.reachOf(tip) - 10;
      const target = { x: tip.x + step, y: tip.y };
      expect(world.canEject(me.id, tip.id, target).ok, `hop ${hop}`).toBe(true);
      world.enqueue({ type: "eject", player: me.id, from: tip.id, ...target });
      world.step();
      tip = [...world.nodes.values()].reduce((far, n) => (n.x > far.x ? n : far), tip);
    }
    // Four hops without pausing should cover real ground.
    expect(tip.x - start.x).toBeGreaterThan(1400);
    expect(tip.nutrients).toBeGreaterThan(EJECT_MIN_AMOUNT);
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
    const parent = world.addColony(me.id, 0, 0, 5000);
    for (let i = 0; i < MAX_OUT_PIPES_PER_COLONY; i++) {
      const a = (i / MAX_OUT_PIPES_PER_COLONY) * Math.PI * 2;
      world.enqueue({ type: "eject", player: me.id, from: parent.id, x: Math.cos(a) * 100, y: Math.sin(a) * 100, fraction: 0.15 });
    }
    world.step();
    expect(world.pipes.size).toBe(MAX_OUT_PIPES_PER_COLONY);
    expect(world.canEject(me.id, parent.id, { x: 70, y: 70 })).toEqual({
      ok: false,
      reason: "output limit reached",
    });
  });

  it("caps outputs but accepts any number of inputs", () => {
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
    expect(world.canEject(me.id, hub.id, { x: 0, y: -60 }).ok).toBe(false);
    // …and it still takes in as many feeds as you bring it.
    const feeds = 10;
    for (let i = 0; i < feeds; i++) {
      const p = ring(i, feeds, 200);
      const fall = world.addFall(p.x, p.y, 500);
      world.enqueue({ type: "connect", player: me.id, from: fall.id, to: hub.id });
    }
    world.step();
    expect(world.inCount(hub.id)).toBe(feeds);
    expect(world.outCount(hub.id)).toBe(MAX_OUT_PIPES_PER_COLONY);
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

  it("refuses a hypha that would cross an existing one, whoever grew it", () => {
    const { world, me } = soloWorld();
    const rival = world.addPlayer("rival", true);
    // Long enough that the rival's territory sits well clear of the crossing.
    const left = world.addColony(rival.id, -400, 0, 1000);
    const right = world.addColony(rival.id, 400, 0, 1000);
    world.enqueue({ type: "connect", player: rival.id, from: left.id, to: right.id });
    world.step();
    const top = world.addColony(me.id, 0, 100, 200);
    const bottom = world.addColony(me.id, 0, -100, 200);
    expect(world.canConnect(me.id, top.id, bottom.id)).toEqual({ ok: false, reason: "crosses a hypha" });
  });

  it("can't eject across a hypha, since ejecting grows one", () => {
    const { world, me } = soloWorld();
    const left = world.addColony(me.id, -100, 0, 200);
    const right = world.addColony(me.id, 100, 0, 200);
    world.enqueue({ type: "connect", player: me.id, from: left.id, to: right.id });
    world.step();
    const top = world.addColony(me.id, 0, 100, 200);
    expect(world.canEject(me.id, top.id, { x: 0, y: -60 })).toEqual({ ok: false, reason: "crosses a hypha" });
    expect(world.canEject(me.id, top.id, { x: 60, y: 160 }).ok).toBe(true);
  });

  it("lets hyphae meet at a shared colony", () => {
    const { world, me } = soloWorld();
    const hub = world.addColony(me.id, 0, 0, 200);
    const a = world.addColony(me.id, 120, 0, 200);
    const b = world.addColony(me.id, 0, 120, 200);
    world.enqueue({ type: "connect", player: me.id, from: hub.id, to: a.id });
    world.step();
    expect(world.canConnect(me.id, hub.id, b.id).ok).toBe(true);
    expect(world.canConnect(me.id, a.id, b.id).ok).toBe(true);
  });

  it("reverses a hypha in place, flipping which way nutrients move", () => {
    const { world, me } = soloWorld();
    const a = world.addColony(me.id, 0, 0, 200);
    const b = world.addColony(me.id, 120, 0, 200);
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: b.id });
    world.step();
    const [pipe] = world.pipes.values();
    runSeconds(world, 1);
    expect(b.rate).toBeGreaterThan(0); // b is receiving

    world.enqueue({ type: "reverse", player: me.id, pipe: pipe.id });
    world.step();
    runSeconds(world, 1);
    expect(world.pipes.size).toBe(1);
    expect([...world.pipes.values()][0].id).toBe(pipe.id); // same hypha, flipped
    expect(pipe.from).toBe(b.id);
    expect(pipe.to).toBe(a.id);
    expect(a.rate).toBeGreaterThan(0); // now a receives
    expect(b.rate).toBeLessThan(0);
  });

  it("only the player who grew a hypha may reverse it", () => {
    const { world, me } = soloWorld();
    const rival = world.addPlayer("rival", true);
    const mine = world.addColony(me.id, 0, 0, 200);
    const theirs = world.addColony(rival.id, 120, 0, 200);
    // The rival drains me: their hypha, out of my colony.
    world.enqueue({ type: "connect", player: rival.id, from: mine.id, to: theirs.id });
    world.step();
    const [pipe] = world.pipes.values();
    expect(world.canReverse(me.id, pipe.id)).toEqual({ ok: false, reason: "not your hypha" });
    // Nor can I cut it: the hypha is theirs, wherever its ends are. Being drained
    // is answered by killing the colony on the far end, not by snipping the line.
    expect(world.canCut(me.id, pipe.id)).toEqual({ ok: false, reason: "not your hypha" });
    expect(world.canCut(rival.id, pipe.id).ok).toBe(true);
  });

  it("keeps rivals out of a colony's blob, but not out of a fall's", () => {
    const { world, me } = soloWorld([], 4000);
    const rival = world.addPlayer("rival", true);
    const giant = world.addColony(rival.id, 0, 0, 25_000);
    const blob = world.auraOf(giant);
    // Modest enough that my own blob doesn't cover the target - my territory is
    // mine to build in, so it would mask what this test is checking.
    const mine = world.addColony(me.id, blob + 300, 0, 900);
    // Well within my reach, but inside their territory.
    const inside = { x: blob * 0.5, y: 0 };
    expect(dist(mine.x, mine.y, inside.x, inside.y)).toBeLessThan(world.reachOf(mine));
    expect(world.canEject(me.id, mine.id, inside)).toEqual({
      ok: false, reason: "inside rival territory",
    });
    // Just outside the blob is fair ground.
    expect(world.canEject(me.id, mine.id, { x: blob + 40, y: 0 }).ok).toBe(true);
    // Their own territory is theirs to build in.
    expect(world.canEject(rival.id, giant.id, inside).ok).toBe(true);
    // A neutral fall holds no territory, or the best ground would be unplantable.
    const fall = world.addFall(-1500, 0, 5000);
    const byFall = { x: -1500 + world.auraOf(fall) * 0.5, y: 0 };
    const near = world.addColony(me.id, -1500 + world.auraOf(fall) + 200, 0, 4000);
    expect(world.canEject(me.id, near.id, byFall).ok).toBe(true);
  });

  it("refuses to reverse when the new source has no free output", () => {
    const { world, me } = soloWorld();
    const hub = world.addColony(me.id, 0, 0, 900);
    const feeder = world.addColony(me.id, -150, 0, 900);
    world.enqueue({ type: "connect", player: me.id, from: feeder.id, to: hub.id });
    for (let i = 0; i < MAX_OUT_PIPES_PER_COLONY; i++) {
      // Offset the ring so no child lands on the feeder colony at (-150, 0).
      const a = (i / MAX_OUT_PIPES_PER_COLONY) * Math.PI * 2 + 0.5;
      world.enqueue({ type: "eject", player: me.id, from: hub.id, x: Math.cos(a) * 150, y: Math.sin(a) * 150 });
    }
    world.step();
    const feed = [...world.pipes.values()].find((p) => p.from === feeder.id)!;
    expect(world.outCount(hub.id)).toBe(MAX_OUT_PIPES_PER_COLONY);
    expect(world.canReverse(me.id, feed.id)).toEqual({ ok: false, reason: "output limit reached" });
  });

  it("can reverse a hypha that is now longer than the colony's reach", () => {
    const { world, me } = soloWorld();
    const a = world.addColony(me.id, 0, 0, 900);
    const b = world.addColony(me.id, world.reachOf(a) - 5, 0, 20);
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: b.id });
    world.step();
    const [pipe] = world.pipes.values();
    a.nutrients = 30; // shrivelled: the hypha now out-reaches both ends
    expect(world.canConnect(me.id, b.id, a.id).ok).toBe(false);
    expect(world.canReverse(me.id, pipe.id).ok).toBe(true);
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
  it("leaves hyphae already crossing it alone, but blocks new ones", () => {
    const { world, me } = soloWorld([], 4000);
    const a = world.addColony(me.id, -200, 0, 900);
    const b = world.addColony(me.id, 200, 0, 900);
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: b.id });
    world.step();
    expect(world.pipes.size).toBe(1);

    // The crossbar is perpendicular to its stem, so to block the a-b line the stem
    // has to run *along* it: anchor out to one side and wall at the midpoint.
    const anchorNode = world.addColony(me.id, -600, 0, 900);
    world.enqueue({ type: "wall", player: me.id, from: anchorNode.id, x: 0, y: 0 });
    world.step();
    expect(world.barriers.size).toBe(1);
    // The established hypha survives - walling over your own lines is the tactic.
    expect(world.pipes.size).toBe(1);
    // But nothing new can be run across it.
    const c = world.addColony(me.id, -200, 60, 900);
    expect(world.canConnect(me.id, c.id, b.id)).toEqual({ ok: false, reason: "no line of sight" });
  });

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

  it("does not sever a drain already crossing the new crossbar", () => {
    const { world, me, rival, mine, theirs } = standoff();
    world.enqueue({ type: "connect", player: rival.id, from: mine.id, to: theirs.id });
    world.step();
    expect(world.pipes.size).toBe(1);
    world.enqueue({ type: "wall", player: me.id, from: mine.id, x: 100, y: 0 });
    world.step();
    expect(world.barriers.size).toBe(1);
    // Walling an established line does not cut it - a wall denies new ground, it
    // is not a delete button for connections that already exist.
    expect(world.pipes.size).toBe(1);
    // It does stop them running another one across.
    const second = world.addColony(rival.id, theirs.x, theirs.y + 40, 200);
    expect(world.canConnect(rival.id, mine.id, second.id)).toEqual({
      ok: false, reason: "no line of sight",
    });
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

  it("always spawns a joining player with food in reach", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const world = World.createMatch(seed);
      world.endOnLastStanding = false;
      // Food must be comfortably inside reach: reach shrinks as a colony starves.
      const startReach = reach(START_NUTRIENTS) * 0.75;
      // Twelve joiners dropping into a live round, one after another.
      for (let i = 0; i < 12; i++) {
        const player = world.addPlayer(`joiner${i}`, false);
        const home = spawnInto(world, player);
        const fed = [...world.nodes.values()].some(
          (n) =>
            n.kind === "fall" &&
            dist(n.x, n.y, home.x, home.y) <= startReach &&
            world.hasLineOfSight(home, n),
        );
        expect(fed, `seed ${seed} joiner ${i} at ${Math.round(home.x)},${Math.round(home.y)}`).toBe(true);
        expect(world.arena.isReachable(home)).toBe(true);
      }
    }
  });

  it("leaves no open ground cut off from the main cave", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const world = World.createMatch(seed);
      const { arena } = world;
      // Sample the map on a grid; every spot a colony could physically occupy
      // must be reachable from the main cave system.
      const step = 120;
      const orphans: string[] = [];
      for (let y = -arena.radius; y <= arena.radius; y += step) {
        for (let x = -arena.radius; x <= arena.radius; x += step) {
          const p = { x, y };
          if (Math.hypot(x, y) > arena.radius - step) continue;
          if (arena.index.discBlocks(p, NODE_SPACING)) continue; // solid rock
          // Ignore crevices between wall circles (< 90 units of clear space, i.e.
          // under one terrain cell). They sit against open caves and can still be
          // ejected into by line of sight; only real rooms must be connected.
          if (arena.index.discBlocks(p, 90)) continue;
          if (!arena.isReachable(p)) orphans.push(`${x},${y}`);
        }
      }
      expect(orphans.slice(0, 5), `seed ${seed}`).toEqual([]);
      for (const s of arena.spawns) expect(arena.isReachable(s), `seed ${seed} spawn`).toBe(true);
    }
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

describe("draining a rival", () => {
  /** Me, a rival, and whatever each of us is holding. */
  function duel(mine: number, theirs: number) {
    const world = new World(emptyArena(2000));
    world.endOnLastStanding = false;
    const me = world.addPlayer("me", false);
    const foe = world.addPlayer("foe", true);
    const attacker = world.addColony(me.id, 0, 0, mine);
    const victim = world.addColony(foe.id, 200, 0, theirs);
    return { world, me, foe, attacker, victim };
  }

  it("pulls at the attacker's attack rate, not the flat pipe rate", () => {
    const { world, me, attacker, victim } = duel(100, 500);
    const rate = attackRate(100);
    expect(rate).toBeGreaterThan(PIPE_RATE_PER_SEC * FALL_DRAIN_GAIN); // worth doing at all
    world.enqueue({ type: "connect", player: me.id, from: victim.id, to: attacker.id });
    world.step(); // the command lands and one tick flows, both at the starting stores
    // The victim pays upkeep too: nothing is feeding it. The attacker has inflow
    // and sends nothing on, so it is sustained and pays none.
    expect(victim.nutrients).toBeCloseTo(500 - (rate + UPKEEP_PER_SEC) * DT, 6);
    expect(attacker.nutrients).toBeCloseTo(100 + rate * DT, 6);
  });

  it("takes exactly what the victim loses — attacking can't print nutrients", () => {
    const { world, me, attacker, victim } = duel(100, 500);
    world.enqueue({ type: "connect", player: me.id, from: victim.id, to: attacker.id });
    world.step();
    const before = attacker.nutrients + victim.nutrients;
    runSeconds(world, 5);
    // Only the victim pays upkeep; everything else just moves across.
    expect(attacker.nutrients + victim.nutrients).toBeCloseTo(before - UPKEEP_PER_SEC * 5, 4);
  });

  it("out-paces a victim living off a fall, and kills it", () => {
    const { world, me, attacker, victim } = duel(100, 400);
    const fall = world.addFall(400, 0, 100_000);
    world.enqueue({ type: "connect", player: 2, from: fall.id, to: victim.id });
    world.enqueue({ type: "connect", player: me.id, from: victim.id, to: attacker.id });
    world.step();
    expect(attackRate(attacker.nutrients)).toBeGreaterThan(PIPE_RATE_PER_SEC * FALL_DRAIN_GAIN);
    runSeconds(world, 120);
    expect(world.nodes.has(victim.id)).toBe(false);
  });

  it("scales with the attacker: a bigger colony rips harder", () => {
    expect(attackRate(900)).toBeGreaterThan(attackRate(100));
    expect(attackRate(0)).toBeCloseTo(ATTACK_RATE_BASE);
  });

  it("can attack a colony that has spent all its own output slots", () => {
    const { world, me, foe, attacker, victim } = duel(100, 600);
    for (let i = 0; i < MAX_OUT_PIPES_PER_COLONY; i++) {
      const leaf = world.addColony(foe.id, 260 + i * 60, 200, 50);
      world.enqueue({ type: "connect", player: foe.id, from: victim.id, to: leaf.id });
    }
    world.step();
    expect(world.ownOutCount(victim.id)).toBe(MAX_OUT_PIPES_PER_COLONY);
    expect(world.canConnect(me.id, victim.id, attacker.id).ok).toBe(true);
  });

  it("a rival's drain line doesn't consume the victim's own output budget", () => {
    const { world, me, foe, attacker, victim } = duel(100, 600);
    world.enqueue({ type: "connect", player: me.id, from: victim.id, to: attacker.id });
    world.step();
    expect(world.outCount(victim.id)).toBe(1);
    expect(world.ownOutCount(victim.id)).toBe(0);
    // Still free to grow its own network while under attack.
    expect(world.canEject(foe.id, victim.id, { x: 200, y: -150 }).ok).toBe(true);
  });
});

describe("sustaining a fall", () => {
  /** A → fall → B → A: the feedback loop that turns a fall into passive income. */
  function loop(pool: number) {
    const world = new World(emptyArena(2000));
    world.endOnLastStanding = false;
    const me = world.addPlayer("me", false);
    const foe = world.addPlayer("foe", true);
    const a = world.addColony(me.id, 0, 0, 100);
    const b = world.addColony(me.id, 0, 200, 100);
    const fall = world.addFall(200, 100, pool);
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: fall.id });
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: b.id });
    world.enqueue({ type: "connect", player: me.id, from: b.id, to: a.id });
    world.step();
    return { world, me, foe, a, b, fall };
  }

  const mine = (world: World, ...ids: number[]) =>
    ids.reduce((t, id) => t + (world.nodes.get(id)?.nutrients ?? 0), 0);

  it("holds the pool flat and pays the difference between what goes in and out", () => {
    const { world, a, b, fall } = loop(200);
    const before = mine(world, a.id, b.id);
    runSeconds(world, 30);
    expect(fall.nutrients).toBeCloseTo(200, 4); // neither depleting nor filling
    // Three out, four in: the loop nets the difference, and nothing in the ring
    // pays upkeep because every node's inflow covers what it sends on.
    const net = FALL_YIELD_PER_SEC - PIPE_RATE_PER_SEC;
    expect(mine(world, a.id, b.id) - before).toBeCloseTo(net * 30, 3);
  });

  it("is small enough that the loop only just covers a colony's upkeep", () => {
    expect(FALL_YIELD_PER_SEC - PIPE_RATE_PER_SEC).toBe(UPKEEP_PER_SEC);
  });

  it("can be raided: a rival's drain line empties the fall for good", () => {
    const { world, foe, fall } = loop(200);
    const raider = world.addColony(foe.id, 400, 100, 100);
    world.enqueue({ type: "connect", player: foe.id, from: fall.id, to: raider.id });
    world.step();
    // The fall now sends out more than I feed it, so it bleeds the difference.
    runSeconds(world, 200);
    expect(world.nodes.has(fall.id)).toBe(false);
  });

  it("does not let a ring of colonies alone print anything", () => {
    const world = new World(emptyArena(2000));
    world.endOnLastStanding = false;
    const me = world.addPlayer("me", false);
    const ring = [0, 1, 2].map((i) =>
      world.addColony(me.id, Math.cos((i * Math.PI * 2) / 3) * 150, Math.sin((i * Math.PI * 2) / 3) * 150, 100),
    );
    ring.forEach((n, i) =>
      world.enqueue({ type: "connect", player: me.id, from: n.id, to: ring[(i + 1) % 3].id }),
    );
    world.step();
    const before = mine(world, ...ring.map((n) => n.id));
    runSeconds(world, 60);
    expect(mine(world, ...ring.map((n) => n.id))).toBeLessThanOrEqual(before + 1e-6);
  });
});
