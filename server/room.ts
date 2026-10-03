import {
  BOOST_START,
  INTERMISSION_SECONDS,
  ROUND_SECONDS,
  SIM_HZ,
  radiusForPlayers,
} from "../src/config";
import type {
  BarrierDTO,
  NodeDTO,
  PipeDTO,
  PlayerDTO,
  RoundInfo,
  Snapshot,
} from "../src/net/protocol";
import { generateArena } from "../src/sim/arena";
import { runBot } from "../src/sim/bot";
import { spawnInto } from "../src/sim/spawn";
import { toStatsDTO, type StatsDTO } from "../src/sim/stats";
import type { Command, Player, PlayerId } from "../src/sim/types";
import { visibleNodes } from "../src/sim/vision";
import { World } from "../src/sim/world";

/** Minimum arena size, so a one-player round isn't a postage stamp. */
const MIN_ARENA_PLAYERS = 4;

export interface Member {
  name: string;
  /** Sim player id, reassigned each round. Always null for a spectator. */
  player: PlayerId | null;
  /** Watches the whole arena, fog-free, without playing. */
  spectator?: boolean;
  send(msg: unknown): void;
}

/**
 * One shared arena. Rounds run on a timer (players respawn instantly, so
 * "last network standing" can't end one) and the winner is whoever gathered the
 * most. The arena is regenerated between rounds, sized for the players present.
 */
export class Room {
  world!: World;
  private seed = 0;
  private arenaPlayers = MIN_ARENA_PLAYERS;
  /** Public so tests (and later, admin tooling) can drive round timing. */
  ticksLeft = 0;
  intermission = false;
  readonly members = new Set<Member>();
  /** Per member, how much of each player's stats history they've been sent. */
  private statsSent = new WeakMap<Member, Map<PlayerId, number>>();

  constructor() {
    this.startRound();
  }

  /** Members who are playing, not spectating. */
  get playerCount(): number {
    let n = 0;
    for (const m of this.members) if (!m.spectator) n++;
    return n;
  }

  get radius(): number {
    return this.world.arena.radius;
  }

  roundInfo(): RoundInfo {
    return {
      seed: this.seed,
      arenaPlayers: this.arenaPlayers,
      radius: this.radius,
      endsIn: this.ticksLeft / SIM_HZ,
      intermission: this.intermission,
    };
  }

  startRound(winner: Player | null = null): void {
    this.seed = (Math.random() * 2 ** 31) | 0;
    // Size the arena for the people playing in it; spectators take up no room.
    this.arenaPlayers = Math.max(MIN_ARENA_PLAYERS, this.playerCount);
    const radius = radiusForPlayers(this.arenaPlayers);
    this.world = new World(generateArena(this.seed, this.arenaPlayers, radius), this.seed);
    this.world.endOnLastStanding = false;
    this.world.placeBoosts(BOOST_START);
    this.ticksLeft = ROUND_SECONDS * SIM_HZ;
    this.intermission = false;
    this.statsSent = new WeakMap();

    // Everyone still connected gets a fresh colony in the new arena.
    for (const m of this.members) {
      m.player = null;
      if (!m.spectator) this.join(m);
    }
    const info = this.roundInfo();
    const players = this.playerDTOs();
    const winnerDTO = winner ? toPlayerDTO(winner) : null;
    for (const m of this.members) m.send({ t: "round", round: info, players, winner: winnerDTO });
  }

  /** Admits a member to the current round, spawning them straight away. */
  join(m: Member): void {
    const player = this.world.addPlayer(m.name, false);
    m.player = player.id;
    spawnInto(this.world, player);
  }

  leave(m: Member): void {
    this.members.delete(m);
    if (m.player == null) return;
    // Drop their colonies so an abandoned network doesn't linger.
    for (const n of [...this.world.nodes.values()]) {
      if (n.owner === m.player) this.world.nodes.delete(n.id);
    }
    for (const p of [...this.world.pipes.values()]) {
      if (!this.world.nodes.has(p.from) || !this.world.nodes.has(p.to)) this.world.pipes.delete(p.id);
    }
    for (const b of [...this.world.barriers.values()]) {
      if (!this.world.nodes.has(b.anchor)) this.world.barriers.delete(b.id);
    }
    const player = this.world.player(m.player);
    if (player) player.alive = false;
  }

  command(m: Member, cmd: Command): void {
    if (m.player == null || this.intermission) return;
    // Never trust the client's idea of who it is.
    this.world.enqueue({ ...cmd, player: m.player } as Command);
  }

