import type { EntityId } from "../sim/types";
import type { World } from "../sim/world";

/** How long a new hypha takes to shoot from its source to its target. */
export const GROW_MS = 350;
/** How long a new colony takes to swell into place once its hypha arrives. */
export const FORM_MS = 280;
/** The small bump a colony gives when a hypha lands on it. */
export const PULSE_MS = 220;

/**
 * Purely visual: the sim creates hyphae and colonies instantly, and this times
 * how they're drawn arriving. Births are recorded for everything in the world,
 * hidden by fog or not, so a rival hypha drifting into view doesn't replay its
 * growth. Whatever exists when a round is first seen is treated as already grown.
 */
export class GrowthTracker {
  private arena: World["arena"] | null = null;
  private pipeBorn = new Map<EntityId, number>();
  /** When each colony starts forming: after its hypha arrives, for an eject. */
  private nodeForms = new Map<EntityId, number>();

  update(world: World, now: number): void {
    const fresh = this.arena !== world.arena;
    if (fresh) {
      this.arena = world.arena;
      this.pipeBorn.clear();
      this.nodeForms.clear();
    }
    const at = fresh ? -Infinity : now;
    for (const p of world.pipes.values()) {
      if (!this.pipeBorn.has(p.id)) this.pipeBorn.set(p.id, at);
    }
    for (const n of world.nodes.values()) {
      if (this.nodeForms.has(n.id)) continue;
      // An ejected colony arrives with a hypha growing into it; it forms once
      // that hypha gets there rather than appearing ahead of it.
      const feeding = [...world.pipes.values()].some((p) => p.to === n.id && this.pipeBorn.get(p.id) === at);
      this.nodeForms.set(n.id, feeding ? at + GROW_MS : at);
    }
    if (this.pipeBorn.size > world.pipes.size * 2 + 64) prune(this.pipeBorn, world.pipes);
    if (this.nodeForms.size > world.nodes.size * 2 + 64) prune(this.nodeForms, world.nodes);
  }

  /** 0 → 1: how far along its length a hypha has grown. */
  grown(pipeId: EntityId, now: number): number {
    return clamp01((now - (this.pipeBorn.get(pipeId) ?? -Infinity)) / GROW_MS);
  }

  /** 0 → 1: how far a colony has formed; 0 means not drawn yet. */
  formed(nodeId: EntityId, now: number): number {
    return clamp01((now - (this.nodeForms.get(nodeId) ?? -Infinity)) / FORM_MS);
  }

  /** 0 → 1 → 0 over PULSE_MS after a hypha lands on this node; 0 otherwise. */
  pulse(world: World, nodeId: EntityId, now: number): number {
    let best = 0;
    for (const p of world.pipes.values()) {
      if (p.to !== nodeId) continue;
      const since = now - (this.pipeBorn.get(p.id) ?? -Infinity) - GROW_MS;
      if (since >= 0 && since < PULSE_MS) best = Math.max(best, Math.sin((since / PULSE_MS) * Math.PI));
    }
    return best;
  }
}

/** Overshoots a little before settling, so a forming colony lands with some weight. */
export function easeOutBack(t: number): number {
  const c = 1.70158;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function prune(map: Map<EntityId, number>, live: Map<EntityId, unknown>): void {
  for (const id of map.keys()) if (!live.has(id)) map.delete(id);
}
