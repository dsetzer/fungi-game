import { ROUND_RESTART_DELAY_MS, SERVER_PORT, TICK_MS } from "./config";
import { Input } from "./input/input";
import { NetClient } from "./net/client";
import { Camera } from "./render/camera";
import { Renderer } from "./render/renderer";
import { emptyArena } from "./sim/arena";
import { stepMatch } from "./sim/match";
import type { Command, PlayerId } from "./sim/types";
import { World } from "./sim/world";

const SOLO_PLAYER: PlayerId = 1;
const GENERA = [
  "Armillaria", "Pyrenophora", "Erysiphe", "Uromyces", "Lirula", "Cytospora",
  "Epichloe", "Lentinus", "Alternaria", "Tubercularia", "Sphacelotheca",
];

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const banner = document.getElementById("banner")!;
const menu = document.getElementById("menu") as HTMLFormElement;
const menuName = document.getElementById("menu-name") as HTMLInputElement;
const menuServer = document.getElementById("menu-server") as HTMLInputElement;

const camera = new Camera();
const renderer = new Renderer(canvas, camera);

/** Solo fallback: a local match with bots, used until/unless a server answers. */
let solo: World | null = null;
let soloRestart: number | undefined;
let centredOn: unknown = null;

/** Null until the player picks a server on the menu; solo play never makes one. */
let net: NetClient | null = null;

// The menu: a name, and optionally a server. Empty server = solo against bots, so
// a build hosted without a game server (GitHub Pages) still plays.
menuName.value = pickName();
menuServer.value = defaultServer();
menu.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = menuName.value.trim().slice(0, 16) || pickName();
  const server = menuServer.value.trim();
  localStorage.setItem("fungi.name", name);
  localStorage.setItem("fungi.server", server);
  menu.hidden = true;
  if (server) connectTo(server, name);
  else startSolo();
});

function connectTo(server: string, name: string): void {
  net = new NetClient(serverUrl(server), name);
  net.onOffline = () => startSolo();
  net.onOnline = () => {
    solo = null; // the server is authoritative again
    clearTimeout(soloRestart);
    soloRestart = undefined;
    centredOn = null;
    banner.hidden = true;
  };
  net.onRound = () => {
    centredOn = null;
    banner.hidden = true;
  };
  net.connect();
}

const placeholder = new World(emptyArena(1000));
const currentWorld = () => net?.world ?? solo ?? placeholder;
const currentPlayer = () => (net?.world ? net.you : SOLO_PLAYER);
const sendCommand = (cmd: Command) => {
  if (net?.world) net.enqueue(cmd);
  else solo?.enqueue(cmd);
};

const input = new Input(canvas, camera, currentWorld, currentPlayer, sendCommand);

/**
 * What the player typed, as a WebSocket URL. Accepts a full ws:// or wss:// URL,
 * host:port, or a bare host (the default game port is assumed). An https page may
 * only open wss:// connections, so the scheme follows the page's.
 */
function serverUrl(server: string): string {
  if (/^wss?:\/\//i.test(server)) return server;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const host = /:\d+$/.test(server) ? server : `${server}:${SERVER_PORT}`;
  return `${proto}://${host}`;
}

/**
 * The server field starts with the last one used. Failing that, running locally
 * or served by the game server itself suggests that server, so local play is
 * still one click; anywhere else (a static host) it starts empty, meaning solo.
 */
function defaultServer(): string {
  const saved = localStorage.getItem("fungi.server");
  if (saved !== null) return saved;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (local || location.port === String(SERVER_PORT)) return `${location.hostname}:${SERVER_PORT}`;
  return "";
}

function pickName(): string {
  // ?name=… wins: tabs on one origin share localStorage, so testing two players
  // on the same machine needs a per-tab override.
  const fromUrl = new URLSearchParams(location.search).get("name");
  if (fromUrl) return fromUrl.slice(0, 16);
  const saved = localStorage.getItem("fungi.name");
  if (saved) return saved;
  return GENERA[Math.floor(Math.random() * GENERA.length)];
}

function startSolo(): void {
  if (solo) return;
  solo = World.createMatch((Math.random() * 2 ** 31) | 0);
  centredOn = null;
}

function restartSolo(): void {
  clearTimeout(soloRestart);
  soloRestart = undefined;
  solo = World.createMatch((Math.random() * 2 ** 31) | 0);
  centredOn = null;
  banner.hidden = true;
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return; // typing on the menu
  if (e.key.toLowerCase() === "r" && solo) restartSolo();
  if (e.key.toLowerCase() === "f") renderer.showPerf = !renderer.showPerf;
});
window.addEventListener("resize", () => renderer.resize());
renderer.resize();

