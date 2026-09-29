/**
 * Proposed arena generator (not wired into the game). Pure function of
 * (seed, players, radius) → wall discs, spawns and nutrient falls.
 *
 * Structure first, rock second:
 *
 *  1. ROOMS — open chambers of very different sizes (each a big circle, often with
 *     lobes fused on). One large room in the middle, one per spawn, and many
 *     others scattered with rock between them.
 *  2. PASSAGES — the rooms are wired as a graph: a spanning tree (so everything is
 *     connected) plus extra links (so there are loops and second routes). Leaves of
 *     the graph become ENCLAVES: dead-end rooms behind a narrow neck, holding
 *     richer falls. Passage widths vary a lot: tight chokepoints you can wall off,
 *     medium corridors, and wide roads. Each spawn gets a wide artery toward the
 *     middle so opening moves are fair.
 *  3. ROCK — everything that isn't open is filled with discs. Working from the
 *     spot with the most rock around it outward, each disc is as big as it can be
 *     without touching open ground, so big discs sit deep in solid rock and
 *     ever smaller ones hug the edges of rooms and passages. The map stays made of
 *     circles of varying size.
 *  4. FALLS — placed inside rooms (bigger rooms, more falls; some rooms empty),
 *     with widely varied pools, richer toward the middle and in enclaves. Every
 *     spawn has a small meal in reach and a bigger one just beyond, and neutral
 *     falls are rescaled so each player's surroundings hold about the same.
 *
 * A flood fill over the finished discs verifies everything is connected.
 */
import { NODE_SPACING, START_NUTRIENTS, fallAura, radiusForPlayers, reach } from "../../src/config";
import { distToSegmentSq, makeRng, segmentHitsCircle, type Vec } from "../../src/sim/geometry";

export interface Disc extends Vec {
  r: number;
}
export interface Fall extends Vec {
  pool: number;
  /** Which spawn's doorstep it belongs to, or null for the rest of the map. */
  home: number | null;
}
export interface MapResult {
  radius: number;
  walls: Disc[];
  spawns: Vec[];
  falls: Fall[];
  /** The open space as designed, for drawing and debugging. */
  chambers: { circles: Disc[]; enclave: boolean }[];
  tunnels: { pts: Vec[]; widths: number[]; kind: "artery" | "choke" | "corridor" | "road" }[];
  stats: {
    ms: number;
    /** Total pool nearest each spawn (home meals included) — should be close to equal. */
    wealth: number[];
    /** Route length from each spawn to the middle through the passage graph. */
    routeToCentre: number[];
    rooms: number;
    enclaves: number;
    passages: number;
    loops: number;
    chokepoints: number;
    /** Share of the arena that is open ground. */
    openShare: number;
    /** False only if the finished discs leave part of the open space cut off. */
    connected: boolean;
    /** Stray bubbles of open ground sealed with rock. */
    repairs: number;
  };
}
export interface MapOptions {
  seed: number;
  players: number;
  radius?: number;
}

// ---- tuning ----
const SPAWN_ROOM = 600;
const ROOM_MIN = 110;
const ROOM_MAX = 620;
const ROOM_SEP = 380; // rock kept between two rooms' edges
const ROOMS_PER_MILLION = 0.56; // area units: 1e6 world units²
const EXTRA_LINK_CHANCE = 0.4;
const ROCK_MAX = 1300;
const ROCK_MIN = 38;
const POOL_MEDIAN = 240;
const POOL_SIGMA = 0.85;
const POOL_MIN = 40;
const POOL_MAX = 1400;
const JACKPOT_CHANCE = 0.05;

type Kind = "artery" | "choke" | "corridor" | "road";

