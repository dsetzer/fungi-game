import { describe, expect, it } from "vitest";
import {
  BOOST_RESPAWN_SECONDS,
  BRANCH_OUT_PIPES,
  FALL_DRAIN_GAIN,
  FLOW_COOLDOWN_SECONDS,
  FLOW_SECONDS,
  MAX_OUT_PIPES_PER_COLONY,
  PIPE_RATE_PER_SEC,
  REACH_BONUS,
  SCISSORS_COOLDOWN_SECONDS,
  SIM_HZ,
  reach,
} from "../src/config";
import { emptyArena } from "../src/sim/arena";
import { stepMatch } from "../src/sim/match";
import type { BoostKind } from "../src/sim/types";
import { World } from "../src/sim/world";

function twoPlayers() {
  const world = new World(emptyArena(3000));
  const me = world.addPlayer("me", false);
  const rival = world.addPlayer("rival", false);
  // A home far away for each, so nobody is wiped out mid-test and the round runs on.
  world.endOnLastStanding = false;
  world.addColony(me.id, -2500, 0, 100_000);
  world.addColony(rival.id, 2500, 0, 100_000);
  return { world, me, rival };
}

function runSeconds(world: World, seconds: number) {
  for (let i = 0; i < Math.round(seconds * SIM_HZ); i++) world.step();
}

/** A boost already held by `player`: captured by feeding, feed then cut. */
function holding(world: World, player: number, kind: BoostKind, at = { x: 0, y: 300 }) {
  const boost = world.addBoost(at.x, at.y, kind);
  boost.owner = player;
  world.boostsChanged();
  return boost;
}

