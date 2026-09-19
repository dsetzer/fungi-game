# Fungi Game

Browser prototype of the mycelial-network arena game described in [design-document.md](design-document.md).

## Run

```
npm install
npm run dev        # http://localhost:5173
npm test           # sim unit tests (vitest)
npm run build      # typecheck + production build into dist/
```

## Controls

| Input | Action |
|---|---|
| Left-drag from a node → empty space | Eject a new colony (§6.1) |
| Left-drag from a node → another node | Grow a hypha; nutrients flow from drag start → drag end (§6.2–6.3) |
| Right-drag from your colony | Build a wall (⊢): crossbar at release point blocks line of sight (§6.5) |
| Right-click your wall / a hypha | Demolish it / cut it |
| Right-drag empty space / WASD | Pan |
| Mouse wheel | Zoom |
| R | New round |

## Layout

```
src/
  config.ts          all tuning numbers + size/reach curves
  sim/               pure game logic — no DOM, runs headless (tests, future server)
    world.ts         state, rule checks (canEject/canConnect/canCut), tick
    arena.ts         seeded circle-cluster arena generation
    bot.ts           placeholder AI that issues ordinary Commands
    match.ts         one authoritative tick (bots + world.step)
    geometry.ts      segment/circle math, seeded RNG
    types.ts         entities + Command union
  render/            Canvas 2D renderer + camera
  input/             mouse/keyboard → Commands
  main.ts            fixed-timestep loop, HUD, round restart
tests/               vitest specs for the sim
reference/           screenshots of the original game
```

All player actions are `Command`s queued into the `World` and applied at the start of the next tick. For multiplayer, the client sends those same commands to a server that runs `sim/` authoritatively.

## Decisions made for open design items

These are placeholders. Change them in `config.ts` / `world.ts`:

- **Mouse buttons:** left-drag = eject/connect, right-drag from own colony = wall, right-click = cut/demolish, right-drag elsewhere = pan.
- **Walls:** 15 nutrients each, max 3 per colony, fixed 80-unit crossbar; a new crossbar severs hyphae crossing it.
- **Upkeep:** 1/s, charged only to colonies that aren't sustained (sustained = has inflow and isn't sending out more than it receives).
- **Falls pay upkeep:** no (`FALLS_PAY_UPKEEP = false`).
- **Pipe cap:** 4 per colony (in + out); falls are uncapped so funnelling works.
- **Reach when draining:** uses the reach of the endpoint(s) you own.
- **Cutting:** you can cut any hypha touching one of your nodes, including one draining you.
- **Line of sight:** checked when a hypha is grown; a new crossbar cuts any hypha already crossing it.