export function generateMap(opts: MapOptions): MapResult {
  const t0 = performance.now();
  const rng = makeRng(opts.seed);
  const players = Math.max(1, opts.players);
  const R = opts.radius ?? radiusForPlayers(players);
  const area = Math.PI * R * R;

  // ---- spawns: an evenly spaced ring, as in the game ----
  const spawnDist = R * 0.66;
  const spawnOffset = rng() * Math.PI * 2;
  const spawns: Vec[] = Array.from({ length: players }, (_, i) => {
    const a = spawnOffset + (i / players) * Math.PI * 2;
    return { x: Math.cos(a) * spawnDist, y: Math.sin(a) * spawnDist };
  });

  // ---- 1. rooms ----
  interface Room {
    circles: Disc[];
    kind: "centre" | "spawn" | "plain";
    spawn: number;
    enclave: boolean;
  }
  const rooms: Room[] = [];
  const lobed = (x: number, y: number, r: number, maxLobes: number): Disc[] => {
    const cs: Disc[] = [{ x, y, r }];
    const lobes = Math.floor(rng() * (maxLobes + 1));
    for (let i = 0; i < lobes; i++) {
      const host = cs[Math.floor(rng() * cs.length)];
      const lr = r * (0.4 + rng() * 0.35);
      const a = rng() * Math.PI * 2;
      const d = (host.r + lr) * (0.55 + rng() * 0.3);
      cs.push({ x: host.x + Math.cos(a) * d, y: host.y + Math.sin(a) * d, r: lr });
    }
    return cs;
  };
  const inArena = (cs: Disc[]) => cs.every((c) => Math.hypot(c.x, c.y) + c.r <= R - 180);
  const gapTo = (cs: Disc[]) => {
    let g = Infinity;
    for (const room of rooms) for (const o of room.circles) for (const c of cs) g = Math.min(g, Math.hypot(o.x - c.x, o.y - c.y) - o.r - c.r);
    return g;
  };

  const centreR = Math.min(760, R * 0.12);
  rooms.push({ circles: lobed(0, 0, centreR, 2), kind: "centre", spawn: -1, enclave: false });
  spawns.forEach((s, i) => {
    rooms.push({ circles: lobed(s.x, s.y, SPAWN_ROOM, 1), kind: "spawn", spawn: i, enclave: false });
  });

  const wanted = Math.round((area / 1e6) * ROOMS_PER_MILLION);
  for (let attempt = 0, made = 0; made < wanted && attempt < wanted * 80; attempt++) {
    const r = ROOM_MIN * (ROOM_MAX / ROOM_MIN) ** (rng() ** 1.8);
    let best: Disc[] | null = null;
    let bestGap = Infinity;
    for (let k = 0; k < 6; k++) {
      const a = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * (R - r - 200);
      const cs = lobed(Math.cos(a) * d, Math.sin(a) * d, r, r > 300 ? 2 : 1);
      if (!inArena(cs)) continue;
      const g = gapTo(cs);
      if (g < ROOM_SEP) continue;
      // Prefer spots that pack in fairly close, so the map is dense with places.
      if (g < bestGap) {
        bestGap = g;
        best = cs;
      }
    }
    if (best) {
      rooms.push({ circles: best, kind: "plain", spawn: -1, enclave: false });
      made++;
    }
  }

  // ---- 2. passages ----
  const centreOf = (i: number) => rooms[i].circles[0];
  const N = rooms.length;
  const maxExtra = Math.max(1600, R * 0.3);
  interface Edge {
    a: number;
    b: number;
    len: number;
    tree: boolean;
    artery: boolean;
  }
  const gabriel: Edge[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = centreOf(i);
      const b = centreOf(j);
      const len = Math.hypot(a.x - b.x, a.y - b.y);
      if (len > R * 0.9) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      let ok = true;
      for (let k = 0; k < N && ok; k++) {
        if (k === i || k === j) continue;
        const c = centreOf(k);
        if (Math.hypot(c.x - mx, c.y - my) < len / 2) ok = false;
      }
      if (ok) gabriel.push({ a: i, b: j, len, tree: false, artery: false });
    }
  }
  gabriel.sort((x, y) => x.len - y.len);
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const edges: Edge[] = [];
  for (const e of gabriel) {
    if (find(e.a) !== find(e.b)) {
      parent[find(e.a)] = find(e.b);
      e.tree = true;
      edges.push(e);
    } else if (e.len <= maxExtra && rng() < EXTRA_LINK_CHANCE) {
      edges.push(e);
    }
  }
  // Every spawn gets its own wide artery to the middle (for up to a dozen players),
  // so no opening route is much longer than another. Bigger games rely on the graph.
  if (players <= 12) {
    for (let i = 1; i <= players; i++) {
      const a = centreOf(0);
      const b = centreOf(i);
      edges.push({ a: 0, b: i, len: Math.hypot(a.x - b.x, a.y - b.y), tree: false, artery: true });
    }
  }
  const degree = new Array<number>(N).fill(0);
  for (const e of edges) {
    degree[e.a]++;
    degree[e.b]++;
  }
  rooms.forEach((room, i) => {
    if (room.kind === "plain" && degree[i] === 1) room.enclave = true;
  });

  // Arteries: the shortest route from every spawn to the middle is a wide road.
  const distTo = new Array<number>(N).fill(Infinity);
  distTo[0] = 0;
  const adj: Edge[][] = Array.from({ length: N }, () => []);
  for (const e of edges) {
    adj[e.a].push(e);
    adj[e.b].push(e);
  }
  const done = new Array<boolean>(N).fill(false);
  for (let step = 0; step < N; step++) {
    let u = -1;
    for (let i = 0; i < N; i++) if (!done[i] && (u < 0 || distTo[i] < distTo[u])) u = i;
    if (u < 0 || distTo[u] === Infinity) break;
    done[u] = true;
    for (const e of adj[u]) {
      const v = e.a === u ? e.b : e.a;
      if (distTo[u] + e.len < distTo[v]) {
        distTo[v] = distTo[u] + e.len;
      }
    }
  }
  const routeToCentre: number[] = [];
  rooms.forEach((room, i) => {
    if (room.kind !== "spawn") return;
    routeToCentre[room.spawn] = distTo[i];
  });

  const tunnels: MapResult["tunnels"] = [];
  const shapes: { seg: [Vec, Vec, number] | null; circle: Disc | null }[] = [];
  for (const room of rooms) for (const c of room.circles) shapes.push({ seg: null, circle: c });
  let chokepoints = 0;
  for (const e of edges) {
    const a = centreOf(e.a);
    const b = centreOf(e.b);
    const leafSmall = (i: number) => rooms[i].enclave && centreOf(i).r < 420;
    let kind: Kind;
    let width: number;
    if (e.artery) {
      kind = "artery";
      width = 320 + rng() * 100;
    } else if (leafSmall(e.a) || leafSmall(e.b)) {
      kind = "choke";
      width = 130 + rng() * 60; // the neck of an enclave
    } else {
      const roll = rng();
      if (roll < 0.4) {
        kind = "choke";
        width = 130 + rng() * 80;
      } else if (roll < 0.8) {
        kind = "corridor";
        width = 220 + rng() * 100;
      } else {
        kind = "road";
        width = 360 + rng() * 140;
      }
    }
    if (kind === "choke") chokepoints++;
    // A wandering line: a couple of waypoints pushed sideways.
    const way = e.artery ? 3 : e.len > 1000 ? 2 : e.len > 450 ? 1 : 0;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const nx = -dy / e.len;
    const ny = dx / e.len;
    const pts: Vec[] = [{ x: a.x, y: a.y }];
    for (let k = 1; k <= way; k++) {
      const t = k / (way + 1);
      const off = (rng() - 0.5) * Math.min(e.artery ? 1000 : 420, e.len * (e.artery ? 0.3 : 0.4));
      pts.push({ x: a.x + dx * t + nx * off, y: a.y + dy * t + ny * off });
    }
    pts.push({ x: b.x, y: b.y });
    const widths: number[] = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const w = Math.max(120, width * (0.85 + rng() * 0.3));
      widths.push(w);
      shapes.push({ seg: [pts[k], pts[k + 1], w / 2], circle: null });
    }
    tunnels.push({ pts, widths, kind });
  }

  // ---- 3. rock: discs as big as the space allows ----
  const cell = R > 8000 ? 100 : 60;
  const n = Math.ceil((R * 2) / cell);
  const cx = (i: number) => -R + (i + 0.5) * cell;
  const cellOf = (v: number) => Math.min(n - 1, Math.max(0, Math.floor((v + R) / cell)));
  const clearance = new Float32Array(n * n).fill(-1);
  const order: number[] = [];
  let openCells = 0;
  let insideCells = 0;
  // Bucket the shapes so each cell only looks at the ones near it.
  const B = 600;
  const buckets = new Map<number, number[]>();
  const bkey = (ix: number, iy: number) => (ix + 200) * 1024 + (iy + 200);
  shapes.forEach((sh, idx) => {
    const ext = ROCK_MAX + 100;
    let x0: number, x1: number, y0: number, y1: number;
    if (sh.circle) {
      x0 = sh.circle.x - sh.circle.r - ext;
      x1 = sh.circle.x + sh.circle.r + ext;
      y0 = sh.circle.y - sh.circle.r - ext;
      y1 = sh.circle.y + sh.circle.r + ext;
    } else {
      const [p, q, hw] = sh.seg!;
      x0 = Math.min(p.x, q.x) - hw - ext;
      x1 = Math.max(p.x, q.x) + hw + ext;
      y0 = Math.min(p.y, q.y) - hw - ext;
      y1 = Math.max(p.y, q.y) + hw + ext;
    }
    for (let ix = Math.floor(x0 / B); ix <= Math.floor(x1 / B); ix++) {
      for (let iy = Math.floor(y0 / B); iy <= Math.floor(y1 / B); iy++) {
        const k = bkey(ix, iy);
        const b = buckets.get(k);
        if (b) b.push(idx);
        else buckets.set(k, [idx]);
      }
    }
  });
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = cx(x);
      const py = cx(y);
      if (Math.hypot(px, py) > R) continue;
      let d = ROCK_MAX;
      for (const idx of buckets.get(bkey(Math.floor(px / B), Math.floor(py / B))) ?? []) {
        const sh = shapes[idx];
        const v = sh.circle
          ? Math.hypot(px - sh.circle.x, py - sh.circle.y) - sh.circle.r
          : Math.sqrt(distToSegmentSq(px, py, sh.seg![0].x, sh.seg![0].y, sh.seg![1].x, sh.seg![1].y)) - sh.seg![2];
        if (v < d) d = v;
      }
      clearance[y * n + x] = d;
      insideCells++;
      if (d <= 0) openCells++;
      if (d >= ROCK_MIN) order.push(y * n + x);
    }
  }
  order.sort((p, q) => clearance[q] - clearance[p]);

  const walls: Disc[] = [];
  const covered = new Uint8Array(n * n);
  for (const i of order) {
    if (covered[i]) continue;
    const gx = i % n;
    const gy = (i - gx) / n;
    const r = Math.min(ROCK_MAX, clearance[i]);
    const px = cx(gx);
    const py = cx(gy);
    walls.push({ x: px, y: py, r });
    // Count a cell as covered only when well inside, so discs overlap and seal.
    const inner = Math.max(0, r - cell * 0.5);
    const span = Math.ceil(inner / cell);
    for (let yy = Math.max(0, gy - span); yy <= Math.min(n - 1, gy + span); yy++) {
      for (let xx = Math.max(0, gx - span); xx <= Math.min(n - 1, gx + span); xx++) {
        if (Math.hypot(cx(xx) - px, cx(yy) - py) <= inner) covered[yy * n + xx] = 1;
      }
    }
  }
  // ---- verify: the open ground must be one connected piece ----
  // Judged on a finer grid than the rock fill, so the narrowest chokepoints resolve.
  const vc = R > 8000 ? 70 : 40;
  const vn = Math.ceil((R * 2) / vc);
  const vx = (i: number) => -R + (i + 0.5) * vc;
  const vcell = (v: number) => Math.min(vn - 1, Math.max(0, Math.floor((v + R) / vc)));
  let reached = new Uint8Array(vn * vn);
  let hash = new Hash(500);
  let repairs = 0;
  const survey = () => {
    hash = new Hash(500);
    for (const w of walls) hash.add(w);
    const open = new Uint8Array(vn * vn);
    for (let y = 0; y < vn; y++) {
      for (let x = 0; x < vn; x++) {
        const px = vx(x);
        const py = vx(y);
        if (Math.hypot(px, py) > R - NODE_SPACING) continue;
        open[y * vn + x] = hash.anyWithin(px, py, NODE_SPACING, []) ? 0 : 1;
      }
    }
    const label = new Int32Array(vn * vn).fill(-1);
    const comps: number[][] = [];
    for (let s0 = 0; s0 < open.length; s0++) {
      if (!open[s0] || label[s0] >= 0) continue;
      const cells: number[] = [];
      const st = [s0];
      label[s0] = comps.length;
      while (st.length) {
        const i = st.pop()!;
        cells.push(i);
        const x = i % vn;
        const y = (i - x) / vn;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= vn || ny >= vn) continue;
            const j = ny * vn + nx;
            if (open[j] && label[j] < 0) {
              label[j] = comps.length;
              st.push(j);
            }
          }
        }
      }
      comps.push(cells);
    }
    const home = label[vcell(spawns[0].y) * vn + vcell(spawns[0].x)];
    reached = new Uint8Array(vn * vn);
    for (let i = 0; i < label.length; i++) reached[i] = home >= 0 && label[i] === home ? 1 : 0;
    return comps.filter((_, idx) => idx !== home);
  };
  // Stray bubbles of open ground the rock fill left behind are sealed with rock.
  for (let round = 0; round < 3; round++) {
    const stray = survey();
    if (stray.length === 0) break;
    for (const cells of stray) {
      repairs++;
      for (const i of cells) walls.push({ x: vx(i % vn), y: vx((i - (i % vn)) / vn), r: vc * 0.9 });
    }
  }
  survey();
  const reachable = (p: Vec) => reached[vcell(p.y) * vn + vcell(p.x)] === 1;
  let connected = true;
  // Everything designed as open (room centres, spawns) must be part of the one piece.
  for (const s of spawns) if (!reachable(s)) connected = false;
  for (const room of rooms) if (!reachable(room.circles[0])) connected = false;

  // ---- 4. falls ----
  const falls: Fall[] = [];
  const canPlace = (p: Vec, pool: number): boolean => {
    const aura = Math.max(14, fallAura(pool));
    if (Math.hypot(p.x, p.y) > R - 120 - aura) return false;
    if (hash.anyWithin(p.x, p.y, aura + 30, [])) return false;
    if (falls.some((f) => Math.hypot(f.x - p.x, f.y - p.y) < 60)) return false;
    return reachable(p);
  };
  const richness = (p: Vec) => 1.35 - 0.7 * Math.min(1, Math.hypot(p.x, p.y) / R);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const poolAt = (p: Vec, mult: number) => {
    let pool = POOL_MEDIAN * richness(p) * mult * Math.exp(gauss() * POOL_SIGMA);
    if (rng() < JACKPOT_CHANCE) pool *= 2.5;
    return Math.round(Math.min(POOL_MAX, Math.max(POOL_MIN, pool)));
  };

  const startReach = reach(START_NUTRIENTS);
  spawns.forEach((s, idx) => {
    const room = rooms[1 + idx];
    const towardCentre = Math.atan2(-s.y, -s.x);
    for (const [d, lo, hi] of [[startReach * 0.6, 120, 260], [startReach * 1.15, 500, 800]] as const) {
      for (let tries = 0; tries < 80; tries++) {
        const a = towardCentre + (rng() - 0.5) * 3;
        const p = { x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d };
        const pool = Math.round(lo + rng() * (hi - lo));
        if (canPlace(p, pool) && !hash.segmentBlocked(s, p) && room.circles.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < c.r)) {
          falls.push({ ...p, pool, home: idx });
          break;
        }
      }
    }
  });

  const scatterIn = (room: Room, count: number, mult: number) => {
    const totalArea = room.circles.reduce((s, c) => s + c.r * c.r, 0);
    for (let i = 0; i < count; i++) {
      for (let tries = 0; tries < 30; tries++) {
        let pick = rng() * totalArea;
        let c = room.circles[0];
        for (const cand of room.circles) {
          pick -= cand.r * cand.r;
          if (pick <= 0) {
            c = cand;
            break;
          }
        }
        const rr = c.r - 70;
        if (rr <= 0) continue;
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * rr;
        const p = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
        const pool = poolAt(p, mult);
        if (canPlace(p, pool)) {
          falls.push({ ...p, pool, home: null });
          break;
        }
      }
    }
  };

  // The middle: a few big prizes.
  scatterIn(rooms[0], 3 + Math.round(centreR / 400), 2.6);
  for (const room of rooms) {
    if (room.kind !== "plain") continue;
    const r = room.circles[0].r;
    // Bigger rooms hold more; a fifth are empty, there to be explored anyway.
    let count = rng() < 0.15 ? 0 : 1 + Math.floor(rng() * (2 + r / 160));
    if (room.enclave) count = Math.max(2, count);
    scatterIn(room, count, room.enclave ? 2.0 : 1);
  }
  // A stray fall in the middle of some wider passages.
  for (const t of tunnels) {
    if (t.kind === "choke" || rng() > 0.25) continue;
    const k = Math.floor(rng() * (t.pts.length - 1));
    const p = { x: (t.pts[k].x + t.pts[k + 1].x) / 2, y: (t.pts[k].y + t.pts[k + 1].y) / 2 };
    const pool = poolAt(p, 0.6);
    if (canPlace(p, pool)) falls.push({ ...p, pool, home: null });
  }

  // ---- fairness: every spawn's surroundings hold about the same ----
  const nearest = (p: Vec) => {
    let best = 0;
    for (let i = 1; i < spawns.length; i++) {
      if (Math.hypot(spawns[i].x - p.x, spawns[i].y - p.y) < Math.hypot(spawns[best].x - p.x, spawns[best].y - p.y)) best = i;
    }
    return best;
  };
  const totals = (includeAll: boolean) => {
    const t = new Array<number>(players).fill(0);
    for (const f of falls) if (includeAll || f.home === null) t[nearest(f)] += f.pool;
    return t;
  };
  if (players > 1) {
    // A few passes, since clamped pools and shared borders keep it from settling at once.
    for (let pass = 0; pass < 4; pass++) {
      const neutral = totals(false);
      const mean = neutral.reduce((s, v) => s + v, 0) / players;
      for (const f of falls) {
        if (f.home !== null || Math.hypot(f.x, f.y) < centreR + 200) continue;
        const k = Math.min(2.5, Math.max(0.4, mean / Math.max(1, neutral[nearest(f)])));
        f.pool = Math.round(Math.min(POOL_MAX, Math.max(POOL_MIN, f.pool * k)));
      }
    }
  }

  return {
    radius: R,
    walls,
    spawns,
    falls,
    chambers: rooms.map((r) => ({ circles: r.circles, enclave: r.enclave })),
    tunnels,
    stats: {
      ms: performance.now() - t0,
      wealth: totals(true),
      routeToCentre,
      rooms: rooms.length,
      enclaves: rooms.filter((r) => r.enclave).length,
      passages: edges.length,
      loops: edges.length - (N - 1),
      chokepoints,
      openShare: openCells / Math.max(1, insideCells),
      connected,
      repairs,
    },
  };
}