describe("boosts", () => {
  it("are captured by the first player to feed one", () => {
    const { world, me, rival } = twoPlayers();
    const boost = world.addBoost(0, 0, "reach");
    const mine = world.addColony(me.id, -200, 0, 300);
    const theirs = world.addColony(rival.id, 200, 0, 300);
    world.enqueue({ type: "connect", player: me.id, from: mine.id, to: boost.id });
    world.step();
    expect(boost.owner).toBe(me.id);
    // Feeding it afterwards doesn't take it over.
    world.enqueue({ type: "connect", player: rival.id, from: theirs.id, to: boost.id });
    runSeconds(world, 1);
    expect(boost.owner).toBe(me.id);
  });

  it("drain like a fall, neutral or held, and a rival drains a held one dry", () => {
    const { world, me, rival } = twoPlayers();
    const boost = world.addBoost(0, 0, "vision", 30);
    const taker = world.addColony(rival.id, 200, 0, 300);
    world.enqueue({ type: "connect", player: rival.id, from: boost.id, to: taker.id });
    world.step();
    expect(boost.nutrients).toBeCloseTo(30 - PIPE_RATE_PER_SEC / SIM_HZ);
    // Fed and sending nothing: sustained, so no upkeep.
    expect(taker.nutrients).toBeCloseTo(300 + (PIPE_RATE_PER_SEC / SIM_HZ) * FALL_DRAIN_GAIN);

    boost.owner = me.id;
    world.boostsChanged();
    runSeconds(world, 15);
    expect(world.nodes.has(boost.id)).toBe(false); // drained dry: gone
    expect(world.holds(me.id, "vision")).toBe(false);
  });

  it("pay upkeep once held, like a colony", () => {
    const { world, me } = twoPlayers();
    const neutral = world.addBoost(0, 0, "branch", 100);
    const held = holding(world, me.id, "branch");
    const was = held.nutrients;
    runSeconds(world, 2);
    expect(neutral.nutrients).toBe(100);
    expect(held.nutrients).toBeCloseTo(was - 2);
  });

  it("come back somewhere else after being depleted", () => {
    const { world } = twoPlayers();
    const boost = world.addBoost(0, 0, "flow", 1);
    boost.owner = 1;
    world.boostsChanged();
    runSeconds(world, 2);
    expect([...world.nodes.values()].some((n) => n.kind === "boost")).toBe(false);
    runSeconds(world, BOOST_RESPAWN_SECONDS);
    const back = [...world.nodes.values()].filter((n) => n.kind === "boost");
    expect(back.length).toBe(1);
    expect(back[0].owner).toBeNull();
  });

  it("go neutral when their holder is wiped out", () => {
    const world = new World(emptyArena(3000));
    const me = world.addPlayer("me", false);
    world.endOnLastStanding = false;
    const home = world.addColony(me.id, -2000, 0, 1);
    const boost = holding(world, me.id, "reach");
    runSeconds(world, 2);
    expect(world.nodes.has(home.id)).toBe(false);
    expect(boost.owner).toBeNull();
  });

  it("Branch doubles output slots", () => {
    const { world, me } = twoPlayers();
    const hub = world.addColony(me.id, 0, 0, 2000);
    const ring = (i: number) => ({ x: Math.cos(i * 0.6) * 150, y: Math.sin(i * 0.6) * 150 });
    for (let i = 0; i < MAX_OUT_PIPES_PER_COLONY; i++) world.enqueue({ type: "eject", player: me.id, from: hub.id, ...ring(i) });
    world.step();
    expect(world.canEject(me.id, hub.id, ring(MAX_OUT_PIPES_PER_COLONY))).toEqual({ ok: false, reason: "output limit reached" });
    holding(world, me.id, "branch", { x: 0, y: -600 });
    expect(world.outputCap(hub.id)).toBe(BRANCH_OUT_PIPES);
    expect(world.canEject(me.id, hub.id, ring(MAX_OUT_PIPES_PER_COLONY)).ok).toBe(true);
  });

  it("Reach adds to every colony's reach, past the cap", () => {
    const { world, me, rival } = twoPlayers();
    const rich = world.addColony(me.id, 0, 0, 5000);
    const theirs = world.addColony(rival.id, 0, 1000, 5000);
    holding(world, me.id, "reach", { x: 800, y: 0 });
    expect(world.reachOf(rich)).toBe(reach(5000) + REACH_BONUS);
    expect(world.reachOf(theirs)).toBe(reach(5000));
  });

  it("Vision widens what you see", () => {
    const { world, me } = twoPlayers();
    const c = world.addColony(me.id, 0, 0, 100);
    const before = world.visionOf(c);
    holding(world, me.id, "vision", { x: 800, y: 0 });
    expect(world.visionOf(c)).toBeGreaterThan(before);
  });

  it("Flow doubles your hyphae for its duration, then recharges", () => {
    const { world, me } = twoPlayers();
    const a = world.addColony(me.id, 0, 0, 500);
    const b = world.addColony(me.id, 200, 0, 500);
    holding(world, me.id, "flow", { x: 0, y: 600 });
    world.enqueue({ type: "connect", player: me.id, from: a.id, to: b.id });
    world.step();
    const normal = b.nutrients;
    world.step();
    const perStep = b.nutrients - normal;
    world.enqueue({ type: "flow", player: me.id });
    world.step();
    const x = b.nutrients;
    world.step();
    expect(b.nutrients - x).toBeCloseTo(perStep + PIPE_RATE_PER_SEC / SIM_HZ);
    expect(world.canFlow(me.id)).toEqual({ ok: false, reason: "Flow is recharging" });
    runSeconds(world, FLOW_SECONDS);
    expect(world.flowActive(me.id)).toBe(false);
    runSeconds(world, FLOW_COOLDOWN_SECONDS);
    expect(world.canFlow(me.id).ok).toBe(true);
  });

  it("Scissors cuts anyone's hypha, then recharges", () => {
    const { world, me, rival } = twoPlayers();
    const theirs = world.addColony(rival.id, 0, 0, 500);
    const other = world.addColony(rival.id, 200, 0, 500);
    world.enqueue({ type: "connect", player: rival.id, from: theirs.id, to: other.id });
    world.step();
    const pipe = world.pipeBetween(theirs.id, other.id)!;
    expect(world.canScissors(me.id, pipe.id).ok).toBe(false); // not held
    holding(world, me.id, "scissors", { x: 0, y: 600 });
    world.enqueue({ type: "scissors", player: me.id, pipe: pipe.id });
    world.step();
    expect(world.pipes.has(pipe.id)).toBe(false);
    world.enqueue({ type: "connect", player: rival.id, from: theirs.id, to: other.id });
    world.step();
    const again = world.pipeBetween(theirs.id, other.id)!;
    expect(world.canScissors(me.id, again.id)).toEqual({ ok: false, reason: "Scissors is recharging" });
    runSeconds(world, SCISSORS_COOLDOWN_SECONDS);
    expect(world.canScissors(me.id, again.id).ok).toBe(true);
  });

  it("are placed with a new match, away from every spawn", () => {
    const world = World.createMatch(7);
    const boosts = [...world.nodes.values()].filter((n) => n.kind === "boost");
    expect(boosts.length).toBeGreaterThan(0);
    for (const b of boosts) expect(b.owner).toBeNull();
  });

  it("bots capture a boost in reach", () => {
    const world = new World(emptyArena(3000));
    const bot = world.addPlayer("bot", true);
    world.addColony(bot.id, 0, 0, 400);
    const boost = world.addBoost(250, 0, "branch");
    for (let i = 0; i < 5 * SIM_HZ; i++) stepMatch(world);
    expect(boost.owner).toBe(bot.id);
  });
});
