import { ROUND_RESTART_DELAY_MS, SERVER_PORT, SIM_HZ, TICK_MS } from "./config";
import { ABILITY_KEYS, Input } from "./input/input";
import { NetClient } from "./net/client";
import { Camera } from "./render/camera";
import { BOOST_NAMES, Renderer } from "./render/renderer";
import { emptyArena } from "./sim/arena";
import { stepMatch } from "./sim/match";
import type { BotLevel } from "./sim/bot";
import { BOOST_KINDS, type BoostKind, type Command, type PlayerId } from "./sim/types";
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
const menuLevel = document.getElementById("menu-level") as HTMLSelectElement;
const leaveButton = document.getElementById("leave") as HTMLButtonElement;
const abilityBar = document.getElementById("abilities")!;

const camera = new Camera();
const renderer = new Renderer(canvas, camera);

/** Solo fallback: a local match with bots, used until/unless a server answers. */
let solo: World | null = null;
let soloRestart: number | undefined;
let centredOn: unknown = null;

/** Null until the player picks a server on the menu; solo play never makes one. */
let net: NetClient | null = null;
/** Watching the whole arena rather than playing: no fog, no commands. */
let spectating = false;
/** Nobody's id: what a spectator is, for everything that asks "whose is this?". */
const SPECTATOR: PlayerId = 0;

// The menu: a name, and optionally a server. Empty server = solo against bots, so
// a build hosted without a game server (GitHub Pages) still plays.
menuName.value = pickName();
document.getElementById("menu-version")!.textContent = __APP_VERSION__;
menuServer.value = defaultServer();
menuLevel.value = localStorage.getItem("fungi.level") ?? "normal";
/** How fast the solo bots may act (spectated matches too). */
let botLevel: BotLevel = "normal";
menu.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = menuName.value.trim().slice(0, 16) || pickName();
  const server = menuServer.value.trim();
  localStorage.setItem("fungi.name", name);
  localStorage.setItem("fungi.server", server);
  botLevel = menuLevel.value as BotLevel;
  localStorage.setItem("fungi.level", botLevel);
  menu.hidden = true;
  leaveButton.hidden = false;
  // Spectate: with no server, watch a local all-bot match; with one, watch it live.
  spectating = (e as SubmitEvent).submitter?.id === "menu-spectate";
  renderer.spectate = spectating;
  input.readOnly = spectating;
  if (server) connectTo(server, name);
  else startSolo();
});

/**
 * Back to the menu from any game: disconnects from the server (which drops our
 * colonies, as when a tab closes), ends a solo match, and stops spectating.
 */
function leaveToMenu(): void {
  net?.close();
  net = null;
  solo = null;
  clearTimeout(soloRestart);
  soloRestart = undefined;
  spectating = false;
  renderer.spectate = false;
  input.readOnly = false;
  input.cancelGestures();
  centredOn = null;
  banner.hidden = true;
  menu.hidden = false;
  leaveButton.hidden = true;
}
leaveButton.addEventListener("click", leaveToMenu);

