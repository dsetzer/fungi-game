import { describe, expect, it } from "vitest";
import { distToSegmentSq } from "../src/sim/geometry";
import { distToPipeSq, pipeControlPoint } from "../src/render/pipePath";

/**
 * Hyphae are drawn as bowed curves. Hit-testing used to measure against the
 * straight line between the two nodes, so clicks only registered near the ends —
 * exactly where the curve meets that line.
 */
describe("hypha hit-testing", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  // Pick an id whose bend is substantial rather than incidentally near zero.
  const id = [...Array(50).keys()]
    .map((i) => i + 1)
    .sort((p, q) => Math.abs(pipeControlPoint(a, b, q).y) - Math.abs(pipeControlPoint(a, b, p).y))[0];

  it("registers a click on the middle of the drawn curve", () => {
    const mid = { x: (a.x + b.x) / 2, y: pipeControlPoint(a, b, id).y / 2 }; // curve apex
    expect(Math.abs(mid.y)).toBeGreaterThan(12); // this curve really does bow
    expect(Math.sqrt(distToPipeSq(mid, a, b, id))).toBeLessThan(2);
    // The old straight-line test would have missed it by the width of the bow.
    expect(Math.sqrt(distToSegmentSq(mid.x, mid.y, a.x, a.y, b.x, b.y))).toBeGreaterThan(12);
  });

  it("still matches near the endpoints, where curve and line coincide", () => {
    for (const p of [{ x: 8, y: 0 }, { x: 392, y: 0 }]) {
      expect(Math.sqrt(distToPipeSq(p, a, b, id))).toBeLessThan(6);
    }
  });

  it("does not match points well away from the hypha", () => {
    expect(Math.sqrt(distToPipeSq({ x: 200, y: 300 }, a, b, id))).toBeGreaterThan(100);
  });
});
