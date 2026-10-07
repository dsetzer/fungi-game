import type { Vec } from "./geometry";
import type { EntityId, GameNode, PlayerId } from "./types";
import type { World } from "./world";

/**
 * Fog of war (§8), as a sim-level query so the server can decide what each
 * player is allowed to receive — not just what the client chooses to draw.
 */
export function visionRadius(world: World, colony: GameNode): number {
  return world.visionOf(colony);
}

/** Vision circles belonging to one player. */
export function eyesOf(world: World, player: PlayerId): { x: number; y: number; r: number }[] {
  const eyes: { x: number; y: number; r: number }[] = [];
  for (const n of world.nodes.values()) {
    if (n.owner === player) eyes.push({ x: n.x, y: n.y, r: visionRadius(world, n) });
  }
  return eyes;
}

/** True if any eye sees the point, or — with `margin` — any part of a disc that wide around it. */
export function canSee(eyes: { x: number; y: number; r: number }[], p: Vec, margin = 0): boolean {
  return eyes.some((e) => Math.hypot(e.x - p.x, e.y - p.y) <= e.r + margin);
}

/**
 * Nodes a player may know about right now: their own, plus anything in sight.
 * A node counts as in sight once any of its aura is: a rival's territory reaching
 * into your vision gives the colony away, even with its core still in the fog.
 */
export function visibleNodes(world: World, player: PlayerId): Set<EntityId> {
  const eyes = eyesOf(world, player);
  const out = new Set<EntityId>();
  for (const n of world.nodes.values()) {
    if (n.owner === player || canSee(eyes, n, world.auraOf(n))) out.add(n.id);
  }
  return out;
}