function connectTo(server: string, name: string): void {
  net = new NetClient(serverUrl(server), name, spectating);
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
const currentPlayer = () => (spectating ? SPECTATOR : net?.world ? net.you : SOLO_PLAYER);
const sendCommand = (cmd: Command) => {
  if (spectating) return;
  if (net?.world) net.enqueue(cmd);
  else solo?.enqueue(cmd);
};

const input = new Input(canvas, camera, currentWorld, currentPlayer, sendCommand);

/**
 * The boosts you hold (§6.7), along the bottom: passive ones as labels, the two
 * abilities as buttons with their hotkeys and cooldowns. Built once and updated
 * in place, so a click is never lost to the HUD rebuilding under the pointer.
 */
const PASSIVE_EFFECT: Partial<Record<BoostKind, string>> = {
  branch: "8 outputs", reach: "+reach", vision: "+vision", harvest: "2× from falls", siphon: "2× drains",
  rind: "½ drains on you", chitin: "no Sever",
};
const HOTKEY: Partial<Record<BoostKind, string>> = Object.fromEntries(
  Object.entries(ABILITY_KEYS).map(([key, ability]) => [ability, key]),
);
const boostSlots = new Map<BoostKind, HTMLElement>();
for (const kind of BOOST_KINDS) {
  const hotkey = HOTKEY[kind];
  const el = document.createElement(hotkey ? "button" : "span");
  el.hidden = true;
  if (hotkey) el.addEventListener("click", () => input.fire(kind as "flow" | "sever"));
  abilityBar.append(el);
  boostSlots.set(kind, el);
}

function updateAbilities(): void {
  const world = currentWorld();
  const me = currentPlayer();
  const abilities = world.player(me)?.abilities;
  const secs = (tick: number) => Math.ceil((tick - world.tick) / SIM_HZ);
  let any = false;
  for (const [kind, el] of boostSlots) {
    el.hidden = spectating || !world.holds(me, kind);
    if (el.hidden) continue;
    any = true;
    const hotkey = HOTKEY[kind];
    if (!hotkey || !abilities) {
      el.textContent = `${BOOST_NAMES[kind]} · ${PASSIVE_EFFECT[kind]}`;
      continue;
    }
    let state = "";
    let on = false;
    if (kind === "flow" && world.flowActive(me)) {
      state = ` · ${secs(abilities.flowUntil)}s`;
      on = true;
    } else if (kind === "sever" && input.armed === "sever") {
      state = " · pick a hypha";
      on = true;
    } else {
      const ready = kind === "flow" ? abilities.flowReadyAt : abilities.severReadyAt;
      if (ready > world.tick) state = ` · ${secs(ready)}s`;
    }
    const button = el as HTMLButtonElement;
    button.disabled = !on && state !== "";
    button.classList.toggle("on", on);
    const html = `<kbd>${hotkey}</kbd>${BOOST_NAMES[kind]}${state}`;
    if (button.dataset.html !== html) {
      button.dataset.html = html;
      button.innerHTML = html;
    }
  }
  abilityBar.hidden = !any || !menu.hidden;
}

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
 * The server field starts with the last one used. Failing that it depends on
 * where the page came from:
 * - served by the game server itself (the real .io setup) → that same server, so
 *   Play joins the game you're on;
 * - the Vite dev server → the local game server on its own port;
 * - a static demo build (GitHub Pages, VITE_STATIC_DEMO=1) → empty, meaning solo.
 */
function defaultServer(): string {
  const saved = localStorage.getItem("fungi.server");
  if (saved !== null) return saved;
  if (import.meta.env.VITE_STATIC_DEMO === "1") return "";
  if (import.meta.env.DEV) return `${location.hostname}:${SERVER_PORT}`;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
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
  solo = World.createMatch((Math.random() * 2 ** 31) | 0, undefined, spectating);
  solo.botLevel = botLevel;
  centredOn = null;
}

function restartSolo(): void {
  clearTimeout(soloRestart);
  soloRestart = undefined;
  solo = World.createMatch((Math.random() * 2 ** 31) | 0, undefined, spectating);
  solo.botLevel = botLevel;
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

/**
 * Snap the camera to your colony when a round (or the connection) begins; a
 * spectator gets the whole arena fitted to the screen instead.
 */
function centreOnHome(): void {
  const world = currentWorld();
  if (centredOn === world.arena) return;
  if (spectating) {
    if (world === placeholder) return;
    const fit = Math.min(camera.width, camera.height) / (world.arena.radius * 2 * 1.05);
    camera.snapTo(0, 0);
    camera.zoom = Math.max(0.045, fit);
    centredOn = world.arena;
    return;
  }
  const home = [...world.nodes.values()].find((n) => n.owner === currentPlayer());
  if (!home) return;
  // A new round is a new map: jump rather than fly across the whole arena.
  camera.snapTo(home.x, home.y);
  centredOn = world.arena;
}

function updateHud(): void {
  hud.hidden = !menu.hidden; // nothing to report until a game has started
  updateAbilities();
  const world = currentWorld();
  const me = currentPlayer();
  const mine = [...world.nodes.values()].filter((n) => n.owner === me && n.kind === "colony");
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

  const watching = spectating ? "spectating · " : "";
  const mode = net?.connected
    ? `${watching}${net.online} online · round ${formatTime(net.endsIn)}`
    : solo
      ? net
        ? "offline · solo with bots (retrying server)"
        : spectating
          ? `spectating · ${botLevel} bots (R = new match)`
          : `solo · ${botLevel} bots`
      : net
        ? "connecting…"
        : "";
  hud.innerHTML =
    `<table>${rows.join("")}</table>` +
    (spectating ? "" : `<div class="stats">Colonies: <b>${mine.length}</b> · Nutrients: <b>${total}</b></div>`) +
    `<div class="mode">${mode}</div>`;

  if (net?.status === "intermission") {
    banner.innerHTML = `${net.winner ? `${escape(net.winner.name)} gathered the most` : "Round over"}<small>New substrate in a moment…</small>`;
    banner.hidden = false;
  } else if (solo && solo.ended && soloRestart === undefined) {
    const won = solo.winner === SOLO_PLAYER;
    const winner = solo.winner == null ? null : solo.player(solo.winner);
    const headline = spectating
      ? winner ? `${escape(winner.name)} prevails` : "Every network withered"
      : won ? "Your network prevails" : "Your network withered";
    banner.innerHTML = `${headline}<small>New substrate in a moment… (or press R)</small>`;
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
