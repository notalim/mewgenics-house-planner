# Mewgenics House Planner

Tell it what furniture you own, pick your house stage and a goal for each room, and it packs everything into the rooms tile by tile, in the order you should place it in game.

Live: https://mewgenics-house.pplx.app

![Planner, dark theme](docs/desktop-dark.png)

## What it does

- Knows all 633 furniture pieces (shape, headroom, what it can rest on, stats, rare eligibility) and the real room grids: two 16×7 ground floor rooms, two upstairs rooms and the 35×9 sloped attic.
- Places pieces the way the game allows: on the floor, on shelves and tables, hanging from the ceiling, respecting headroom, stackability and the attic's no-hanging roof.
- Splits your furniture across rooms to maximise a score built from per-room goals (breeding, feeder nursery, holding, appeal, or custom weights), with Comfort and Health floors and cat counts.
- Draws each room with placement order numbers so every stacked piece already has its base, plus hover tooltips, stat deltas per piece, and an "in storage" list explaining why each leftover was left out.
- Imports your furniture from a Steam save (`steamcampaign01.sav`) or a JSON backup; console players type it in with a fast search box.
- Saves named layouts, exports the whole house as a PNG, and syncs between devices behind the same URL.
- Deterministic: same furniture, same goals, same layout on every device. Adding a piece keeps the layout you had and only changes what has to change.

![Planner, light theme](docs/desktop-light.png)

## How to use it

1. Add your furniture. On PC press Import and choose your save (Windows: `%AppData%\Glaiel Games\Mewgenics\<SteamID>\saves\steamcampaign01.sav`). It reads the furniture table, counts each piece and shows a preview before replacing your list. On console use Add furniture and type names; the Rare toggle adds rare copies.
2. Pick the house stage and which rooms you have unlocked.
3. Give each room a goal, or press "Pick strategy for me" and it tries every assignment of roles to rooms and keeps the best.
4. Read the grids. Numbers are placement order: build from 1 upward and every shelf exists before the thing that sits on it. Hover a piece for its name, stats and what it rests on.
5. Save the result under Layouts, or Export image to share it.

## How the optimizer works

Not a plain greedy fill. One run is:

1. Score: sum over rooms of weighted stats (Comfort, Stimulation, Health, Mutation) with penalties for breaking a Comfort floor, plus a small house-wide Appeal term.
2. Greedy build: rank pieces by score gained per tile, drop them in one at a time, big floor pieces first (they create surfaces), then hanging, then wall pieces. Small pieces are pushed onto shelves so the 16-wide floor stays free for wide ones. A piece that does not fit triggers a repack of the room with it included.
3. Ruin and repack: thousands of rounds of tearing out a chunk of a room (a random set, a vertical band, one item family, the largest piece, or a swap between two rooms) and rebuilding it greedily from the pool. Better results are kept; early on slightly worse ones are accepted with decaying probability (simulated annealing) so the search can leave dead ends.
4. Several chains: your previous layout plus fresh builds with different orderings. The best wins; the previous layout wins ties within a small margin so the house does not reshuffle for nothing.
5. Seeded random numbers, so results are reproducible. The search level only changes how many rounds run.

Pieces whose weighted contribution is negative in every room (a Shrunken Cat Head is -5 Health for +1 Mutation) stay in storage on purpose and are listed with the reason.

## Self hosting

Requires Node 20+.

```
npm ci
npm run build
NODE_ENV=production node dist/index.cjs
```

The app listens on port 5000 and stores everything in a SQLite file `data.db` next to it. There are no accounts: whoever can reach the URL shares the same inventory, so put it behind auth if you host it publicly.

Development: `npm run dev`.

## Data sources

- Furniture stats and room grids come from the game's data files as published in the community save editor repository: https://github.com/michael-trinity/mewgenics-savegame-editor
- Save file layout (SQLite `furniture` table, uncompressed blobs): https://github.com/michael-trinity/mewgenics-savegame-editor and https://github.com/kazzade42/mewgenics-furniture-upgrade
- Placement rules (surfaces, headroom, hanging, attic roof): https://mewgenicswiki.org/articles/house-furniture-guide and https://steamcommunity.com/app/686060/discussions/0/760682265019693246/
- Food Storage Box effect: https://nerdschalk.com/mewgenics-all-tracy-upgrades-blank-collar-food-box-and-furniture-idols/

## Known gaps

- Rare pieces cannot be detected in the save yet (the flag has not been identified), so mark them by hand after importing.
- Basements exist in the game's data files with an upgrade chain but nothing unlocks them in play, so they are hidden behind a flag in `client/src/lib/data.ts`.
- The optimizer is a strong heuristic, not an exact solver. On a 117-piece inventory it lands within about two points of a geometry-free upper bound.

## Credits

Built by [notalim](https://github.com/notalim). Fan project, not affiliated with Glaiel Games or Edmund McMillen. Mewgenics and its furniture names belong to their owners.

MIT licensed, see LICENSE.
