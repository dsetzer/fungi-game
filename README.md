# Fungi Game

Real-time multiplayer .io game about growing a mycelial network — plant colonies, wire them
together with hyphae, and drain nutrients out of wild falls, out of rivals, or straight out of an
opponent's network while they try to do the same to you.

Reconstructed from memory of an older browser game, with the mechanics and the reference
screenshots written up in [design-document.md](design-document.md).

## How it plays

You start as one colony with a fixed pool of nutrients. Nutrients only enter your network by
draining a **nutrient fall** or someone else's colony, and a colony that isn't being fed bleeds
upkeep until it withers. Everything is one gesture: **drag from a colony**. Drag to empty ground
and you throw a new colony there, carrying a share of the parent; drag onto another node and you
grow a hypha, which flows from where the drag started to where it ended — so dragging *out of* a
rival's colony is how you steal from it.

Terrain blocks hyphae as well as movement, so the cave walls decide who can reach whom, and walls
you build yourself can cut an attacker's line. The round runs on a timer and the biggest gatherer
wins.

## Run

```
npm install
npm run server     # authoritative game server on http://localhost:8787
npm run dev        # client dev server on http://localhost:5173
npm test           # 49 sim, server, camera and geometry specs (vitest)
npm run build      # typecheck + production build into dist/
```

Open http://localhost:5173 in two tabs to play against yourself — add `?name=Armillaria` so the
tabs don't share a stored name. **With no server running the client plays solo against bots** and
keeps retrying, switching to multiplayer the moment the server answers. After `npm run build` the
server also hosts the client itself on port 8787.

## Controls

| Input | Action |
|---|---|
| Left-drag from a node → empty space | Throw a new colony, auto-connected by a hypha from its parent |
| Wheel **while dragging** | Share of the parent the new colony carries (15–90%, default 65%) — scroll up for long exploration runs |
| Left-drag from a node → another node | Grow a hypha; nutrients flow from drag start → drag end (drag *from* a rival to drain them) |
| Left-click a hypha | Reverse which way it flows (only hyphae you grew) |
| Right-drag from your colony | Build a wall (⊢): the crossbar blocks line of sight |
| Right-click your wall / a hypha | Demolish it / cut it |
| Right-drag empty space, or WASD | Pan |
| Mouse wheel | Zoom |
| R | New round (solo only) |
| F | Render profiler: per-stage ms, and whether auras run on GPU or CPU |

## Multiplayer

- **Authoritative server.** `server/` runs the same `src/sim/` code. Clients send `Command`s and
  receive snapshots; nothing is simulated client-side, and a forged player id is re-stamped.
- **Fog of war is enforced server-side** — each player's snapshot contains only what they can see,
  so hidden state never reaches the browser.
- **Terrain is never sent.** The client regenerates the identical arena from the round's seed.
- **Rounds run 10 minutes.** Players join and respawn instantly, so the winner is whoever gathered
  the most (score = nutrients drawn into your network from falls or rivals). The arena is then
  regenerated at a size scaled to the player count.

## Layout

```
src/
  config.ts          every tuning number, plus the size / reach / aura curves
  sim/               pure game logic — no DOM, runs headless on the server and in tests
    world.ts         state, rule checks (canEject/canConnect/canReverse/...), the tick
    arena.ts         seeded cave generation + WallIndex for line-of-sight queries
    spawn.ts         where a joining or respawning player lands
    vision.ts        fog-of-war queries, used by the server to filter snapshots
    bot.ts           placeholder AI; issues ordinary Commands, no special access
    match.ts         one authoritative tick (bots + world.step)
    geometry.ts      segment/circle maths, seeded RNG
    types.ts         entities + the Command union
  render/            Canvas 2D renderer
    territory.ts     metaball "fluid" auras (WebGL2 shader, CPU fallback)
    fog.ts           vision, remembered ground, the grey overlay
    terrain.ts       cached terrain image for zoomed-out frames
    pipePath.ts      the hypha curve, shared by drawing and hit-testing
    camera.ts        eased fly-to camera
  net/               protocol (shared with the server) + client connection
  input/             mouse/keyboard → Commands
  main.ts            fixed-timestep loop, HUD, solo fallback
server/              rounds, join/respawn, per-player snapshots
tests/               vitest specs for the sim, the server room, camera and curves
reference/           screenshots of the original game
```

Every player action is a `Command` queued into the `World` and applied at the start of the next
tick — the same path locally and over the network.

## Decisions made for open design items

The design doc leaves these open; these are the prototype's answers, all in `config.ts` unless
noted.

- **Ejecting:** carries a share of the parent (default 65%, wheel-adjustable) rather than a flat
  amount, so a rich colony throws a child strong enough to throw again. Minimum throw 12, parent
  always keeps 5.
- **Upkeep:** 1/s, charged only to colonies that aren't sustained — a colony with inflow that
  isn't sending out more than it receives pays nothing, so relays don't wither.
- **Gathering:** draining a fall costs it 3/s but gives the colony 6/s (`FALL_DRAIN_GAIN`);
  colony-to-colony transfers are 1:1, so loops can't generate nutrients.
- **Attacking:** a hypha draining a *rival* pulls far harder than one moving nutrients inside a
  network — `attackRate` = 4 + 0.5·√nutrients of the attacking colony, capped at 30/s. Since one
  fall only feeds 6/s, a single attacker already out-paces a victim's income, and a few colonies
  on one target kill it. Still 1:1: the speed is the weapon, not a multiplier.
- **Pipe caps:** only outgoing hyphae are capped (4 per colony); incoming is unlimited, so
  funnelling and reinforcing always work. The cap counts only hyphae *you* grew, so a rival's
  drain line doesn't spend one of your slots — and a colony that has spent all four is still
  attackable. Falls are uncapped.
- **Reversing:** only the player who grew a hypha can flip it — being drained is answered by
  cutting, not by commandeering the attacker's hypha.
- **Cutting:** you can cut any hypha touching one of your nodes, including one draining you.
- **Walls:** 15 nutrients, max 3 per colony, fixed 170-unit crossbar; a new crossbar severs hyphae
  already crossing it.
- **Line of sight:** checked when a hypha is grown, and blocked by terrain and crossbars alike.
- **Fog of war:** colonies see 1.15× their reach (minimum 520). Explored ground stays remembered:
  terrain and falls persist, rivals only show while in sight.
- **Map:** radius 5400, cave terrain regenerated per round, reach = 220 + 20·√nutrients.
- **Camera:** eases to a new colony when you throw one; any pan or zoom hands control straight
  back (`CAMERA_FLY_TAU_MS`, `CAMERA_FLY_ON_EJECT`).
- **Falls pay upkeep:** no (`FALLS_PAY_UPKEEP`).

## Known gaps

- **A client can end up with two connections.** On reconnect the old socket isn't closed, so the
  server hands out a second player and two snapshot streams fight over one world — nutrients
  appear to oscillate. Contained to `src/net/client.ts`.
- **A closed loop of colonies never loses nutrients.** Each one receives exactly what it sends, so
  all count as sustained: a ring survives indefinitely with no income.
- **Bots see the whole map** and only play solo rounds; online rounds have no AI opponents.
- **The server is unauthenticated** and has no rate limiting — fine on a LAN, not for exposing.
- **Not deployable to GitHub Pages as multiplayer.** Pages is static, so it can host the client
  (which falls back to solo vs bots) but not the Node server.
