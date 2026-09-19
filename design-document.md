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
- **Procedural layout:** Interior walls are generated, not hand-placed, and are tuned specifically to create chokepoints and pockets:
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

Dragging from an existing node of yours out to empty space plants a new node there, seeded with a small starting nutrient buffer drawn from the parent, and **automatically grows a pipeline from the parent to the child** — no second drag needed. The parent therefore needs a free pipeline slot to eject. Because reach is checked before the buffer is paid, a child planted at maximum range is still connected even though paying for it shrinks the parent's reach. Ejection range is limited by the parent node's current resources (Section 5).

### 6.2 Pipelines — Persistent, Directional, One-Per-Pair

Dragging from one node to another grows a hypha/pipeline that continuously moves nutrients from the drag's start to its end, tick after tick, until removed. A few hard rules shape how networks scale:

- **Only one pipeline can exist between any given pair of nodes.** You can't stack multiple pipelines on the same connection to move more resources through it.
- **This means throughput scales with node count, not pipeline count on a single link.** To move nutrients faster between two areas, you build more nodes and more parallel pipelines between them — the network's total bandwidth is a function of how many distinct paths you've built, not how many times you've connected the same two points.
- **Only outgoing pipelines are capped** (prototype: 4 per node); a node can accept any number of incoming pipelines, so funnelling and reinforcing a node under attack always work. Falls are uncapped. Drains out of a node use that node's outputs, so a node can be drained by at most that many pipelines at once — and an attacker who fills them also chokes the owner's ability to expand from it.
- **Pipeline reach is resource-dependent**, same as ejection range (Section 5) — a richer node can reach further.
- **Line-of-sight matters:** a pipeline can only form (and, presumably, only persists) along an unobstructed straight line between the two node centers — walls block it (Section 4).

### 6.3 Draining — Taking From Others

