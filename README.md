# Fungi Game

Real-time multiplayer .io game about growing a mycelial network — plant colonies, wire them
together with hyphae, and drain nutrients out of wild falls, out of rivals, or straight out of an
opponent's network while they try to do the same to you.

Modelled on an older browser game. The mechanics and the reference screenshots are written up in
[design-document.md](design-document.md).

## How it plays

You start as one colony with a small pool of nutrients. Nutrients only enter your network by
draining a **nutrient fall** or someone else's colony, and a colony that isn't being fed bleeds
upkeep until it withers. Everything is one gesture: **drag from a colony**. Drag to empty ground
and you throw a new colony there, carrying a share of the parent; drag onto another node and you
grow a hypha, which flows from where the drag started to where it ended — so dragging *out of* a
rival's colony is how you steal from it.

Terrain blocks hyphae as well as movement, so the cave walls decide who can reach whom, and walls
you build yourself can cut an attacker's line. Hyphae never cross each other either, so every line
is also a barrier. The round runs on a timer and the biggest gatherer wins.

## Run

```
npm install
npm run server     # authoritative game server on http://localhost:8787
npm run dev        # client dev server on http://localhost:5173
npm test           # sim, server, camera and bot specs (vitest)
npm run build      # typecheck + production build into dist/
```

The client opens on a menu: a name, a bot difficulty (Easy / Normal / Hard) and an optional server.
**Leave the server empty to play solo against bots.** On the dev server it's pre-filled with
`localhost:8787`, so Play joins your local server; if that server isn't running, the client plays
solo meanwhile and keeps retrying, switching to multiplayer the moment the server answers. When the
page is served by the game server itself, the field defaults to that server.

**Spectate** (next to Play on the menu) watches the whole arena, fog-free, without playing: a local
all-bot match when the server field is empty, or a live server's game when it isn't. Spectators get
no colony, can't issue commands, and don't count toward the arena size. **Stats** (or Tab) opens a
live panel with everyone's graphs and totals.

**Leaderboard:** players still in, ranked by the nutrients they hold right now; anyone wiped out is
greyed out at the bottom.

