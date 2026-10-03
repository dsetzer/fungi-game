# Fungi Game — Design Document

*Working title: `fungi_game` · Draft v0.2 · Prepared September 2026*

## 1. Elevator Pitch

A minimalist, real-time multiplayer arena game about growing a fungal network. You start as a single spore-colony with a fixed pool of nutrients (your health). You expand by dragging out new colonies and wiring them together with hyphae (persistent resource pipelines), then fight for survival by draining nutrients from wild resource patches, from rival colonies, or straight out of an opponent's network — while they try to do the same to you. Every colony bleeds a little upkeep every tick, so a network that stops actively managing its flow starts dying. The last network standing wins, and the arena regenerates for the next round.

Mechanically it's a remix of a few older reference points the project is explicitly building on (Section 2), reskinned around mycology: hyphal growth, decomposition, and parasitism instead of generic "blobs" and "pipes."

## 2. Inspirations & Reference Points

This design is a reconstruction from memory of an older browser/arena game, cross-referenced against its closest known relatives. Treat this section as the mechanical DNA to preserve; Section 4 onward is the fungi-themed redesign built on top of it.

| Reference | What it contributes to this design |
|---|---|
| **Agar.io** | The core "blob" framing — free 2D movement-free arena, growth through absorption, and the visceral feeling of being hunted by anything bigger than you. |
| **Kiomet.io** | Real-time base/territory strategy on a shared persistent(-feeling) map, with direct player-vs-player territorial pressure rather than only PvE growth. |
| **Galcon** *(planet-capture games with drag-to-command controls)* | The **input model**, precisely: click-and-drag from a node you own to a target sets up a persistent, ongoing transfer rather than a one-off click-to-send. Note that the *economy* diverges from Galcon's model on purpose — see Section 5, nodes here don't passively produce resources for free, they cost upkeep, which makes this closer to a logistics puzzle than a pure snowball. |
| **Screeps** *(room-based world layout)* | The idea of a big world divided into distinct, readable "rooms" or cells with their own local terrain and resource nodes, rather than one undifferentiated open field. |
| **Teleglitch** *(procedural dungeon generation)* | The specific trick of hiding a large open pocket behind a deliberately narrow, easy-to-miss gap in the terrain — rewarding players who probe the map instead of just reading it at a glance. |

The pieces that don't come from any one of those — drag-to-eject, per-tick upkeep that can kill a node, bidirectional pipelines that can target anyone's node, node-built walls that also block line-of-sight connections, and the feed-while-draining trick for sustaining a powerup — are original to the remembered game and are the mechanics this document is most focused on preserving precisely (Sections 5–7).

## 3. Theme: Mycelial Warfare

Reskin summary — nothing here changes the mechanics, only what they represent visually and narratively:

| Original concept | Fungal reskin |
|---|---|
| Blob / node | A fungal colony — a mass of mycelium anchored at a point, rendered as an irregular soft-edged mass rather than a perfect circle |
| Resources / health | Biomass / nutrients, stored as living tissue — losing resources visibly shrinks and thins the colony, and a colony drained to zero withers and disappears |
| Pipeline | A hypha (plural: hyphae) — a thread of mycelium grown between two colonies that nutrients flow along continuously once grown |
| Draining a rival | Parasitic colonization — your hyphae pierce and digest the rival's tissue |
| Resource patch / powerup | A nutrient fall — a decaying log, a nutrient-rich soil pocket, a bit of carrion, leaf litter — a finite (or, if exploited well, effectively infinite) food source |
| Arena boundary / interior walls | Spore-cloud membranes — the "circles-of-varying-size" wall aesthetic already reads naturally as drifting spore clouds or puffball bursts, so the existing minimalist white art direction can be kept almost as-is and simply re-labeled in-fiction |
| Node-built walls | Hardened sclerotia — a defensive crust a colony secretes around itself |
| Map regeneration | A new substrate — the "board" is eaten bare and reseeded for the next round |