/** Snap the camera to your colony when a round (or the connection) begins. */
function centreOnHome(): void {
  const world = currentWorld();
  if (centredOn === world.arena) return;
  const home = [...world.nodes.values()].find((n) => n.owner === currentPlayer());
  if (!home) return;
  // A new round is a new map: jump rather than fly across the whole arena.
  camera.snapTo(home.x, home.y);
  centredOn = world.arena;
}

function updateHud(): void {
  hud.hidden = !menu.hidden; // nothing to report until a game has started
  const world = currentWorld();
  const me = currentPlayer();
  const mine = [...world.nodes.values()].filter((n) => n.owner === me);
  const total = Math.floor(mine.reduce((s, n) => s + n.nutrients, 0));

  const ranked = [...world.players].filter(Boolean).sort((a, b) => b.score - a.score);
  const rows = ranked.slice(0, 5).map((p, i) => {
    const you = p.id === me ? " you" : "";
    return `<tr class="${you.trim()}"><td>${i + 1}.</td><td><i style="background:${p.color}"></i>${escape(p.name)}</td><td>${Math.round(p.score).toLocaleString()}</td></tr>`;
  });
  const myRank = ranked.findIndex((p) => p.id === me);
  if (myRank >= 5) {
    const p = ranked[myRank];
    rows.push(`<tr class="you"><td>${myRank + 1}.</td><td><i style="background:${p.color}"></i>${escape(p.name)}</td><td>${Math.round(p.score).toLocaleString()}</td></tr>`);
  }

  const mode = net?.connected
    ? `${net.online} online · round ${formatTime(net.endsIn)}`
    : solo
      ? net
        ? "offline · solo with bots (retrying server)"
        : "solo with bots"
      : net
        ? "connecting…"
        : "";
  hud.innerHTML =
    `<table>${rows.join("")}</table>` +
    `<div class="stats">Colonies: <b>${mine.length}</b> · Nutrients: <b>${total}</b></div>` +
    `<div class="mode">${mode}</div>`;

  if (net?.status === "intermission") {
    banner.innerHTML = `${net.winner ? `${escape(net.winner.name)} gathered the most` : "Round over"}<small>New substrate in a moment…</small>`;
    banner.hidden = false;
  } else if (solo && solo.ended && soloRestart === undefined) {
    const won = solo.winner === SOLO_PLAYER;
    banner.innerHTML = `${won ? "Your network prevails" : "Your network withered"}<small>New substrate in a moment… (or press R)</small>`;
    banner.hidden = false;
    soloRestart = window.setTimeout(restartSolo, ROUND_RESTART_DELAY_MS);
  } else if (!solo?.ended) {
    banner.hidden = true;
  }
}

const escape = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
const formatTime = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

// Fixed-timestep loop. Online the server drives the sim and we only render
// snapshots; offline we step the local match ourselves.
let last = performance.now();
let acc = 0;
let reportedError = false;
let lastHud = 0;
function frame(now: number): void {
  const dt = Math.min(250, now - last);
  last = now;
  acc += dt;
  while (acc >= TICK_MS) {
    if (!net?.world && solo) stepMatch(solo);
    acc -= TICK_MS;
  }
  // One bad frame must never stop the loop: before this guard, a render error
  // meant requestAnimationFrame was never called again and the game froze.
  try {
    centreOnHome();
    input.update(dt);
    camera.update(dt);
    renderer.draw(currentWorld(), input, now, currentPlayer());
    // The HUD rebuilds its DOM, so it runs a few times a second, not every frame.
    if (now - lastHud > 200) {
      lastHud = now;
      updateHud();
    }
  } catch (err) {
    if (!reportedError) {
      reportedError = true;
      console.error("render error (continuing):", err);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    game: {
      get world() { return currentWorld(); },
      get player() { return currentPlayer(); },
      get net() { return net; }, renderer, camera, input, get perf() { return renderer.perf; }, get solo() { return solo; },
    },
  });
}
