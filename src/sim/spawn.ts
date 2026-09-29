import {
  FALL_POOL_MAX,
  NODE_SPACING,
  SPAWN_CLUSTER_DISTANCE,
  START_NUTRIENTS,
  reach,
} from "../config";
import { dist, type Vec } from "./geometry";
import type { GameNode, Player } from "./types";
import type { World } from "./world";

const CANDIDATES = 400;
const MIN_RIVAL_DISTANCE = 1400;
/**
 * Food must be this fraction of starting reach away at most. Reach shrinks as a
 * colony starves, so a fall sitting right on the limit drifts out of range
 * before the player can connect to it.
 */
const FOOD_MARGIN = 0.75;

/**
 * Somewhere to drop a new or respawning player: open, reachable ground, as far
 * from existing colonies as we can find, ideally with a nutrient fall already in
 * range so the opening race (§5) works the same as at round start.
 */
export function findSpawnPoint(world: World): Vec {
  const startReach = reach(START_NUTRIENTS) * FOOD_MARGIN;
  const colonies = [...world.nodes.values()].filter((n) => n.kind === "colony");
  const falls = [...world.nodes.values()].filter((n) => n.kind === "fall");

  let best: Vec | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < CANDIDATES; i++) {
    const a = world.rng() * Math.PI * 2;
    const d = Math.sqrt(world.rng()) * world.arena.radius * 0.92;
    const p = { x: Math.cos(a) * d, y: Math.sin(a) * d };
    if (!world.arena.isReachable(p) || !world.isFreeSpot(p, NODE_SPACING * 2, 0)) continue;

    const rival = nearest(colonies, p);
    if (rival !== null && rival < MIN_RIVAL_DISTANCE * 0.5) continue;
    const fed = falls.some((f) => dist(f.x, f.y, p.x, p.y) <= startReach && world.hasLineOfSight(p, f));
    // Food in reach outweighs isolation: starting with nothing to drain is a
    // death sentence, whereas a slightly close neighbour is merely awkward.
    const score = (fed ? 10_000 : 0) + Math.min(rival ?? MIN_RIVAL_DISTANCE * 2, MIN_RIVAL_DISTANCE * 2);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // Nowhere clean: fall back to the round's original spawn ring.
  return best ?? world.arena.spawns[0] ?? { x: 0, y: 0 };
}

function nearest(nodes: GameNode[], p: Vec): number | null {
  let best: number | null = null;
  for (const n of nodes) {
    const d = dist(n.x, n.y, p.x, p.y);
    if (best === null || d < best) best = d;
  }
  return best;
}

/**
 * Drops a player into a live round: a starting colony, plus a fall cluster beside
 * it if this corner of the map has nothing to eat.
 */
export function spawnInto(world: World, player: Player): GameNode {
  const p = findSpawnPoint(world);
  if (!hasFoodInReach(world, p)) seedFoodNear(world, p);
  return world.addColony(player.id, p.x, p.y, START_NUTRIENTS);
}

function hasFoodInReach(world: World, p: Vec): boolean {
  const startReach = reach(START_NUTRIENTS) * FOOD_MARGIN;
  return [...world.nodes.values()].some(
    (n) => n.kind === "fall" && dist(n.x, n.y, p.x, p.y) <= startReach && world.hasLineOfSight(p, n),
  );
}

/**
 * Guarantees a spawn something to eat. Cave terrain rejects most cluster
 * positions, so candidates are checked and retried, and the last resort is a
 * single blob placed somewhere we know is open and in line of sight.
 */
function seedFoodNear(world: World, p: Vec): void {
  const startReach = reach(START_NUTRIENTS) * FOOD_MARGIN;
  for (let attempt = 0; attempt < 24; attempt++) {
    const a = world.rng() * Math.PI * 2;
    // Near enough that the cluster's inner blobs land inside starting reach.
    const d = startReach * 0.5 + world.rng() * (SPAWN_CLUSTER_DISTANCE - startReach * 0.5);
    const centre = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
    if (!world.arena.isReachable(centre) || !world.isFreeSpot(centre, NODE_SPACING)) continue;
    const placed = world.addFallCluster(centre, p);
    if (placed.some((f) => dist(f.x, f.y, p.x, p.y) <= startReach && world.hasLineOfSight(p, f))) {
      return;
    }
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    const a = world.rng() * Math.PI * 2;
    const d = startReach * (0.35 + world.rng() * 0.5);
    const spot = { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
    if (!world.isFreeSpot(spot, NODE_SPACING) || !world.hasLineOfSight(p, spot)) continue;
    world.addFall(spot.x, spot.y, Math.round(FALL_POOL_MAX / 2));
    return;
  }
}