This mapping is intentionally low-effort to implement: the existing "circles forming cloud-like boundaries" concept and pipeline/node structure translate almost directly into fungal terms without needing new systems, only new art and names.

## 4. The Arena

- **Shape & scale:** A large but finite play space enclosed by an outer boundary. The boundary and all interior walls are built from clusters of variable-sized circles, giving the whole map a soft, cartoon-cloud silhouette on a plain white background (a look worth keeping deliberately abstract rather than pushing toward literal cloud or mushroom imagery).
- **Procedural layout** *(implemented)*: terrain is a cellular-automata cave system spanning the whole map — open rooms joined by narrow chokepoints, with pockets that take probing to find. A carved artery runs from each spawn toward the centre so no player starts sealed in, and a clear bubble surrounds each spawn. Generation is tuned specifically to create chokepoints and pockets:
  - Some areas are large and open.
  - Some are large but sealed behind a single narrow gap — a deliberate Teleglitch-style "squeeze through the crack" reward for exploration, and a natural place to hide a strong nutrient fall or a safe expansion spot.
  - Screeps-style "room" thinking is useful here even without a hard grid: bias generation toward a set of loosely bounded cells connected by a handful of chokepoint exits each, rather than uniform open noise, so players can learn to read the map's chokepoints at a glance.
- **Walls block pipelines, not just movement:** a pipeline can only be formed between two nodes if there's an unobstructed straight line between their centers — walls interrupt that line of sight and prevent the connection. This makes the procedural wall layout a strategic layer in its own right (see Section 6.5), not just scenery.
- **Match lifecycle:** The arena is regenerated whenever a match ends — either one player/colony remains, or (in a non-competitive dry run) every colony has died. A fresh layout means players can't memorize a single map and must read terrain live each round.
- **Resource fall spawns:** Nutrient falls spawn at random locations across the regenerated arena at the start of a round (see Section 6.4 for behavior).

## 5. Node Economy: Upkeep, Not Free Production

This is the part of the design that most sharply distinguishes it from a simple Galcon clone, so it gets its own section.

- **Nodes and blobs are the same thing.** Every colony, whether it's your original spawn or something you ejected five minutes ago, is a node.
- **An unsustained node costs 1 nutrient per tick (1 tick = 1 second) just to stay alive.** A node is *sustained* — and pays no upkeep — while nutrients are flowing into it and it isn't sending out more than it receives. So a relay that passes along everything it gets never withers; only idle or over-spending nodes bleed. There is no free passive income — resources only enter your network from nutrient falls (Section 6.4) or from draining another node (Section 6.3). A node with no inflow is on a countdown.
- **A newly ejected node starts with only a small nutrient buffer.** If a pipeline isn't run to it before that buffer is consumed by upkeep, the node withers and disappears (shrinks down to nothing). Expansion is therefore always a small bet: you commit resources to plant a node, then you have a short window to link it up or lose it.
- **A node with no pipelines at all just sits there, bleeding upkeep, until it vanishes.** "Resources are always flowing somewhere" in a healthy network — the exception is an isolated node with nowhere to send or receive, which is really just a dying node on a timer.
- **Reach scales with resources.** Both a node's ejection range (how far away it can plant a new node) and its pipeline reach (how far away it can connect to another node) grow as the node's own nutrient store grows. A large, well-fed colony can project much further across the map than a small one.

## 6. Core Interaction Model

Everything routes through one gesture: **click-and-drag, starting on a node.** Where you release the drag determines what happens:

- **Drag from a node to empty space → eject a new node** at the release point (Section 6.1).
- **Drag from a node to another node → grow a persistent pipeline** between them, flowing from the node you started the drag on to the node you released on (Section 6.2).

Critically, the node you *start* the drag on doesn't have to be one you own — you can drag from a nutrient fall, or from a rival's colony, toward your own node to set up a drain (Section 6.3), or drag from your own node toward someone else's to deliberately feed them (situationally useful — see the powerup-sustaining trick in Section 6.4). Direction is entirely determined by drag start → drag end, not by ownership.

