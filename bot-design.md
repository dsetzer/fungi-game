# Bot design

The computer players, redesigned from scratch against everything the game now is:
10/s hyphae, 1:1 falls, Harvest-gated loops, nine boosts, walls, reversals, fog-free
sight. This is the spec the code in `src/sim/bot/` implements.

## Principles

- **Hands are slow, eyes are instant.** A bot sees its whole network in real time —
  every store, every rate, every line — and re-reads it every quarter second. Only
  its *actions* are limited: one at a time, a gap after each (easy 5 s, normal 2 s,
  hard 1.4 s), nothing saved up.
- **Every action is priced on one scale:** nutrients gained, saved or taken over the
  next minute. One line running for that minute (`LINE`, 600) and one colony's
  worth just existing (`COLONY`, 300) anchor the scale. Keeping the network alive
  and connected is priced on the same scale as tapping and attacking — priced by
  upkeep instead, it was a tenth of a tap and bots let networks fall apart.
- **Rules are checked before acting.** Candidates are ranked, then checked against
  the real rules best-first; nothing illegal is ever chosen, and a run of illegal
  candidates can't leave a bot idle.
- **Memory across thinks:** the tick of its last action, the target it is travelling
  to and its progress, targets it gave up on, and pairs it recently cut (so it
  doesn't relink them straight back).

## Difficulty

Every level plays the same brain; three things set them apart (`profile.ts`):

| | Hands | Reaction | Temperament |
|---|---|---|---|
| Easy | an action every 5 s | 5 s | Defensive: walls a rival off on sight, even one it could drain; drains reluctantly; never goes to war |
| Normal | every 2 s | 3 s | Balanced |
| Hard | every 1.4 s | 1.5 s | Offensive: latches on and drains on sight; goes to war on a smaller edge; walls less |

**Reaction is not the action gap.** It is how long after something new appears
before the bot may respond to it at all: a rival colony coming within reach of one
of its colonies (or one of its colonies within reach of the rival), or a rival line
starting to drain it. Without it a bot latched onto a freshly thrown colony before a
person could even see it land. Every move aimed at a rival — draining, walling,
severing, sieges, counter-attacks — waits for it; the clock restarts if contact is
lost and found again.

## Architecture

Three layers, re-run every time a bot looks (`src/sim/bot/`):

1. **Strategy** (`strategy.ts`) — a state machine for the bot's posture, driven by its
   live stats, held for a few seconds at a time so it doesn't flicker (defend can
   always cut in):
   - *opening* — the first minute, a handful of colonies: eat and spread;
   - *expand* — the default: gather, reach new ground, take boosts;
   - *consolidate* — much of the network starving or in pieces: repair first;
   - *war* — rivals in reach and clearly more to fight with: press them;
   - *defend* — drains on us that matter against our income or colonies.
   The posture weights each category of move (economy, network, expand, fight,
   defend, boost). Strategy also decides which tasks to start.
2. **Tasks** (`tasks.ts`) — plans that take several actions, each a small state
   machine advanced every look, proposing the moves its state calls for:
   - *Expedition*: travel → arrived; gives up on a stall.
   - *Sever plan*: wall → sever; back to wall if the wall comes down.
   - *Harvest loop*: link → close → hold; rebuilds if a line goes.
   - *Boost hold*: capture → hold (feed, recycle).
   - *Siege*: funnel → finish (Flow; Sever on its reinforcements, wall first).
3. **Reflexes** (`reflexes.ts`) — what a healthy network needs on every look.

`board.ts` is the perception layer and shared pricing; `nav.ts` the walking map;
`core.ts` the price scale, candidates and memory; `index.ts` ties them together:
every candidate from all three layers is weighted by the posture, sorted, and
checked against the real rules best-first (up to 400); the best legal one is the
action taken.

## What a bot tracks every think

Per colony: store, net rate, time until empty, income (food coming in from outside
the network), own lines in and out, rival lines draining it (at their real rate,
Siphon/Rind included), which piece of the network it's in, and its **need**:

