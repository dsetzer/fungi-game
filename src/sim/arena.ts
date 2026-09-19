import { ARENA_RADIUS, INTERIOR_CLUSTERS } from "../config";
import { dist, makeRng, type Vec } from "./geometry";
import type { Wall } from "./types";

export interface Arena {
  radius: number;
  walls: Wall[];
  spawns: Vec[];
}

/**
 * Circle-cluster arena (§4). Currently: a cloud-ring boundary plus a handful of
 * random-walk blobs in the interior. Room/chokepoint-aware generation (§4, MVP
 * step 7) replaces `interiorClusters` later.
 */
export function generateArena(seed: number, playerCount: number): Arena {
  const rng = makeRng(seed);
  const radius = ARENA_RADIUS;
  const walls: Wall[] = [];

  // Boundary: overlapping circles straddling the arena edge.
  let angle = 0;
  while (angle < Math.PI * 2) {
    const r = 50 + rng() * 60;
    const d = radius + r * 0.6;
    walls.push({ x: Math.cos(angle) * d, y: Math.sin(angle) * d, r });
    angle += (r * 0.9) / d;
  }

  const spawns: Vec[] = [];
  const spawnDist = radius * 0.62;
  const spawnOffset = rng() * Math.PI * 2;
  for (let i = 0; i < playerCount; i++) {
    const a = spawnOffset + (i / playerCount) * Math.PI * 2;
    spawns.push({ x: Math.cos(a) * spawnDist, y: Math.sin(a) * spawnDist });
  }

  walls.push(...interiorClusters(rng, radius, spawns));
  return { radius, walls, spawns };
}

function interiorClusters(rng: () => number, radius: number, spawns: Vec[]): Wall[] {
  const out: Wall[] = [];
  for (let c = 0; c < INTERIOR_CLUSTERS; c++) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * radius * 0.85;
    let x = Math.cos(a) * d;
    let y = Math.sin(a) * d;
    let heading = rng() * Math.PI * 2;
    const count = 4 + Math.floor(rng() * 7);
    for (let i = 0; i < count; i++) {
      const r = 25 + rng() * 55;
      const clearOfSpawns = spawns.every((s) => dist(s.x, s.y, x, y) > r + 180);
      if (clearOfSpawns && Math.hypot(x, y) + r < radius) out.push({ x, y, r });
      heading += (rng() - 0.5) * 1.4;
      x += Math.cos(heading) * r * 1.1;
      y += Math.sin(heading) * r * 1.1;
    }
  }
  return out;
}