> **Open item:** which mouse button performs this drag (and what right-click is reserved for — likely wall-building, Section 6.5, or cancelling a pipeline) is still unconfirmed and worth settling with a quick prototype pass.

### 6.1 Ejecting — Growing a New Node

Dragging from an existing node of yours out to empty space plants a new node there, seeded with **a share of the parent's store** (Galcon-style; default half, set with the wheel mid-drag between 15% and 90%), and **automatically grows a pipeline from the parent to the child** — no second drag needed. The parent therefore needs a free pipeline slot to eject. Because reach is checked before the buffer is paid, a child planted at maximum range is still connected even though paying for it shrinks the parent's reach. Ejection range is limited by the parent node's current resources (Section 5). Because the throw scales with the parent, a well-fed colony produces a child with real reach that can immediately throw again — expansion travels in chains rather than stalling on a weak stub every hop.

### 6.2 Pipelines — Persistent, Directional, One-Per-Pair

Dragging from one node to another grows a hypha/pipeline that continuously moves nutrients from the drag's start to its end, tick after tick, until removed. A few hard rules shape how networks scale:

- **Only one pipeline can exist between any given pair of nodes.** You can't stack multiple pipelines on the same connection to move more resources through it.
- **This means throughput scales with node count, not pipeline count on a single link.** To move nutrients faster between two areas, you build more nodes and more parallel pipelines between them — the network's total bandwidth is a function of how many distinct paths you've built, not how many times you've connected the same two points.
- **Only outgoing pipelines are capped** (prototype: 4 per node); a node can accept any number of incoming pipelines, so funnelling and reinforcing a node under attack always work. Falls are uncapped. Drains out of a node use that node's outputs, so a node can be drained by at most that many pipelines at once — and an attacker who fills them also chokes the owner's ability to expand from it.
- **Pipeline reach is resource-dependent**, same as ejection range (Section 5) — a richer node can reach further.
- **Flow can be reversed in place:** left-clicking a hypha you grew flips which way nutrients move along it, keeping the same connection (the node that becomes the new source needs a free output). Rerouting a network is therefore a click rather than a cut-and-regrow, which matters when reach has since shrunk and the connection could not be rebuilt.
- **Line-of-sight matters:** a pipeline can only form (and, presumably, only persists) along an unobstructed straight line between the two node centers — walls block it (Section 4).
- **Hyphae never cross.** A new hypha can't be grown across an existing one, whoever grew it — ejecting included, since it grows a hypha too. Two hyphae meeting at a shared node aren't crossing. Every hypha is therefore also a barrier: a network's lines fence off the ground behind them from new connections, rivals' included. Hyphae are drawn as straight lines, exactly where they run, so this is readable at a glance.

### 6.3 Draining — Taking From Others

