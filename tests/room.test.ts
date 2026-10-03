import { describe, expect, it } from "vitest";
import { Room, type Member } from "../server/room";
import { VISION_MIN } from "../src/config";
import { dist } from "../src/sim/geometry";

function member(name: string): Member & { inbox: any[] } {
  const m = { name, player: null as number | null, inbox: [] as any[], send(msg: unknown) { m.inbox.push(msg); } };
  return m;
}

function joinRoom(room: Room, name: string) {
  const m = member(name);
  room.members.add(m);
  room.join(m);
  return m;
}

describe("server room", () => {
  it("spawns a joining player straight into the running round", () => {
    const room = new Room();
    const a = joinRoom(room, "A");
    expect(a.player).not.toBeNull();
    const mine = [...room.world.nodes.values()].filter((n) => n.owner === a.player);
    expect(mine).toHaveLength(1);
    expect(room.world.arena.isReachable(mine[0])).toBe(true);
  });

  it("sends each player only what they can see", () => {
    const room = new Room();
    const a = joinRoom(room, "A");
    const b = joinRoom(room, "B");
    const snap = room.snapshotFor(a.player!);
    const eyes = [...room.world.nodes.values()].filter((n) => n.owner === a.player);
    for (const n of snap.nodes) {
      if (n.o === a.player) continue;
      const visible = eyes.some((e) => dist(e.x, e.y, n.x, n.y) <= Math.max(VISION_MIN, room.world.reachOf(e)) * 1.2);
      expect(visible, `node ${n.i} should not have been sent`).toBe(true);
    }
    // B's colony is only in the snapshot if A can actually see it.
    const bNodes = [...room.world.nodes.values()].filter((n) => n.owner === b.player);
    for (const bn of bNodes) {
      const sent = snap.nodes.some((n) => n.i === bn.id);
      const seen = eyes.some((e) => dist(e.x, e.y, bn.x, bn.y) <= Math.max(VISION_MIN, room.world.reachOf(e) * 1.15));
      expect(sent).toBe(seen);
    }
  });

  it("respawns a player whose network is wiped out", () => {
    const room = new Room();
    const a = joinRoom(room, "A");
    for (const n of [...room.world.nodes.values()]) {
      if (n.owner === a.player) room.world.nodes.delete(n.id);
    }
    room.step();
    const mine = [...room.world.nodes.values()].filter((n) => n.owner === a.player);
    expect(mine).toHaveLength(1);
    expect(room.intermission).toBe(false);
  });

  it("ends the round on the timer, then starts a fresh one", () => {
    const room = new Room();
    const a = joinRoom(room, "A");
    const firstArena = room.world.arena;
    a.inbox.length = 0;

    room.ticksLeft = 1;
    room.step();
    expect(room.intermission).toBe(true);
    const ended = a.inbox.at(-1);
    expect(ended.t).toBe("round");
    expect(ended.round.intermission).toBe(true);
    expect(ended.winner).not.toBeNull();

    room.ticksLeft = 1;
    room.step();
    expect(room.intermission).toBe(false);
    expect(room.world.arena).not.toBe(firstArena); // regenerated
    expect([...room.world.nodes.values()].filter((n) => n.owner === a.player)).toHaveLength(1);
  });

  it("ranks by nutrients gathered and clears scores between rounds", () => {
    const room = new Room();
    const a = joinRoom(room, "A");
    const b = joinRoom(room, "B");
    room.world.player(a.player!)!.score = 500;
    room.world.player(b.player!)!.score = 900;
    room.ticksLeft = 1;
    room.step();
    expect(a.inbox.at(-1).winner.name).toBe("B");

    room.ticksLeft = 1;
    room.step();
    expect(room.world.players.every((p) => p.score === 0)).toBe(true);
  });

  it("ignores a client claiming to be someone else", () => {
    const room = new Room();
    const a = joinRoom(room, "A");
    const b = joinRoom(room, "B");
    const victim = [...room.world.nodes.values()].find((n) => n.owner === b.player)!;
    // A sends a command stamped with B's id: the room must re-stamp it as A.
    room.command(a, { type: "eject", player: b.player!, from: victim.id, x: victim.x + 60, y: victim.y });
    room.step();
    const spawned = [...room.world.nodes.values()].filter((n) => n.owner === b.player);
    expect(spawned).toHaveLength(1); // B gained nothing from A's forged command
  });
});

describe("spectators", () => {
  function spectator(room: Room) {
    const m = { ...member("Watcher"), spectator: true };
    m.send = (msg: unknown) => m.inbox.push(msg);
    room.members.add(m);
    return m;
  }

  it("see the whole arena, fog-free", () => {
    const room = new Room();
    joinRoom(room, "A");
    const snap = room.snapshotFor(null);
    expect(snap.nodes).toHaveLength(room.world.nodes.size);
    expect(snap.pipes).toHaveLength(room.world.pipes.size);
  });

  it("get no colony, not even when a new round starts, and don't count as players", () => {
    const room = new Room();
    joinRoom(room, "A");
    const w = spectator(room);
    room.startRound();
    expect(w.player).toBeNull();
    const owners = new Set([...room.world.nodes.values()].map((n) => n.owner));
    expect(owners.has(null)).toBe(true); // falls
    expect(room.playerCount).toBe(1);
    expect(room.snapshotFor(null).online).toBe(1);
  });

  it("can't issue commands", () => {
    const room = new Room();
    const w = spectator(room);
    const before = room.world.nodes.size;
    room.command(w, { type: "eject", player: 1, from: 1, x: 0, y: 0 });
    room.step();
    expect(room.world.nodes.size).toBeLessThanOrEqual(before);
  });
});

describe("server map", () => {
  it("starts each round with neutral falls scattered, the count respawning tops up to", () => {
    const room = new Room();
    const falls = () => [...room.world.nodes.values()].filter((n) => n.kind === "fall").length;
    expect(room.world.fallTarget).toBeGreaterThan(20);
    expect(falls()).toBe(room.world.fallTarget);
  });
});
