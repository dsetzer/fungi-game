import { describe, expect, it } from "vitest";
import { distToSegmentSq } from "../src/sim/geometry";
import { distToPipeSq, pipeCurve, quadPoint } from "../src/render/pipePath";

/**
 * Hyphae are drawn as bowed curves. Hit-testing used to measure against the
 * straight line between the two nodes, so clicks only registered near the ends —
 * exactly where the curve meets that line.
 */
describe("hypha hit-testing", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  const [fromId, toId] = [1, 2];
  // Pick an id whose bend is substantial rather than incidentally near zero.
  const id = [...Array(50).keys()]
    .map((i) => i + 1)
    .sort(
      (p, q) =>
        Math.abs(pipeCurve(a, b, q, fromId, toId).c.y) -
        Math.abs(pipeCurve(a, b, p, fromId, toId).c.y),
    )[0];

  it("registers a click on the middle of the drawn curve", () => {
    const { c } = pipeCurve(a, b, id, fromId, toId);
    const mid = quadPoint(a, c, b, 0.5); // curve apex
    expect(Math.abs(mid.y)).toBeGreaterThan(12); // this curve really does bow
    expect(Math.sqrt(distToPipeSq(mid, a, b, id, fromId, toId))).toBeLessThan(2);
    // The old straight-line test would have missed it by the width of the bow.
    expect(Math.sqrt(distToSegmentSq(mid.x, mid.y, a.x, a.y, b.x, b.y))).toBeGreaterThan(12);
  });

  it("still matches near the endpoints, where curve and line coincide", () => {
    for (const p of [{ x: 8, y: 0 }, { x: 392, y: 0 }]) {
      expect(Math.sqrt(distToPipeSq(p, a, b, id, fromId, toId))).toBeLessThan(6);
    }
  });

  it("does not match points well away from the hypha", () => {
    expect(Math.sqrt(distToPipeSq({ x: 200, y: 300 }, a, b, id, fromId, toId))).toBeGreaterThan(100);
  });
});

describe("reversing a hypha", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 120 };

  it("keeps the curve exactly where it was, and only turns the flow around", () => {
    const forward = pipeCurve(a, b, 7, 1, 2);
    const reversed = pipeCurve(b, a, 7, 2, 1); // same hypha after a reverse
    expect(reversed.a).toEqual(forward.a);
    expect(reversed.b).toEqual(forward.b);
    expect(reversed.c).toEqual(forward.c); // the bow does not mirror
    expect(reversed.flipped).toBe(!forward.flipped); // only the arrows turn
  });

  it("stays clickable in the same places after reversing", () => {
    const { c } = pipeCurve(a, b, 7, 1, 2);
    const mid = quadPoint(a, c, b, 0.5);
    expect(Math.sqrt(distToPipeSq(mid, b, a, 7, 2, 1))).toBeLessThan(2);
  });
});
