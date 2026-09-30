import type { Arena } from "../arena";
import type { Vec } from "../geometry";

/** Walking-map cell size, in world units — the terrain's own grid. */
const CELL = 90;
/** Open ground must leave this much clearance from wall circles. */
const CLEARANCE = 20;
/** Distance fields kept per arena before the oldest are dropped. */
const MAX_FIELDS = 200;
const SQRT2 = Math.SQRT2;

/**
 * A coarse walking map of the arena, for bots (bot-design.md, Pathing).
 *
 * Terrain is thousands of wall circles; this marks which cells are open ground
 * and, for any target, how far each open cell is from it *going round* the
 * terrain. A throw is then valued by how much of that walk it saves rather than
 * by straight-line distance — so a bot facing a wall between it and a boost
 * heads for the gap instead of throwing at the wall forever.
 *
 * Terrain never changes during a round, so fields are cached per target for the
 * life of the arena.
 */
export class NavGrid {
  readonly n: number;
  private readonly origin: number;
  private readonly open: Uint8Array;
  private readonly fields = new Map<string, Float32Array>();

  constructor(arena: Arena) {
    this.origin = -arena.radius;
    this.n = Math.ceil((arena.radius * 2) / CELL) + 1;
    this.open = new Uint8Array(this.n * this.n);
    for (let y = 0; y < this.n; y++) {
      for (let x = 0; x < this.n; x++) {
        const c = this.centre(y * this.n + x);
        const inside = Math.hypot(c.x, c.y) < arena.radius - CLEARANCE;
        if (inside && arena.isReachable(c) && !arena.index.discBlocks(c, CLEARANCE)) {
          this.open[y * this.n + x] = 1;
        }
      }
    }
  }

  private centre(cell: number): Vec {
    const x = cell % this.n;
    const y = Math.floor(cell / this.n);
    return { x: this.origin + (x + 0.5) * CELL, y: this.origin + (y + 0.5) * CELL };
  }

  private cellOf(p: Vec): number {
    const x = Math.min(this.n - 1, Math.max(0, Math.floor((p.x - this.origin) / CELL)));
    const y = Math.min(this.n - 1, Math.max(0, Math.floor((p.y - this.origin) / CELL)));
    return y * this.n + x;
  }

  /** The open cell nearest a point (a node may sit on a cell the grid calls closed). */
  private nearestOpen(p: Vec): number {
    const home = this.cellOf(p);
    if (this.open[home]) return home;
    const hx = home % this.n;
    const hy = Math.floor(home / this.n);
    for (let r = 1; r < 6; r++) {
      let best = -1;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = hx + dx;
          const y = hy + dy;
          if (x < 0 || y < 0 || x >= this.n || y >= this.n || !this.open[y * this.n + x]) continue;
          const c = this.centre(y * this.n + x);
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d < bestD) {
            bestD = d;
            best = y * this.n + x;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /**
   * Walking distance from every open cell to `target`, round the terrain
   * (Dijkstra over the 8-neighbour grid; no cutting corners past a wall).
   */
  field(key: string, target: Vec): Float32Array {
    const cached = this.fields.get(key);
    if (cached) return cached;
    const total = this.n * this.n;
    const d = new Float32Array(total).fill(Infinity);
    const start = this.nearestOpen(target);
    if (start >= 0) {
      const heap = new MinHeap(total);
      d[start] = 0;
      heap.push(start, 0);
      while (heap.size > 0) {
        const [cell, cd] = heap.pop();
        if (cd > d[cell]) continue;
        const x = cell % this.n;
        const y = Math.floor(cell / this.n);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= this.n || ny >= this.n) continue;
            const next = ny * this.n + nx;
            if (!this.open[next]) continue;
            if (dx !== 0 && dy !== 0 && (!this.open[y * this.n + nx] || !this.open[ny * this.n + x])) continue;
            const nd = cd + (dx !== 0 && dy !== 0 ? CELL * SQRT2 : CELL);
            if (nd < d[next]) {
              d[next] = nd;
              heap.push(next, nd);
            }
          }
        }
      }
    }
    if (this.fields.size >= MAX_FIELDS) this.fields.delete(this.fields.keys().next().value!);
    this.fields.set(key, d);
    return d;
  }

  /** Walking distance from a point to a field's target; Infinity if walled off. */
  distance(field: Float32Array, p: Vec): number {
    const cell = this.cellOf(p);
    if (this.open[cell]) return field[cell];
    const near = this.nearestOpen(p);
    return near < 0 ? Infinity : field[near] + CELL;
  }
}

const grids = new WeakMap<Arena, NavGrid>();

/** The walking map for an arena, built on first use. */
export function navFor(arena: Arena): NavGrid {
  let grid = grids.get(arena);
  if (!grid) {
    grid = new NavGrid(arena);
    grids.set(arena, grid);
  }
  return grid;
}

/** Binary min-heap of (cell, priority) for Dijkstra. */
class MinHeap {
  private cells: Int32Array;
  private keys: Float32Array;
  size = 0;

  constructor(capacity: number) {
    this.cells = new Int32Array(Math.max(16, capacity * 2));
    this.keys = new Float32Array(Math.max(16, capacity * 2));
  }

  push(cell: number, key: number): void {
    if (this.size === this.cells.length) {
      const cells = new Int32Array(this.size * 2);
      const keys = new Float32Array(this.size * 2);
      cells.set(this.cells);
      keys.set(this.keys);
      this.cells = cells;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.cells[i] = this.cells[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.cells[i] = cell;
    this.keys[i] = key;
  }

  pop(): [number, number] {
    const top: [number, number] = [this.cells[0], this.keys[0]];
    const lastCell = this.cells[--this.size];
    const lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const child = r < this.size && this.keys[r] < this.keys[l] ? r : l;
      if (this.keys[child] >= lastKey) break;
      this.cells[i] = this.cells[child];
      this.keys[i] = this.keys[child];
      i = child;
    }
    this.cells[i] = lastCell;
    this.keys[i] = lastKey;
    return top;
  }
}
