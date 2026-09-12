# Rep.io

A browser arena shooter in the spirit of **diep.io**, **agar.io** and **slither.io** —
one canvas, no build step, no server, 22 bots that actually fight back.

## Play

Open `index.html` in a browser. That's it. (Or serve the folder:
`python3 -m http.server` and visit `http://localhost:8000`.)

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrows | Move |
| Mouse | Aim |
| Left click / `Space` | Shoot |
| `E` | Toggle autofire |
| `1`–`8` (or click the panel) | Spend an upgrade point |
| `Enter` | Respawn on the death screen |

Touch works too: drag anywhere to move and fire toward your finger.

## How it plays

- **Grow by eating.** Drifting orbs get magnetised in when you're close, agar.io style.
  The bigger your level, the wider the camera zooms out.
- **Farm the shapes.** Squares, triangles, pentagons and rare purple alphas are worth
  escalating XP — the alphas will flatten a low-level tank that rams one.
- **Level up into a new tank.** Barrel layouts unlock as you climb: Scout → Twin →
  Sniper → Triplet → Hunter → Spreadshot → Annihilator.
- **Spend points on a build.** Eight stats, eight pips each: reload, bullet damage,
  bullet health, bullet speed, body damage, max health, regen, move speed.
- **Kills pay.** A dead tank scatters a chunk of its score as orbs and hands the
  killer a share of it directly — dive into a fight and the field is briefly a feast.
- **Bots have opinions.** They hunt food, pick on tanks they can beat, lead their
  shots, keep stand-off range, and run when they're hurt and outgunned. They
  respawn stronger as the run goes on.

## Layout

```
index.html    markup + HUD
style.css     UI chrome
src/game.js   simulation, AI, rendering — everything else
```
