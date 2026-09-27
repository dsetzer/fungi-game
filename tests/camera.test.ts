import { describe, expect, it } from "vitest";
import { Camera } from "../src/render/camera";

function fly(camera: Camera, ms: number, stepMs: number) {
  for (let t = 0; t < ms; t += stepMs) camera.update(stepMs);
}

describe("camera fly-to", () => {
  it("eases toward the target and settles on it", () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.flyTo(1000, 0);

    camera.update(16);
    expect(camera.x).toBeGreaterThan(0); // moving…
    expect(camera.x).toBeLessThan(400); // …but not snapping there

    fly(camera, 1500, 16);
    expect(camera.x).toBeCloseTo(1000);
    expect(camera.flying).toBe(false); // stops fighting the player once arrived
  });

  it("arrives at the same place regardless of frame rate", () => {
    const smooth = new Camera();
    const choppy = new Camera();
    for (const c of [smooth, choppy]) {
      c.snapTo(0, 0);
      c.flyTo(800, 600);
    }
    fly(smooth, 480, 8); // ~120fps
    fly(choppy, 480, 48); // ~20fps
    expect(smooth.x).toBeCloseTo(choppy.x, 0);
    expect(smooth.y).toBeCloseTo(choppy.y, 0);
  });

  it("hands control back when the player pans or snaps", () => {
    const camera = new Camera();
    camera.flyTo(500, 500);
    camera.cancelFly();
    const { x, y } = camera;
    fly(camera, 500, 16);
    expect([camera.x, camera.y]).toEqual([x, y]);
  });

  it("keeps easing to the same world point across a zoom change", () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.width = 800;
    camera.height = 600;
    camera.flyTo(600, 0);
    camera.zoomAt(400, 300, 1.5);
    fly(camera, 1500, 16);
    expect(camera.x).toBeCloseTo(600);
  });
});

describe("camera drag-pan", () => {
  it("glides after the drag and settles exactly where it was dragged", () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    // A drag arrives as many small moves; each builds on the destination.
    for (let i = 0; i < 10; i++) camera.panBy(30, 0);
    camera.update(16);
    expect(camera.x).toBeGreaterThan(0); // following…
    expect(camera.x).toBeLessThan(300); // …but eased, not jumped
    fly(camera, 1000, 16);
    expect(camera.x).toBeCloseTo(300);
  });

  it("isn't cancelled by manual control, unlike a fly-to", () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.panBy(200, 0);
    camera.cancelFly(); // the wheel or keys taking over
    fly(camera, 1000, 16);
    expect(camera.x).toBeCloseTo(200);
  });

  it("takes over from a fly-to at wherever the camera is", () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.flyTo(1000, 0);
    fly(camera, 100, 16);
    const x = camera.x;
    camera.panBy(0, 50);
    fly(camera, 1000, 16);
    expect(camera.x).toBeCloseTo(x); // the throw-follow is abandoned
    expect(camera.y).toBeCloseTo(50);
  });

  it("keyboard panning carries a settling drag along", () => {
    const camera = new Camera();
    camera.snapTo(0, 0);
    camera.panBy(100, 0);
    camera.moveBy(0, 40);
    fly(camera, 1000, 16);
    expect(camera.x).toBeCloseTo(100);
    expect(camera.y).toBeCloseTo(40);
  });
});