There's no separate "drain" tool — draining is just a pipeline where you started the drag on something you don't own: a rival's node, or a nutrient fall. This doubles as the game's combat system (starve a rival's node faster than they can reroute nutrients to defend it) and its PvE gathering system (siphon a nutrient fall). Because a pipeline's endpoints aren't restricted by ownership, you can also be drained right back if an opponent reaches your node — dueling pipelines pulling from the same contested node is a natural point of tension.

**Funneling:** you can drain a single rich target — a strong nutrient fall, or an enemy node — faster than one pipeline alone would allow by planting several of your own nodes around it and running a separate draining pipeline from each into one accumulator node of yours. More parallel paths in means more total throughput, per the one-pipeline-per-pair rule above.

### 6.4 Nutrient Falls (Powerups)

Nutrient falls are resource patches scattered across the arena at the start of each round, functioning as neutral, unowned nodes with their own nutrient pool.

- Draining one normally depletes its pool — once it hits zero, it disappears.
- **Sustaining a fall (advanced tactic):** if one of your nodes simultaneously runs an outgoing pipeline *into* a fall while another of your pipelines draws *out* of that same fall, the two flows can offset each other and keep the fall's pool topped up indefinitely instead of being consumed — turning a one-time resource into a permanent (if contested, and upkeep-taxed) throughput point in your network. This loop-sustaining trick is one of the more distinctive emergent strategies from the original game and should be preserved deliberately rather than "balanced away" — it rewards understanding the flow model rather than just clicking fast.

> **Open item:** whether nutrient falls pay their own upkeep (Section 5) like player nodes do, or are exempt, is unconfirmed — this materially affects how valuable the sustaining trick above is and needs to be pinned down during prototyping.

### 6.5 Walls — Defensive Structures

*Revised from screenshots of the original (`reference/original-1.webp`, `original-2.webp`).*

A wall is a **⊢ shape**: a thin stem drawn from one of your colonies out to a point, ending in a short **crossbar** perpendicular to the stem. Only the crossbar is a barrier — the stem is just the tether back to the colony that placed it.

- The crossbar blocks line of sight (Section 6.2), so it's placed *across* the line an opponent would use: typically right in front of an enemy colony that's reaching toward yours, or fanned out on the exposed side of a colony (the screenshots show a colony with three walls covering one flank).
- A colony can hold several walls; covering every angle takes several, which is the committal "full enclosure" option.
- Walls belong to their anchor colony and disappear if it dies.

> **Prototype choices, unconfirmed:** a new crossbar also severs any existing hypha that crosses it; walls cost a one-off 15 nutrients; max 3 per colony; crossbar length is fixed (80 units).

### 6.6 Logistics & Emergent Strategy

The combination of per-tick upkeep, resource-gated range, one-pipeline-per-pair, and unrestricted drag endpoints is meant to support genuinely creative network design rather than a single obvious "best" shape. A few patterns worth calling out explicitly (not an exhaustive list — this is exactly the kind of system where players will find more):

- **Circular pipelines:** looping nodes A → B → C → A doesn't create resources out of nothing (any node in the loop that sends out more than it receives still pays upkeep), but it pools risk — surplus at any point in the ring can reach any other point, so no single node in the loop starves early just because it happens to be furthest from the source. A ring can keep a whole cluster of nodes alive noticeably longer on a given nutrient reserve than the same nodes left as a simple tree.
- **Overfed expansion chains:** when pushing a frontier of newly ejected nodes outward, deliberately feeding each link *more* than it needs to merely survive means it always has surplus left over to fund the next ejection — turning a fragile chain of nodes-on-a-timer into a self-sustaining advancing front.
- **Funneling** (Section 6.3) for fast extraction from a single rich target.

## 7. Win Condition & Match Flow

1. Players drop into a freshly generated arena, each spawning as a lone node with starting nutrients.
2. Players expand (6.1), wire up their economy (6.2), and contest nutrient falls and each other (6.3–6.4) in real time, all while every node they own bleeds upkeep (Section 5).
3. A node dies when its nutrient pool is driven to zero, whether by upkeep alone, being outpaced by a rival's drain, or simple neglect.
4. A player is eliminated once their entire network of nodes is gone.
5. The round ends when a single player's network is the last one standing.
6. The arena is discarded and regenerated for the next round.

> **Open item:** player count per arena, whether there's any progression/meta layer between rounds (cosmetics, unlocks, ranking), and whether bots fill empty slots are all undecided — flagging these as scoping questions for the next design pass rather than guessing at them here.

## 8. Visual & UX Direction

- **Nodes are points, not growing blobs** *(confirmed from the original)*: every node is a fixed-size dot. Its size is shown by a translucent **fluid area** around the dot that grows with its nutrients. Areas of the same owner attract each other and merge into one contiguous shape (metaball-style), so a network reads as a single organism; different owners' areas overlap translucently. Nutrient falls use the same treatment in neutral grey.
- **Palette:** plain white background; the only geometry is the circle-cluster walls/boundary and the colonies/pipelines themselves. This restraint is a feature, not a placeholder — it keeps the readability of the network (who's connected to what, and in which direction) as the star of the screen.
- **Readability priorities, in order:** (1) whose colony is whose, (2) pipeline direction and what's flowing through it, (3) terrain/chokepoints, (4) everything else (UI chrome, effects).
- **Node health at a glance:** since upkeep constantly threatens every node, the UI should make "how many ticks until this thing dies" legible without requiring a click — e.g. a shrinking silhouette or a subtle depletion ring, so players can triage their network visually mid-fight.
- **Fungal motifs to layer on without cluttering the silhouette:** soft, slightly irregular colony edges instead of perfect circles; hyphae rendered as thin organic threads rather than straight technical lines; nutrient falls textured subtly (leaf litter, wood grain, soil) so they read as "food" at a glance even before a player learns the mechanic.

## 9. Open Design Questions

These are the gaps left after reconstructing the mechanics from memory — worth resolving early in prototyping:

- Which mouse button performs the eject/pipeline drag, and what the other button is reserved for (Section 6).
- Numeric tuning: starting nutrient pool, per-tick upkeep cost (confirmed to be 1, but is it always 1 regardless of node size?), ejected-node starting buffer, pipeline throughput rate, max pipelines per node, wall segment cost/length, the exact curve relating a node's resources to its ejection range / pipeline reach / physical radius.
- Whether nutrient falls pay upkeep themselves (Section 6.4).
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
