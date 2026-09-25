# Fungi Game

Browser prototype of the mycelial-network arena game described in [design-document.md](design-document.md).

## Run

```
npm install
npm run server     # authoritative game server on http://localhost:8787
npm run dev        # client dev server on http://localhost:5173
npm test           # sim + server unit tests (vitest)
npm run build      # typecheck + production build into dist/
```

Open http://localhost:5173 in two tabs to play against yourself — add `?name=Armillaria` so the
tabs don't share a stored name. With no server running the client plays solo against bots and
keeps retrying, switching to multiplayer the moment the server answers. After `npm run build`
the server also hosts the client itself on port 8787.

## Multiplayer

- **Authoritative server.** `server/` runs the same `src/sim/` code; clients send `Command`s and
  receive snapshots. Nothing is simulated client-side.
- **Fog of war is enforced server-side:** each player's snapshot contains only what they can see,
  so hidden state never reaches the client.
- **Terrain is never sent** — the client regenerates the identical arena from the round's seed.
- **Rounds** run 10 minutes. Players join and respawn instantly, so the winner is whoever gathered
  the most (score = nutrients drawn into your network from falls or rivals). The arena is then
  regenerated at a size scaled to the player count.

## Controls

| Input | Action |
|---|---|
| Left-drag from a node → empty space | Eject a new colony, auto-connected by a hypha from its parent (§6.1) |
| Left-drag from a node → another node | Grow a hypha; nutrients flow from drag start → drag end (§6.2–6.3) |
| Right-drag from your colony | Build a wall (⊢): crossbar at release point blocks line of sight (§6.5) |
| Left-click a hypha | Reverse which way it flows (only hyphae you grew) |
| Right-click your wall / a hypha | Demolish it / cut it |
| Right-drag empty space / WASD | Pan |
| Mouse wheel | Zoom |
| R | New round (solo only) |
| F | Toggle the render profiler (per-stage ms, and whether auras run on GPU or CPU) |

## Layout

```
src/
  config.ts          all tuning numbers + size/reach curves
  sim/               pure game logic — no DOM, runs headless (tests, future server)
    world.ts         state, rule checks (canEject/canConnect/canCut), tick
    arena.ts         seeded cave generation + WallIndex (line-of-sight queries)
    bot.ts           placeholder AI that issues ordinary Commands
    match.ts         one authoritative tick (bots + world.step)
    geometry.ts      segment/circle math, seeded RNG
    types.ts         entities + Command union
  render/            Canvas 2D renderer + camera
    territory.ts     metaball "fluid" auras (WebGL2 shader, CPU fallback)
    fog.ts           fog of war: vision, explored memory, grey overlay
  net/               protocol (shared with server) + client connection
  input/             mouse/keyboard → Commands
  main.ts            fixed-timestep loop, HUD, round restart
server/              authoritative server: rounds, join/respawn, per-player snapshots
tests/               vitest specs for the sim and the server room
reference/           screenshots of the original game
```

All player actions are `Command`s queued into the `World` and applied at the start of the next tick. For multiplayer, the client sends those same commands to a server that runs `sim/` authoritatively.

## Decisions made for open design items

These are placeholders. Change them in `config.ts` / `world.ts`:

- **Mouse buttons:** left-drag = eject/connect, right-drag from own colony = wall, right-click = cut/demolish, right-drag elsewhere = pan.
- **Walls:** 15 nutrients each, max 3 per colony, fixed 170-unit crossbar (scaled with the bigger map); a new crossbar severs hyphae crossing it.
- **Map:** radius 5400 (~15x the first prototype's area), cave terrain generated per round; reach = 220 + 20*sqrt(nutrients).
- **Gathering:** draining a fall costs it 3/s but gives the colony 6/s (`FALL_DRAIN_GAIN`); colony-to-colony is 1:1.
- **Fog of war:** colonies see 1.15x their reach (min 520); explored ground stays remembered — terrain and falls persist, rival colonies/hyphae/walls only show while in sight. Client-side view filter for now; bots still see everything.
- **Upkeep:** 1/s, charged only to colonies that aren't sustained (sustained = has inflow and isn't sending out more than it receives).
- **Falls pay upkeep:** no (`FALLS_PAY_UPKEEP = false`).
- **Pipe caps:** only outgoing hyphae are capped (4 per colony); incoming is unlimited, so funnelling and reinforcement always work. Falls are uncapped.
- **Reach when draining:** uses the reach of the endpoint(s) you own.
- **Cutting:** you can cut any hypha touching one of your nodes, including one draining you.
- **Reversing:** only the player who grew a hypha can flip it; being drained is answered by cutting, not by commandeering the attacker's hypha.
- **Line of sight:** checked when a hypha is grown; a new crossbar cuts any hypha already crossing it.
