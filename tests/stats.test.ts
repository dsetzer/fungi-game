import { describe, expect, it } from "vitest";
import { Room, type Member } from "../server/room";
import { PIPE_RATE_PER_SEC, SIM_HZ, UPKEEP_PER_SEC, WALL_COST } from "../src/config";
import { emptyArena } from "../src/sim/arena";
import { mergeStats, toStatsDTO, type PlayerStats, type StatsDTO } from "../src/sim/stats";
import { World } from "../src/sim/world";

function twoPlayers() {
  const world = new World(emptyArena(2000));
  const me = world.addPlayer("me", false);
  const rival = world.addPlayer("rival", false);
  return { world, me, rival, stats: (id: number) => world.stats.get(id)! };
}

const run = (world: World, seconds: number) => {
  for (let i = 0; i < seconds * SIM_HZ; i++) world.step();
};

describe("match stats", () => {
  it("tally gathering, draining and upkeep, and the score is what came in", () => {
    const { world, me, rival, stats } = twoPlayers();
    const mine = world.addColony(me.id, 0, 0, 500);
    const fall = world.addFall(150, 0, 5000);
    const theirs = world.addColony(rival.id, -200, 0, 500);
    world.enqueue({ type: "connect", player: me.id, from: fall.id, to: mine.id });
    world.enqueue({ type: "connect", player: rival.id, from: mine.id, to: theirs.id });
    run(world, 2);
    expect(stats(me.id).gathered).toBeCloseTo(PIPE_RATE_PER_SEC * 2, 3);
    expect(stats(rival.id).drained).toBeCloseTo(PIPE_RATE_PER_SEC * 2, 3);
    expect(stats(me.id).lost).toBeCloseTo(PIPE_RATE_PER_SEC * 2, 3);
    expect(me.score).toBeCloseTo(stats(me.id).gathered + stats(me.id).drained, 6);
    expect(stats(me.id).hyphae).toBe(1);
    // The rival's colony is fed (sustained), ours is fed but drained at the same rate.
    expect(stats(rival.id).upkeep).toBe(0);
  });

  it("charge upkeep to an unsustained colony, and count walls and throws", () => {
    const { world, me, rival, stats } = twoPlayers();
    const home = world.addColony(me.id, 0, 0, 900);
    world.addColony(rival.id, 800, 0, 500); // or the match is over at once
    world.enqueue({ type: "wall", player: me.id, from: home.id, x: 150, y: 0 });
    world.enqueue({ type: "eject", player: me.id, from: home.id, x: -150, y: 0 });
    run(world, 3);
    const s = stats(me.id);
    expect(s.wallsBuilt).toBe(1);
    expect(s.walls).toBe(WALL_COST);
    expect(s.throws).toBe(1);
    expect(s.upkeep).toBeGreaterThanOrEqual(UPKEEP_PER_SEC * 3 - 1e-6);
  });

  it("credit a kill to whoever was draining a colony when it ran dry", () => {
    const { world, me, rival, stats } = twoPlayers();
    const mine = world.addColony(me.id, 0, 0, 500);
    const theirs = world.addColony(rival.id, -200, 0, 5);
    world.addColony(rival.id, -400, 0, 500); // so the rival lives on
    world.enqueue({ type: "connect", player: me.id, from: theirs.id, to: mine.id });
    run(world, 2);
    expect(world.nodes.has(theirs.id)).toBe(false);
    expect(stats(me.id).kills).toBe(1);
    expect(stats(rival.id).coloniesLost).toBe(1);
  });

  it("sample once a second, and drop to zero when wiped out", () => {
    const { world, me, rival, stats } = twoPlayers();
    world.addColony(me.id, 0, 0, 2.5); // dies of upkeep in 2.5 s
    world.addColony(rival.id, 600, 0, 500);
    run(world, 4);
    const h = stats(me.id).history;
    expect(h.time).toEqual([1, 2, 2.5]);
    expect(h.held[h.held.length - 1]).toBe(0);
    expect(stats(me.id).deaths).toBe(1);
    expect(stats(me.id).diedAt).toBe(25);
    expect(stats(rival.id).history.time.length).toBeGreaterThan(0);
  });

  it("merge on the client from incremental slices", () => {
    const { world, me, rival, stats } = twoPlayers();
    world.addColony(me.id, 0, 0, 500);
    world.addColony(rival.id, 600, 0, 500);
    const client = new Map<number, PlayerStats>();
    run(world, 3);
    mergeStats(client, toStatsDTO(me.id, stats(me.id), 0));
    run(world, 2);
    mergeStats(client, toStatsDTO(me.id, stats(me.id), 3));
    expect(client.get(me.id)!.history.time).toEqual([1, 2, 3, 4, 5]);
    expect(client.get(me.id)!.upkeep).toBeCloseTo(stats(me.id).upkeep, 1);
  });
});

describe("stats over the wire", () => {
  const member = (name: string, spectator = false) => {
    const m: Member & { inbox: any[] } = { name, player: null, spectator, inbox: [], send: (msg) => m.inbox.push(msg) };
    return m;
  };
  const statsIn = (m: { inbox: any[] }): StatsDTO[] => m.inbox.filter((x) => x.t === "stats").flatMap((x) => x.stats);

  it("go to a player for themselves only, to a spectator for everyone, and to all at round end", () => {
    const room = new Room();
    const a = member("A");
    const b = member("B");
    const w = member("W", true);
    for (const m of [a, b, w]) room.members.add(m);
    room.join(a);
    room.join(b);
    for (let i = 0; i < 2 * SIM_HZ; i++) room.step();

    expect(new Set(statsIn(a).map((s) => s.id))).toEqual(new Set([a.player]));
    expect(new Set(statsIn(w).map((s) => s.id))).toEqual(new Set([a.player, b.player]));
    // Each send carries only what's new: one sample a second.
    expect(statsIn(a).map((s) => s.history.time.length)).toEqual([1, 1]);

    room.ticksLeft = 1;
    const before = a.inbox.length;
    room.step();
    const after = a.inbox.slice(before).filter((x) => x.t === "stats").flatMap((x) => x.stats);
    expect(new Set(after.map((s: StatsDTO) => s.id))).toEqual(new Set([a.player, b.player]));
    // B's history arrives whole, A's own only from where it left off.
    expect(after.find((s: StatsDTO) => s.id === b.player).from).toBe(0);
    expect(after.find((s: StatsDTO) => s.id === a.player).from).toBe(2);
  });
});