  /** One authoritative tick. */
  step(): void {
    if (this.intermission) {
      if (--this.ticksLeft <= 0) this.startRound();
      return;
    }

    for (const p of this.world.players) if (p.isBot && p.alive) runBot(this.world, p.id);
    this.world.step();

    // Wiped out? Straight back in (§ round decisions: instant respawn).
    for (const m of this.members) {
      if (m.player == null) continue;
      const player = this.world.player(m.player);
      if (player && !player.alive) spawnInto(this.world, player);
    }

    if (this.world.tick % SIM_HZ === 0) for (const m of this.members) this.sendStats(m);
    if (--this.ticksLeft <= 0) this.endRound();
  }

  /**
   * What stats a member may see, sent as whatever they haven't had: their own
   * while playing, everyone's when spectating or once the round is over.
   */
  sendStats(m: Member, everyone = m.spectator === true): void {
    let sent = this.statsSent.get(m);
    if (!sent) this.statsSent.set(m, (sent = new Map()));
    const out: StatsDTO[] = [];
    for (const p of this.world.players) {
      if (!everyone && p.id !== m.player) continue;
      const s = this.world.stats.get(p.id);
      if (!s) continue;
      out.push(toStatsDTO(p.id, s, sent.get(p.id) ?? 0));
      sent.set(p.id, s.history.time.length);
    }
    if (out.length) m.send({ t: "stats", stats: out });
  }

  private endRound(): void {
    const ranked = [...this.world.players].sort((a, b) => b.score - a.score);
    const winner = ranked[0] ?? null;
    this.intermission = true;
    this.ticksLeft = INTERMISSION_SECONDS * SIM_HZ;
    const info = this.roundInfo();
    const players = this.playerDTOs();
    const winnerDTO = winner ? toPlayerDTO(winner) : null;
    for (const m of this.members) {
      this.sendStats(m, true); // before the round message, so the summary has it
      m.send({ t: "round", round: info, players, winner: winnerDTO });
    }
  }

  /** Leaderboard rows: everyone still playing, plus anyone who left with a score. */
  playerDTOs(): PlayerDTO[] {
    return this.world.players.filter((p) => p.alive || p.score > 0).map(toPlayerDTO);
  }

  /** What one player is allowed to see this tick; null = a spectator, who sees everything. */
  snapshotFor(player: PlayerId | null): Snapshot {
    const seen = player == null ? new Set(this.world.nodes.keys()) : visibleNodes(this.world, player);
    const nodes: NodeDTO[] = [];
    for (const id of seen) {
      const n = this.world.nodes.get(id);
      if (!n) continue;
      nodes.push({
        i: n.id,
        k: n.kind === "fall" ? 1 : n.kind === "boost" ? 2 : 0,
        ...(n.boost ? { b: n.boost } : {}),
        o: n.owner,
        x: Math.round(n.x),
        y: Math.round(n.y),
        n: Math.round(n.nutrients * 10) / 10,
        r: Math.round(n.rate * 10) / 10,
        s: Math.round(n.seed * 10) / 10,
      });
    }
    const pipes: PipeDTO[] = [];
    for (const p of this.world.pipes.values()) {
      if (seen.has(p.from) && seen.has(p.to)) pipes.push({ i: p.id, f: p.from, t: p.to, o: p.owner });
    }
    const barriers: BarrierDTO[] = [];
    for (const b of this.world.barriers.values()) {
      if (!seen.has(b.anchor)) continue;
      barriers.push({
        i: b.id, o: b.owner, a: b.anchor,
        x: Math.round(b.x), y: Math.round(b.y),
        ax: Math.round(b.a.x), ay: Math.round(b.a.y),
        bx: Math.round(b.b.x), by: Math.round(b.b.y),
      });
    }
    return {
      t: "snap",
      tick: this.world.tick,
      endsIn: this.ticksLeft / SIM_HZ,
      online: this.playerCount,
      nodes,
      pipes,
      barriers,
      players: this.playerDTOs(),
    };
  }
}

function toPlayerDTO(p: Player): PlayerDTO {
  const a = p.abilities;
  return {
    id: p.id, name: p.name, color: p.color, score: Math.round(p.score), h: Math.round(p.held), alive: p.alive,
    fu: a.flowUntil, fr: a.flowReadyAt, sr: a.severReadyAt,
  };
}