**Match stats:** when you're wiped out, win, or leave, a summary shows graphs of your nutrients in
and out (gathered, drained from rivals, spent, lost to rivals), nutrients held and colonies over time,
and a table of totals. Solo, it compares everyone; online, leaving mid-round shows only your own
(a rival's live numbers would see through the fog), and the round-end summary shows everyone's.

Open http://localhost:5173 in two tabs to play against yourself — add `?name=Armillaria` so the
tabs don't share a stored name. After `npm run build` the server also hosts the client itself on
port 8787.

### Hosting

**The real game is the server.** Like any .io game, players visit the game server's own web
address: after `npm run build` it serves the client and the game connection from the same place.

**GitHub Pages is a demo.** Every push to `main` runs the tests and publishes the client there
(`.github/workflows/pages.yml`), where it plays solo against bots. Pages is static, so it can't host
the Node server. A visitor can enter a server to join, but a page served over https can only reach
servers using **wss**, so a remote server joined from Pages must serve wss. Two ways:

- **Serve wss directly:** set `TLS_CERT` and `TLS_KEY` to the paths of a PEM certificate and key
  (e.g. from Let's Encrypt for a domain pointing at the machine), and the server speaks https/wss
  on the same port. A self-signed certificate won't be accepted by browsers.
- **Use a tunnel** (Cloudflare Tunnel, ngrok): run the server as normal and let the tunnel provide
  the https address. Players enter it in full, e.g. `wss://example.trycloudflare.com`.

## Controls

| Input | Action |
|---|---|
| Left-drag from a node → empty space | Throw a new colony, auto-connected by a hypha from its parent |
| Wheel **while dragging** | Share of the parent the new colony carries (15–90%, default 65%, 5% per notch) |
| Left-drag from a node → another node | Grow a hypha; nutrients flow from drag start → drag end (drag *from* a rival to drain them) |
| Left-click a hypha | Reverse which way it flows (only hyphae you grew) |
| Right-drag from your colony | Build a wall (⊢): both the stem and the crossbar block line of sight |
| Right-click your wall / your hypha | Demolish it / cut it (only hyphae you grew) |
| Right-drag from anywhere else, or WASD | Pan |
| Mouse wheel | Zoom |
| R | New round (solo and spectated local matches only) |
| Tab | Live stats panel (spectating) |
| F | Toggle the render profiler |

## Multiplayer

- **Authoritative server.** `server/` runs the same `src/sim/` code. Clients send `Command`s and
  receive snapshots; nothing is simulated client-side, and a forged player id is re-stamped.
- **Fog of war is enforced server-side** — each player's snapshot contains only what they can see,
  so hidden state never reaches the browser.
- **Terrain is never sent.** The client regenerates the identical arena from the round's seed,
  player count and radius.
- **Rounds run 10 minutes,** with a 12-second intermission. Players join at any time; a wiped-out
  player is out and sees their summary, and **Play again** drops them back into the running round
  as a fresh player. People come and go throughout, so the winner is whoever gathered the most (score = nutrients drawn into your network from falls or
  rivals). The arena is regenerated each round at a size scaled to the number of players (spectators
  excluded): radius 5400 for four players, growing with the square root of the count, between 2800
  and 12000. The arena is fixed for the length of a round; someone who joins mid-round is dropped
  into the existing map at the best free spot, with a fall cluster seeded beside them if there is
  no food nearby.

## Layout

```
src/
  config.ts          every tuning number, plus the size / reach / aura curves
  sim/               pure game logic — no DOM, runs headless on the server and in tests
    world.ts         state, rule checks (canEject/canConnect/canReverse/...), the tick
    arena.ts         seeded cave generation + WallIndex for line-of-sight queries
    spawn.ts         where a joining or respawning player lands
    vision.ts        fog-of-war queries, used by the server to filter snapshots
    stats.ts         per-player match stats and history, and their wire format
    bot/             computer players (bot-design.md); issue ordinary Commands, no special access
    match.ts         one authoritative tick (bots + world.step)
    geometry.ts      segment/circle maths, seeded RNG
    types.ts         entities + the Command union
  render/            Canvas 2D renderer
    territory.ts     metaball "fluid" auras (WebGL2 shader, CPU fallback)
    fog.ts           vision, remembered ground, the grey overlay
    terrain.ts       cached terrain image for zoomed-out frames
    growth.ts        purely visual timing for new hyphae and colonies
    camera.ts        eased fly-to camera
  net/               protocol (shared with the server) + client connection
  input/             mouse/keyboard → Commands
  ui/statsPanel.ts   the stats panel: graphs and totals
  main.ts            menu, fixed-timestep loop, HUD, solo fallback
server/              rounds, join/respawn, per-player snapshots
tests/               vitest specs for the sim, bots, stats, the server room and the camera
tools/mapgen/        experimental map-generator previews; not used by the game (see below)
reference/           screenshots of the original game
```

Every player action is a `Command` queued into the `World` and applied at the start of the next
tick — the same path locally and over the network.

### Map generator experiments

`tools/mapgen/` holds standalone scripts that draw and test a proposed replacement for the arena
generator. Nothing in `src/` uses them.

```
npx tsx tools/mapgen/preview.ts [seed ...]   # writes tools/mapgen/out/index.html
npx tsx tools/mapgen/check.ts [seeds]        # connectivity, speed and fairness checks
```

## Computer players

Bots play by the same rules as a person and issue ordinary Commands (`src/sim/bot/`, designed in
[bot-design.md](bot-design.md)). Three layers run every time a bot looks: a **strategy** state
machine picks a posture (opening, expand, consolidate, war, defend) from its live stats; **tasks**
carry multi-step plans as state machines — expeditions that path round terrain, wall-then-sever,
Harvest loops, boost holds, sieges; **reflexes** keep the network healthy — taps, supply lines,
reversals, rings, relinking pieces, walls, drains, Flow. Every candidate is priced on one scale,
weighted by the posture, checked against the rules best-first, and the best legal one is taken.
Difficulty is hands, reaction and temperament: one action at a time with a gap after each
(Easy 5 s, Normal 2 s, Hard 1.4 s on average, each varied ±40%); a reaction delay before answering anything new that comes
into contact (5 s, 3 s, 1.5 s); and what it reaches for — easy walls rivals off on sight, hard
latches on and drains them. A bot stops throwing at 40 colonies. The difficulty picked sets a mix,
so no two bots are quite equal: Easy is all easy bots, Normal is normal, normal and easy, Hard is
hard, hard and normal; each bot's level shows in its name.

## Decisions made for open design items

The design doc leaves these open; these are the prototype's answers, all in `config.ts` unless
noted.

- **Ejecting:** carries a share of the parent (default 65%, wheel-adjustable) rather than a flat
  amount, so a rich colony throws a child strong enough to throw again. Minimum throw 12, parent
  always keeps 5.
- **Reach:** `220 + 20·√nutrients`, capped at 600 (`MAX_REACH`), so a colony never reaches across
  the map however rich it gets. It governs throwing, connecting and building walls alike.
- **Upkeep:** 1/s, charged only to colonies that aren't sustained — a colony with inflow that
  isn't sending out more than it receives pays nothing, so relays don't wither.
- **Gathering:** hyphae run at 10/s, and every hypha is 1:1 — ten out of a fall arrive as ten.
  Feeding a fall while draining it holds its pool flat but nets nothing, unless you hold the
  Harvest boost, which doubles your fall lines' yield and turns that loop into +10/s forever.
  That loop is the prize, and it's contestable: a rival's drain line pushes the
  fall's outflow past what you feed it, and since a fall respawns somewhere random rather than
  where it was, emptying one kills that income for good. Colony-to-colony transfers are 1:1, so a ring of colonies with
  no fall in it generates nothing.
- **Fall respawning:** while the map holds fewer falls than it started with, a new group (1–6)
  appears every 6 s somewhere random, open and outside everyone's territory. The server's map
  starts with neutral groups scattered across it too (70 on a standard arena, scaled by area).
- **Attacking:** a hypha draining a *rival* is an ordinary hypha — the same 10/s as any other,
  1:1. To drain a colony faster than its owner can feed it, put more hyphae on it (funnelling).
- **Pipe caps:** only outgoing hyphae are capped (4 per colony); incoming is unlimited, so
  funnelling and reinforcing always work. The cap counts only hyphae *you* grew, so a rival's
  drain line doesn't spend one of your slots — and a colony that has spent all four is still
  attackable. Falls are uncapped. Only one hypha can join any pair of nodes.
- **No crossing:** a new hypha, throw included, is refused if it would cross an existing one,
  whoever grew it. Hyphae meeting at a shared node don't count.
- **Reversing:** only the player who grew a hypha can flip it — being drained is answered by
  cutting, not by commandeering the attacker's hypha.
- **Cutting:** only the player who grew a hypha can cut it, wherever its ends are. Being drained
  is answered by killing the colony on the far end, walling the line, or out-draining them — not
  by snipping the attacker's hypha off your own colony.
- **Territory:** a colony's blob is that player's ground. Rivals can't plant inside it, only around
  its edge, so reaching a node buried in a big network takes enough reach to span the blob. Neutral
  falls hold no territory.
- **Walls:** 15 nutrients, max 3 per colony, fixed 120-unit crossbar. A new wall does *not*
  sever hyphae already crossing it — walling over your own established lines while denying the
  ground to everyone else is the point of placing one well. It blocks line of sight, so it stops
  new connections and ejections across it, and that is all it does.
- **Line of sight:** checked when a hypha is grown, and blocked by terrain and walls (stem and crossbar) alike.
- **Fog of war:** colonies see 1.15× their reach (minimum 520). Explored ground stays remembered:
  terrain and falls persist, rivals only show while in sight.
- **Map:** seeded cave terrain, regenerated each round: a grid of about nine thousand small wall
  circles produced by cellular automata, with a nutrient-fall cluster beside every spawn and 70
  more scattered around.
- **Camera:** eases to a new colony when you throw one; any pan or zoom hands control straight
  back (`CAMERA_FLY_TAU_MS`, `CAMERA_FLY_ON_EJECT`).
- **Falls pay upkeep:** no (`FALLS_PAY_UPKEEP`).

## Known gaps

- **A closed loop of colonies never loses nutrients.** Each one receives exactly what it sends, so
  all count as sustained: a ring survives indefinitely with no income.
- **Bots see the whole map** and only play local rounds; online rounds have no AI opponents.
- **The arena doesn't grow mid-round.** It is sized once for the players present at round start;
  late joiners share the map that was generated for fewer.
- **The server is unauthenticated** and has no rate limiting — fine on a LAN, not for exposing.