| | need |
|---|---|
| emptying within 45 s | +3 |
| being drained by a rival | +3 |
| leading the current expedition | +2 |
| a gathering hub with a surplus | −2 |
| rich and doing nothing | −1 |

Also: falls (pool, who draws on them, who feeds them), boosts (kind, owner, store),
rival colonies and who can reach whom, and a **walking map** of the terrain.

## Pathing

A coarse grid over the arena marks open ground. For each target a distance field is
computed once — the walking distance from every cell to the target, going *round*
terrain — and cached. A throw is valued by how much walking distance it saves, not
straight-line distance, so a bot heads for the gap in a wall instead of throwing at
the wall forever. A target the bot makes no progress toward for 45 s is dropped for
two minutes.

## Moves

### Economy
- **Tap** every fall in reach, into the colony that needs it most. Worth what it
  yields over the minute (double with Harvest).
- **Harvest loops** (only while holding Harvest — without it a loop nets nothing):
  fall → C → D → fall. If C doesn't already feed a D that reaches the fall, build
  C → D first. Loops are built once a fall would run dry within a minute.
- **Kill the source:** tapping a fall a rival is looping is worth extra — it breaks
  their engine.

### Network
- **Supply lines:** a colony with a surplus feeds a needier one it can reach.
- **Reversal:** a line of ours flowing from a needy colony to a comfortable one is
  flipped.
- **Rings:** a colony paying upkeep is closed into a ring through its own chain, so
  the cycle idles upkeep-free and doesn't collapse when its food runs out.
- **Relink pieces:** any piece split from the main network is linked back wherever
  they're in reach — from a colony that can afford to feed it — and a piece out of
  reach with nothing coming in travels back toward the main network.
- **Save gathering hubs:** a throw's cord drains its parent at 10/s. If the parent
  is a gathering hub that can't afford that, the cord is cut once the child has
  landed. Cords out of relays and tips are left: that's the chain moving forward.
- **Never** cut a line just to stop a colony shrinking — that only strands islands.

### Expansion
Targets: food groups nobody of ours reaches, neutral and rival boosts, weaker rival
colonies, and — for a stranded piece — the main network. Up to six are chosen by
value over walking distance; the one being travelled to gets a bonus so bots
don't dither. A throw is worth the share of the walk it covers times what's at the
end, or — when it lands in reach — what it brings in, shared over the actions it
takes to collect. Throwing from a gathering hub costs the follow-up cut; from a
relay that feeds others, the supply it abandons.

### Fighting
- **Drain** rival colonies in reach, strongest hunter first. Worth what the line
  takes (Siphon, Rind, Flow included) plus the kill when the drains outpace what the
  colony takes in. Joining an existing funnel is worth extra.
- **Counter-attack** a colony that drains us: a line on it from another colony of
  ours also answers the attack (one line per pair).
- **Walls** where a rival colony can reach a valuable colony of ours that can't
  reach back (where it can, draining is better), and across the line from a rival
  colony to a fall we depend on.

### Boosts
- **Capture** neutral boosts in reach, priced by how useful the kind is right now
  (Rind while being drained, Chitin when a rival holds Sever, Branch when slots are
  full, Harvest by how many falls we tap…); a second of a kind already held is
  worth little.
- **Keep them fed** — a fed boost pays no upkeep — and recycle a boost's surplus
  back into the network.
- **Strip** rivals' boosts by draining them.
- **Sever, correctly:** only ever cut a line whose ends can no longer see each
  other — so the owner can't simply latch on again while Sever recharges. Wall
  first (a crossbar across the line), then Sever. Used on lines draining us, and on
  lines feeding a colony we're draining.
- **Flow:** fired when doubling every line is worth it — a kill it would finish, or
  enough gathering and draining running — and never when a colony of ours already
  shrinking would run dry during the ten seconds its deficit doubles.

## Checks

Scenario tests (tests/bot.test.ts): taps everything in reach; heads for food out of
reach; paces its actions; goes round a terrain wall to a boost; walls before it
severs; builds a Harvest loop; keeps a captured boost fed; flips a line that runs
the wrong way; walls off a rival it can't reach back. Plus a match harness that
tracks pieces, starvation, boosts, walls and reversals over whole matches.
