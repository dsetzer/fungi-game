import { EJECT_BUFFER } from "../config";
import { dist } from "./geometry";
import type { GameNode, PlayerId } from "./types";
import type { World } from "./world";

/**
 * Placeholder AI so the arena isn't empty: keeps each colony fed from the
 * nearest fall (or a richer sibling) and expands toward untapped falls.
 * Issues ordinary Commands — it has no special access to the sim.
 */
export function runBot(world: World, player: PlayerId): void {
  const mine = [...world.nodes.values()].filter((n) => n.owner === player);
  if (mine.length === 0) return;
  const falls = [...world.nodes.values()].filter((n) => n.kind === "fall");

  const hasIncoming = (n: GameNode) => [...world.pipes.values()].some((p) => p.to === n.id);
  const byDistance = (from: GameNode) => (a: GameNode, b: GameNode) =>
    dist(from.x, from.y, a.x, a.y) - dist(from.x, from.y, b.x, b.y);

  // 1. Feed any colony that has no inflow.
  for (const n of mine) {
    if (hasIncoming(n)) continue;
    const sources = [
      ...falls.sort(byDistance(n)),
      ...mine.filter((m) => m !== n && m.nutrients > n.nutrients + 50).sort(byDistance(n)),
    ];
    const src = sources.find((s) => world.canConnect(player, s.id, n.id).ok);
    if (src) world.enqueue({ type: "connect", player, from: src.id, to: n.id });
  }

  // 2. Expand from the richest colony toward the nearest fall nobody here is draining yet.
  if (mine.length >= 6) return;
  const parent = mine.reduce((a, b) => (a.nutrients > b.nutrients ? a : b));
  if (parent.nutrients < 150) return;
  const tapped = new Set(
    [...world.pipes.values()].filter((p) => p.owner === player).map((p) => p.from),
  );
  const target = falls.filter((f) => !tapped.has(f.id)).sort(byDistance(parent))[0];
  if (!target) return;

  const d = dist(parent.x, parent.y, target.x, target.y);
  const step = Math.min(world.reachOf(parent) * 0.85, d - world.radiusOf(target) - EJECT_BUFFER);
  if (step <= world.radiusOf(parent) + 20) return;
  const p = {
    x: parent.x + ((target.x - parent.x) / d) * step,
    y: parent.y + ((target.y - parent.y) / d) * step,
  };
  if (world.canEject(player, parent.id, p).ok) {
    world.enqueue({ type: "eject", player, from: parent.id, ...p });
  }
}
