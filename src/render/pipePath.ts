import { distToSegmentSq, type Vec } from "../sim/geometry";

/**
 * The curve a hypha is drawn along. Hit-testing uses the same path: when it
 * hit-tested the straight line instead, only the ends of a hypha responded to
 * clicks, because the curve bows furthest from that line at its midpoint.
 */

/** Deterministic sideways bend so hyphae look organic rather than ruled. */
export function pipeControlPoint(a: Vec, b: Vec, id: number): Vec {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const bend = Math.sin(id * 12.9898) * 0.12;
  return { x: mx - dy * bend, y: my + dx * bend };
}

export function quadPoint(a: Vec, c: Vec, b: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

const SEGMENTS = 12;

/** Squared distance from a point to the drawn curve, sampled as a polyline. */
export function distToPipeSq(p: Vec, a: Vec, b: Vec, id: number): number {
  const c = pipeControlPoint(a, b, id);
  let best = Infinity;
  let prev = a;
  for (let i = 1; i <= SEGMENTS; i++) {
    const next = i === SEGMENTS ? b : quadPoint(a, c, b, i / SEGMENTS);
    const d = distToSegmentSq(p.x, p.y, prev.x, prev.y, next.x, next.y);
    if (d < best) best = d;
    prev = next;
  }
  return best;
}
