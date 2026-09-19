import { ROUND_RESTART_DELAY_MS, TICK_MS } from "./config";
import { Input } from "./input/input";
import { Camera } from "./render/camera";
import { Renderer } from "./render/renderer";
import { stepMatch } from "./sim/match";
import { World } from "./sim/world";

const HUMAN = 1;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const banner = document.getElementById("banner")!;

const camera = new Camera();
const renderer = new Renderer(canvas, camera);
let world = newRound();
const input = new Input(canvas, camera, () => world, HUMAN);

let restartTimer: number | undefined;

// Dev-only handle for poking at state from the browser console: `game.world`.
if (import.meta.env.DEV) {
  Object.assign(window, { game: { get world() { return world; }, restart } });
}

function newRound(): World {
  const w = World.createMatch((Math.random() * 2 ** 31) | 0);
  const home = [...w.nodes.values()].find((n) => n.owner === HUMAN);
  if (home) {
    camera.x = home.x;
    camera.y = home.y;
  }
  banner.hidden = true;
  return w;
}

function restart(): void {
  clearTimeout(restartTimer);
  restartTimer = undefined;
  world = newRound();
}

window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r") restart();
});
window.addEventListener("resize", () => renderer.resize());
renderer.resize();

function updateHud(): void {
  const mine = [...world.nodes.values()].filter((n) => n.owner === HUMAN);
  const total = mine.reduce((s, n) => s + n.nutrients, 0);
  const rivals = world.players.filter((p) => p.id !== HUMAN && p.alive).length;
  hud.innerHTML =
    `Colonies: <b>${mine.length}</b> · Nutrients: <b>${Math.floor(total)}</b><br>` +
    `Rivals alive: ${rivals}`;

  if (world.ended && restartTimer === undefined) {
    const won = world.winner === HUMAN;
    banner.innerHTML = `${won ? "Your network prevails" : "Your network withered"}<small>New substrate in a moment… (or press R)</small>`;
    banner.hidden = false;
    restartTimer = window.setTimeout(restart, ROUND_RESTART_DELAY_MS);
  }
}

// Fixed-timestep sim, render every animation frame.
let last = performance.now();
let acc = 0;
function frame(now: number): void {
  const dt = Math.min(250, now - last);
  last = now;
  acc += dt;
  while (acc >= TICK_MS) {
    stepMatch(world);
    acc -= TICK_MS;
  }
  input.update(dt);
  renderer.draw(world, input, now, HUMAN);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