There's no separate "drain" tool — draining is just a pipeline where you started the drag on something you don't own: a rival's node, or a nutrient fall. This doubles as the game's combat system (starve a rival's node faster than they can reroute nutrients to defend it) and its PvE gathering system (siphon a nutrient fall). Because a pipeline's endpoints aren't restricted by ownership, you can also be drained right back if an opponent reaches your node — dueling pipelines pulling from the same contested node is a natural point of tension.

**Funneling:** you can drain a single rich target — a strong nutrient fall, or an enemy node — faster than one pipeline alone would allow by planting several of your own nodes around it and running a separate draining pipeline from each into one accumulator node of yours. More parallel paths in means more total throughput, per the one-pipeline-per-pair rule above.

### 6.4 Nutrient Falls (Powerups)

Nutrient falls are resource patches scattered across the arena at the start of each round, functioning as neutral, unowned nodes with their own nutrient pool.

- Draining one normally depletes its pool — once it hits zero, it disappears.
- **Falls respawn at random, never in place.** Every fall is a finite, shrinking pool, but while the map holds fewer falls than it started with, a new group appears somewhere random, open and unclaimed (like boosts, Section 6.7). Food near you still runs out, which is what pushes players outward and eventually into each other; the map as a whole just doesn't starve over a long round.
- **Draining a fall is 1:1, like every hypha:** ten out of the fall arrive as ten in the colony (hyphae run at 10/s). A fall is food — a finite pool you pull into your network — not a multiplier.
- **Sustaining a fall needs Harvest** (Section 6.7). Run a pipeline *into* a fall from one of your nodes while another draws *out* of it, and the two flows offset: the pool stays flat instead of being consumed. Without Harvest that nets nothing. Holding Harvest, your fall lines yield double — ten out, twenty in — so the same loop pays **+10/s forever**, a full line's worth. That is the discovery a Harvest boost offers: whoever holds it can build an endless income nobody else can, and everyone else has a reason to take it from them.

  The counterplay is what makes it fair, and there are three routes:
  - **Steal the flow.** Drain the loop's colonies directly (Section 6.3) and take the nutrients back out of it.
  - **Kill the source.** Attach your own drain line to the fall. Its total outflow now exceeds what its owner feeds in, so the pool bleeds the difference and eventually empties — and since a fall never respawns in place, that disables the income permanently. Attacking the well beats attacking the bucket.
  - **Take the Harvest.** Drain the Harvest boost dry and every loop its holder built goes back to netting nothing.

> **Open item:** whether nutrient falls pay their own upkeep (Section 5) like player nodes do, or are exempt, is unconfirmed — this materially affects how valuable the sustaining trick above is and needs to be pinned down during prototyping.

> **Resolved:** the ratio was 3-out/6-in during early prototyping, which made a sustain loop pay +3/s and dwarf every other source. It became 3-out/4-in, which made loops something every player built as a matter of course. Loops are now gated behind the Harvest boost and falls are 1:1, so an endless income is something you find, not something everyone has.

### 6.5 Walls — Defensive Structures

*Revised from screenshots of the original (`reference/original-1.webp`, `original-2.webp`).*

A wall is a **⊢ shape**: a thin stem drawn from one of your colonies out to a point, ending in a short **crossbar** perpendicular to the stem. Both lines are barrier: the crossbar and the stem back to the colony that placed it.

- The wall blocks line of sight (Section 6.2), so the crossbar is placed *across* the line an opponent would use: typically right in front of an enemy colony that's reaching toward yours, or fanned out on the exposed side of a colony (the screenshots show a colony with three walls covering one flank).
- A colony can hold several walls; covering every angle takes several, which is the committal "full enclosure" option.
- Walls belong to their anchor colony and disappear if it dies.

> **Prototype choices, unconfirmed:** a new crossbar also severs any existing hypha that crosses it; walls cost a one-off 15 nutrients; max 3 per colony; crossbar length is fixed (80 units).

### 6.6 Logistics & Emergent Strategy

The combination of per-tick upkeep, resource-gated range, one-pipeline-per-pair, and unrestricted drag endpoints is meant to support genuinely creative network design rather than a single obvious "best" shape. A few patterns worth calling out explicitly (not an exhaustive list — this is exactly the kind of system where players will find more):

- **Circular pipelines:** looping nodes A → B → C → A doesn't create resources out of nothing (any node in the loop that sends out more than it receives still pays upkeep), but it pools risk — surplus at any point in the ring can reach any other point, so no single node in the loop starves early just because it happens to be furthest from the source. A ring can keep a whole cluster of nodes alive noticeably longer on a given nutrient reserve than the same nodes left as a simple tree.
- **Overfed expansion chains:** when pushing a frontier of newly ejected nodes outward, deliberately feeding each link *more* than it needs to merely survive means it always has surplus left over to fund the next ejection — turning a fragile chain of nodes-on-a-timer into a self-sustaining advancing front.
- **Funneling** (Section 6.3) for fast extraction from a single rich target.

### 6.7 Powerups & Abilities *(planned, not built)*

The game's objective loop is **explore, expand, feed, grow** — powerups are the layer that makes territory worth holding for reasons other than raw nutrient income.

A boost is a **king-of-the-hill capture point**. It sits on the map as a neutral grey node with its own nutrient pool, drawn like a nutrient fall, and it is captured and held through exactly the same pipeline machinery as everything else — no new verbs, no menu.

- **Draining:** a boost can be drained like a fall, neutral or captured, and yields like one. Draining is what depletes boosts, and draining one a rival is feeding is how you strip the boost from them.
- **Capturing:** feed nutrients *into* it. It changes colour to yours and becomes an ordinary node of your network — yours in the same sense your colonies are, with the same upkeep, the same vulnerability to being drained, and the same rules about what it can connect to.
- **Holding:** its ability is active while you hold it, paid for by keeping it fed. Because it is now a normal node, a rival takes it the same way they take anything else — drain it faster than its owner feeds it.
- **Dying:** when its pool hits zero it is gone, exactly like any other node of yours that gets starved out.
- **Spawning:** unlike falls (Section 6.4), boosts keep appearing through a round, one at a time at random open spots on their own — never among falls or near colonies. They are recurring contested objectives rather than a finite resource, which is what makes them worth fighting over repeatedly instead of once.
- **Look:** a boost is not a fall and doesn't look like one: a gold disc with a white icon for its kind, and no territory. Captured, the disc takes its holder's colour and keeps the icon.

The economics follow from that: holding a boost costs throughput every second, so a player sitting on several is spending real economy and is correspondingly thin elsewhere.

**Most boosts are passive.** Holding one gives its benefit to your whole network for as long as you keep the node fed, and losing the node loses the benefit at once. There is no button and no cooldown — just a point on the map worth keeping.

**A passive boost may only add options, never change what an existing network is already doing.** Extra range, extra outputs and a wider view leave a built network behaving exactly as before; boosts that only make what you take in bigger, or what you lose smaller (Harvest, Siphon, Rind), pass too, because no colony of yours sends any more than it did; the player chooses whether to use them, and losing the boost takes the option away without rebalancing anything. A boost that sped up every hypha fails this test: colonies set up for the normal rate would start bleeding, and losing it would rebalance the whole network under the player.

**Two boosts are activated instead,** because what they grant is an action rather than a bonus. Each appears on screen as an ability that is clicked or fired with a number hotkey. Sever arms a single cut and goes on cooldown once it's made; Flow takes effect at once and goes on cooldown when it ends. It stays usable for as long as the boost is held.

### The base list

| Boost | Kind | Effect | Notes |
|---|---|---|---|
| **Branch** | Passive | Every colony you own gets **double the output slots** (4 → 8). | Rival drain lines don't use a colony's output slots (`config.ts`), so this is pure capacity with no added exposure. Paired with Harvest it doubles the engines a hub can run: a Harvest loop nets a full line, so each loop feeds one output, and eight slots hold twice what four do. |
| **Reach** | Passive | Every colony's ejection and hypha reach increases. | Line of sight still applies, so enclaves and chokepoints are unaffected. The bonus is always on, so it should be well under the +100% considered for a one-shot version. |
| **Vision** | Passive | A larger view radius for everything you own. | |
| **Harvest** | Passive | Your hyphae out of falls yield **double** — ten out, twenty in. | The only thing that makes a sustain loop pay (Section 6.4): with it, a loop nets +10/s forever. The "wait a minute" boost — whoever finds it can build an income no one else can. Losing it drops loops back to netting nothing, never to a loss. |
| **Siphon** | Passive | Your hyphae draining a rival's colony or boost pull **double** (20/s). | Targeted at rivals only: your gathering and internal lines are untouched, and nothing of yours sends more than before, so it passes the passive rule. Makes a funnel on one colony a kill in half the time. |
| **Rind** | Passive | Rivals' hyphae draining your colonies or boosts pull **half** (5/s). | The defensive counterpart to Siphon, and it cancels it exactly: Siphon against Rind is a plain 10/s. Not invulnerability — the Rind node itself can be drained dry, and falls, walls and relays are exposed as ever. |
| **Chitin** | Passive | Hyphae you grew **can't be cut by Sever**. | The counter to Sever, and deliberately narrow: whether it matters depends on a rival having found Sever, which is the lottery boosts are. Walls, draining a hypha's ends and killing colonies all still work. |
| **Flow** | Activated | Every hypha you own carries double its rate for a while. | Not a passive boost, because a permanent speed-up would rebalance networks built for the normal rate. As a timed burst nothing breaks: each colony's hypha income and spend double together while upkeep stays flat, so balanced colonies stay balanced, surplus doubles, falls empty sooner, and your drain lines on rivals pull twice as hard — an attack window. |
| **Sever** | Activated | Click any hypha to cut it. | Ordinarily only the player who grew a hypha may cut it (Section 6.2). Sever cuts *any* hypha on the map, owned by anyone, attached to anyone — the answer to being drained by someone out of reach. The cooldown is what pays for that. |

**On hold** — liked, but parked to keep the first version simple:

- **Distribute** (activated): click one of your colonies; its nutrients leave as a pulse down the chain, giving each colony it reaches an equal share.
- **Reverse** (activated): click a hypha to flip the whole chain it belongs to in one action rather than one hypha at a time.

**Distribute** in detail, for when it comes back:

- The pulse follows hypha direction — downstream, the way nutrients already flow — through your own colonies only. Upstream colonies, rival colonies and falls are untouched, so the player steers it by how the network is wired.
- Every colony it reaches gets an equal share: the lump shrinks by the same amount at each stop and is spent at the last one.
- At a fork it splits in proportion to how many colonies lie down each branch, so the shares stay equal.
- It travels visibly, roughly a third of a second per hop, and each colony swells as the pulse arrives.
- It has to be activated: usable at will, it would teleport nutrients anywhere and make hyphae irrelevant for moving resources.

> **Starting numbers (to tune):** Reach +200 (cap 600 → 800); Vision +50% radius; Sever cooldown 30 s; Flow 2× for 10 s, cooldown 45 s; boost upkeep 1/s like a colony; 2 boosts at the start of a round, then a new one of a random kind every 40 s, up to 5 on the map; the same passive held twice doesn't stack.

> **Still to pin down:**
> - How much of its store the colony that fires Distribute sends — all of it, or a share like ejecting — and how the pulse treats a loop (each colony once).
> - Whether an armed-but-unused ability can be cancelled, and whether losing the boost while armed cancels it.

## 7. Win Condition & Match Flow

1. Players drop into a freshly generated arena, each spawning as a lone node with starting nutrients.
2. Players expand (6.1), wire up their economy (6.2), and contest nutrient falls and each other (6.3–6.4) in real time, all while every node they own bleeds upkeep (Section 5).
3. A node dies when its nutrient pool is driven to zero, whether by upkeep alone, being outpaced by a rival's drain, or simple neglect.
4. A player is eliminated once their entire network of nodes is gone — in multiplayer they can play again straight back into the running round (see below).
5. The round ends when a single player's network is the last one standing *(solo/offline play only — multiplayer rounds end on the timer below)*.
6. The arena is discarded and regenerated for the next round.

**Implemented round system (multiplayer):** because players join and rejoin at any time (below), `last network standing` cannot end a round, so rounds run on a **timer** (prototype: 10 minutes) and the winner is whoever **gathered the most** — score counts every nutrient drawn into your network from a fall or a rival, which is what the original's millions-high leaderboard implies. Between rounds there is a short intermission, then the arena is regenerated.

- **Joining:** a player who connects mid-round spawns immediately in open ground, with a nutrient fall guaranteed within starting reach (.io style, matching the original's 47-player leaderboard).
- **Death:** losing your whole network puts you out, with a summary of how it went; **Play again** spawns you back into the same running round as a fresh player (a new record; the old one leaves the leaderboard).
- **Arena size scales with the player count**, so density stays roughly constant as players come and go (radius = 5400 x sqrt(players / 4), clamped). Scaling happens at round start, not mid-round, since terrain can't be regenerated under live networks.

> **Open item:** progression/meta between rounds (cosmetics, unlocks, ranking) is still undecided, and bots currently only fill *solo* play — online rounds have no AI opponents.

## 8. Visual & UX Direction

- **Nodes are points, not growing blobs** *(confirmed from the original)*: every node is a fixed-size dot. Its size is shown by a translucent **fluid area** around the dot that grows with its nutrients. Areas of the same owner attract each other and merge into one contiguous shape (metaball-style), so a network reads as a single organism; different owners' areas overlap translucently. Nutrient falls use the same treatment in neutral grey.
- **Fog of war** *(confirmed from the original)*: your colonies light up a radius around themselves (prototype: 1.15x reach). Ground never seen is hidden under soft grey; ground seen before stays remembered — terrain and nutrient falls persist, but rival colonies, their hyphae and their walls are only drawn while something of yours can see them. This makes the big map's chokepoints and hidden pockets matter: you have to probe to learn the terrain, and an opponent's expansion is invisible until it reaches you.
- **Palette:** plain white background; the only geometry is the circle-cluster walls/boundary and the colonies/pipelines themselves. This restraint is a feature, not a placeholder — it keeps the readability of the network (who's connected to what, and in which direction) as the star of the screen.
- **Readability priorities, in order:** (1) whose colony is whose, (2) pipeline direction and what's flowing through it, (3) terrain/chokepoints, (4) everything else (UI chrome, effects).
- **Node health at a glance:** since upkeep constantly threatens every node, the UI should make "how many ticks until this thing dies" legible without requiring a click — e.g. a shrinking silhouette or a subtle depletion ring, so players can triage their network visually mid-fight.
- **Fungal motifs to layer on without cluttering the silhouette:** soft, slightly irregular colony edges instead of perfect circles; hyphae rendered as thin organic threads rather than straight technical lines; nutrient falls textured subtly (leaf litter, wood grain, soil) so they read as "food" at a glance even before a player learns the mechanic.

## 9. Open Design Questions

These are the gaps left after reconstructing the mechanics from memory — worth resolving early in prototyping:

- Which mouse button performs the eject/pipeline drag, and what the other button is reserved for (Section 6).
- Numeric tuning: starting nutrient pool, per-tick upkeep cost (confirmed to be 1, but is it always 1 regardless of node size?), ejected-node starting buffer, pipeline throughput rate, max pipelines per node, wall segment cost/length, the exact curve relating a node's resources to its ejection range / pipeline reach / physical radius.
- Whether nutrient falls pay upkeep themselves (Section 6.4).
- Tuning Section 6.7's starting numbers once boosts are playable.
- Player count per match and whether AI fills empty slots.
- Any meta-progression between matches, or is each round fully self-contained.
- Whether an established pipeline can be destroyed/severed directly (e.g., an enemy cutting through it, or a wall built after the fact retroactively cutting it), or only made moot by killing an endpoint.
- Mobile/touch support, given the control scheme is currently drag-based with a mouse in mind.

## 10. Suggested MVP Scope

To get to a playable prototype fastest, in rough priority order:

1. Single arena shape (can be hand-authored first; defer full procedural generation).
2. Node upkeep tick (Section 5) and drag-to-eject with the starting-buffer death timer — this is the core tension of the game and should be validated first, even in a blank arena.
3. Drag-to-connect persistent pipelines (6.2) between owned nodes only — defer draining rivals until the core economy feels right solo/co-op.
4. Nutrient falls with basic depletion (defer the feed+drain sustain trick to a follow-up pass once the base flow model is solid).
5. PvP draining (6.3), funneling, and node/player elimination.
6. Line-of-sight blocking and node-built walls (Section 4, 6.5).
7. Procedural arena generation with chokepoints (Section 4).
8. Full fungal art pass (Section 3, 8).
9. Boosts as capture points (Section 6.7) — nine boosts: Branch, Reach, Vision, Harvest, Siphon, Rind, Chitin (passive), Flow, Sever (activated).