/** Uniform hash grid over discs, so neighbour queries stay cheap on big maps. */
class Hash {
  private buckets = new Map<number, Disc[]>();
  constructor(private cell: number) {}
  private key(ix: number, iy: number) {
    return (ix + 1000) * 4096 + (iy + 1000);
  }
  add(d: Disc): void {
    const c = this.cell;
    for (let ix = Math.floor((d.x - d.r) / c); ix <= Math.floor((d.x + d.r) / c); ix++) {
      for (let iy = Math.floor((d.y - d.r) / c); iy <= Math.floor((d.y + d.r) / c); iy++) {
        const k = this.key(ix, iy);
        const b = this.buckets.get(k);
        if (b) b.push(d);
        else this.buckets.set(k, [d]);
      }
    }
  }
  private *near(x: number, y: number, rad: number): Generator<Disc> {
    const c = this.cell;
    for (let ix = Math.floor((x - rad) / c); ix <= Math.floor((x + rad) / c); ix++) {
      for (let iy = Math.floor((y - rad) / c); iy <= Math.floor((y + rad) / c); iy++) {
        const b = this.buckets.get(this.key(ix, iy));
        if (b) yield* b;
      }
    }
  }
  /** Any disc (not in `exempt`) closer than its radius plus `rad`. */
  anyWithin(x: number, y: number, rad: number, exempt: Disc[]): boolean {
    for (const o of this.near(x, y, rad)) {
      if (exempt.includes(o)) continue;
      if (Math.hypot(o.x - x, o.y - y) < o.r + rad) return true;
    }
    return false;
  }
  segmentBlocked(a: Vec, b: Vec): boolean {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const half = Math.hypot(a.x - b.x, a.y - b.y) / 2;
    for (const o of this.near(mx, my, half)) if (segmentHitsCircle(a, b, o)) return true;
    return false;
  }
}
