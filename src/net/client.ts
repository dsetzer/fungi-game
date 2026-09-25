import { decode, encode, type PlayerDTO, type ServerMsg, type Snapshot } from "./protocol";
import { generateArena } from "../sim/arena";
import type { Command, PlayerId } from "../sim/types";
import { World } from "../sim/world";

export type Status = "connecting" | "playing" | "intermission" | "offline";

/**
 * Client side of multiplayer. The server owns the simulation; this keeps a local
 * World that is *filled from snapshots* rather than stepped, so the renderer and
 * input work unchanged. Terrain is rebuilt locally from the round's seed.
 *
 * Nutrient falls seen earlier are kept after they leave vision (fog of war
 * remembers static things), and marked stale so the renderer can dim them.
 */
export class NetClient {
  world: World | null = null;
  you: PlayerId = 0;
  status: Status = "connecting";
  players: PlayerDTO[] = [];
  endsIn = 0;
  online = 0;
  winner: PlayerDTO | null = null;
  /** Ids of falls being drawn from memory rather than current sight. */
  readonly remembered = new Set<number>();
  onRound: (() => void) | null = null;
  /** Called when the connection drops (or never opened) — play solo meanwhile. */
  onOffline: (() => void) | null = null;
  /** Called once the server has accepted us, so solo play can stop. */
  onOnline: (() => void) | null = null;

  private socket: WebSocket | null = null;
  private retry = 0;

  constructor(private url: string, private name: string) {}

  /** Connects, and keeps trying: servers restart, laptops sleep, wifi drops. */
  connect(): void {
    let closed = false;
    const dropped = () => {
      if (closed) return;
      closed = true;
      this.socket = null;
      this.world = null;
      this.status = "offline";
      this.onOffline?.();
      // Back off to 8s so a server that's down doesn't get hammered.
      this.retry = Math.min(8000, this.retry ? this.retry * 2 : 1000);
      setTimeout(() => this.connect(), this.retry);
    };
    try {
      this.socket = new WebSocket(this.url);
    } catch {
      dropped();
      return;
    }
    this.socket.onopen = () => {
      this.retry = 0;
      this.send({ t: "hello", name: this.name, version: 1 });
    };
    this.socket.onerror = dropped;
    this.socket.onclose = dropped;
    this.socket.onmessage = (e) => {
      const msg = decode<ServerMsg>(String(e.data));
      if (msg) this.handle(msg);
    };
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Player input goes to the server; nothing is applied locally. */
  enqueue(cmd: Command): void {
    this.send({ t: "cmd", cmd });
  }

  private send(msg: unknown): void {
    if (this.connected) this.socket!.send(encode(msg as never));
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case "welcome":
        this.you = msg.you;
        this.players = msg.players;
        this.newRound(msg.round.seed, msg.round.arenaPlayers, msg.round.radius);
        this.status = "playing";
        this.onOnline?.();
        return;
      case "round":
        this.players = msg.players;
        this.winner = msg.winner;
        this.status = msg.round.intermission ? "intermission" : "playing";
        this.endsIn = msg.round.endsIn;
        if (!msg.round.intermission) {
          this.newRound(msg.round.seed, msg.round.arenaPlayers, msg.round.radius);
          this.onRound?.();
        }
        return;
      case "snap":
        this.applySnapshot(msg);
        return;
      case "error":
        console.warn("server:", msg.message);
        return;
    }
  }

  private newRound(seed: number, arenaPlayers: number, radius: number): void {
    this.world = new World(generateArena(seed, arenaPlayers, radius), seed);
    this.world.endOnLastStanding = false;
    this.remembered.clear();
  }

  /** Rebuilds the visible world from a snapshot, keeping remembered falls. */
  private applySnapshot(snap: Snapshot): void {
    const world = this.world;
    if (!world) return;
    this.players = snap.players;
    this.endsIn = snap.endsIn;
    this.online = snap.online;
    this.status = "playing";

    const keep = new Set<number>();
    for (const n of snap.nodes) {
      keep.add(n.i);
      this.remembered.delete(n.i);
      const existing = world.nodes.get(n.i);
      if (existing) {
        Object.assign(existing, { x: n.x, y: n.y, nutrients: n.n, rate: n.r, owner: n.o });
      } else {
        world.nodes.set(n.i, {
          id: n.i,
          kind: n.k === 1 ? "fall" : "colony",
          owner: n.o,
          x: n.x,
          y: n.y,
          nutrients: n.n,
          rate: n.r,
          seed: n.s,
        });
      }
    }
    // Anything no longer sent has left sight: keep falls as memory, drop the rest.
    for (const [id, node] of world.nodes) {
      if (keep.has(id)) continue;
      if (node.kind === "fall") this.remembered.add(id);
      else world.nodes.delete(id);
    }

    world.pipes.clear();
    for (const p of snap.pipes) world.pipes.set(p.i, { id: p.i, from: p.f, to: p.t, owner: p.o });
    world.barriers.clear();
    for (const b of snap.barriers) {
      world.barriers.set(b.i, {
        id: b.i, owner: b.o, anchor: b.a, x: b.x, y: b.y,
        a: { x: b.ax, y: b.ay }, b: { x: b.bx, y: b.by },
      });
    }

    // Keep the local player list in sync so colours and names resolve. Kept dense:
    // server ids don't start at 1, and holes would break anything iterating it.
    world.players.length = 0;
    for (const p of snap.players) {
      world.players.push({
        id: p.id, name: p.name, color: p.color, isBot: false, alive: p.alive, score: p.score,
      });
    }
    world.tick = snap.tick;
  }
}
