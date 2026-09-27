# Redesign Notes

Ideas that would change a core rule, parked here until we come back to them. Nothing in this file is decided or built; the design document stays the source of truth for how the game works today.

## Hyphae carry a share of the source's store, not a flat rate

*Status: parked, September 2026. Come back to this before tuning the economy further.*

### The idea

Today every hypha moves a flat `PIPE_RATE_PER_SEC` (3/s) between your own colonies and out of falls. Instead, a hypha would move **a percentage of its source colony's store each second**. A rich colony pushes hard; a lean one trickles.

Drains on rivals already work a little like this — their rate grows with the attacker's size (`attackRate` in `config.ts`) — so the idea isn't foreign to the game.

### What prompted it

Two things we noticed that the flat rate doesn't explain or handle.

**1. Chains in the original taper *up* toward the tip; ours stay even.** In `reference/original-2.webp`, a four-step eject chain grows colony by colony toward the frontier. Ours doesn't, whatever the eject share.

The reason is arithmetic. Once a colony throws the next one, it passes along exactly what it receives, so its size freezes at whatever it kept when it threw. Down a chain, sizes settle toward a steady size of

> flow rate × pause between throws ÷ (1 − share thrown)

With our numbers that is 3 × 8 ÷ 0.35 ≈ 70. A chain that starts above it shrinks toward it, one that starts below grows toward it. The original's taper is a chain still climbing toward a steady size — which needs flow that is fast compared with the throws. At 3/s ours is tiny, so chains look flat and thin.

Measured in the sim (home colony of 1,500, four throws at 85% of reach; nutrients / aura):

| Eject rule, pause | 1 | 2 | 3 | 4 (tip) |
|---|---|---|---|---|
| Percentage (65%), 2 s | 343 / 248 | 225 / 192 | 149 / 147 | 283 / 220 |
| Flat 40, 8 s | 24 / 39 | 24 / 39 | 24 / 39 | 64 / 84 |

**2. The income loop can't feed anything.** Fall → A → B → fall: the fall holds steady, A gains +1/s (3 out of the fall arrive as 4), B breaks even. But every hypha carries a fixed 3/s, so a third hypha out of A owes 6 against 4 coming in. A colony that owes more than it receives also pays upkeep, and once it runs dry it is zeroed and dies (`flowAndUpkeep` in `world.ts`). The loop's surplus can pile up, but it can only leave in thrown lumps, never as a stream.

### What it would fix

- **Big colonies push fast** — chains fill between throws and taper up like the original, and it matches the remembered feel of moving a large amount quickly.
- **Colonies can't overspend.** A colony sending more than it receives shrinks until its outflow matches its inflow; it settles instead of dying. A loop's surplus flows out through an extra hypha on its own.

### Before building it

- Run both candidates in a scratch copy of the sim first: (a) a faster flat rate, (b) share-of-store. Check chain shape, and whether the loop now feeds an extra hypha without dying.
- Decide the percentage, and whether falls follow the same rule (a fall's outflow would shrink as it empties).
- The sustain loop's balance (§6.4) is built on equal flat rates in and out of a fall. With share-of-store flows it would settle to an equilibrium instead — check it still nets a steady income.
- Upkeep's "sustained" test compares inflow with demand; demand would now depend on the store, so that rule needs rethinking too.

### Alternatives considered for the loop alone

- **Raise the fall bonus to 3 → 6**, so the loop pays +3/s — exactly one hypha. One number, but it doubles the economy, and the doc records that this ratio was tried early and dropped for dwarfing every other source.
- **A colony's own hyphae carry only what it can spare**, oldest first — the loop keeps its full rate and a newer hypha carries the surplus. Works, but makes invisible grow-order matter.

## Valve modes for hyphae (a possible boost)

*Status: idea, September 2026. Pairs naturally with share-of-store hyphae above.*

A boost that lets the player set a hypha's **mode** by clicking it, beyond flipping its direction. It fits the passive-boost rule (§6.7): it only adds options, and a network nobody touches behaves exactly as before.

| Mode | What it does | Notes |
|---|---|---|
| **Closed** | Stops all flow in both directions; the connection stays. | Pause a line without cutting it — useful when reach has since shrunk and it couldn't be regrown. A flow mode if the others exist; otherwise a third direction state (see Controls). |
| **Equalize** | Keeps the two colonies' stores level with each other, flowing whichever way is needed. | Natural with share-of-store flow: the rate follows the difference between the two stores. |
| **Limiter** | Caps how much the hypha can carry, while still letting it carry less. | Only meaningful with share-of-store flow — with a flat rate a cap is just a lower fixed rate. Needs an intuitive way to set the cap. |
| **Underflow** | Sends only what the target needs to stop shrinking: if it's losing 6/s, 6/s flows and it holds steady. | A life-support line — keeps a colony exactly where it is without overfeeding it. |
| **Overflow** | Noted for completeness: colonies have no size cap or pressure, so a classic overflow valve doesn't apply as-is. | Could be reinterpreted as "keep a reserve of X, send everything above it" if that turns out useful. |

### Controls

Two kinds of control are mixed here — **direction** (forward / reverse) and **flow** (closed, equalize, limiter, underflow) — so they want two separate inputs:

- **Direction stays on left-click**, flipping as it does today.
- **Where "closed" lives depends on whether flow modes exist.** On its own, closed is simplest as a third direction state — left-click cycles forward → reverse → closed, so pausing a line is a couple of clicks. If the other flow modes are built, closed belongs with them instead: it's a flow setting, not a direction.
- **Flow modes need a second input**, not yet decided — a modifier-click or a small radial menu on the hypha are candidates.
- **The mouse wheel stays dedicated to zoom.** It only takes on another job once an action is already in progress — the way it sets eject share only while a throw is being dragged, until the button is released. Hovering alone is never enough: a player zooming out with the cursor over a hypha must not change its flow. So a wheel-based flow control would have to start from a press on the hypha (press, scroll, release), never from hover.

### Open questions

- What happens to hyphae left in a special mode when the boost is lost — do they revert to normal flow (which would rebalance the network under the player, against the passive rule), or keep their mode but become unchangeable?
- How the limiter's cap is shown and set.
- Whether a rival can see a hypha's mode.

## Related, still open: how much each nutrient is worth

Feeding a fresh colony feels like it gains too little range and territory per nutrient. Reach is `220 + 20√n` — mostly a free base — and territory is small compared with reach: a fresh colony's territory is about a fifth of its throw distance, where the original's chain colonies look like a third to over half of a hop.

Candidates discussed, nothing changed yet:

- **Double territory growth only** (`AURA_SCALE` 11 → 22), leaving reach alone — the closest match to the reference screenshot.
- **Double both** — makes everything bigger including spawn (reach 420 → 620). Would need the spawn food cluster moved out (500 → 700) and two territory tests updated, and territory would hit its cap around 900 nutrients instead of 2,500.

Worth revisiting together with share-of-store hyphae, since faster flow also makes fed colonies grow faster.
