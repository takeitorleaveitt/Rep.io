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
| `M` | Mute / unmute |
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
  shots, keep stand-off range, and run when they're hurt and outgunned.
- **Bots start soft.** For the first few minutes of a run they have thinner hulls,
  weaker shots, slower reloads and worse aim, all ramping to full strength over
  four minutes — so the early game is about farming and the late game is the fight.
  They also leave freshly-spawned tanks alone instead of spawn-camping.

## Layout

```
index.html    markup + HUD
style.css     UI chrome
src/audio.js  procedural sound — synthesised at runtime, no audio files
src/game.js   simulation, AI, rendering — everything else
```

## Sound

Every sound is synthesised in the Web Audio API at runtime, so the game ships
no audio files and works offline. Voices run through a compressor and a short
procedural convolution reverb; each one is panned and attenuated by its distance
from the camera, so a firefight across the map reads as distant rather than loud.
Per-emitter retrigger limits keep a dozen bots firing at once from turning into
mush. Orb pickups walk up a pentatonic scale while you keep collecting, and
reset when you stop.

## Nicknames

Two to seventeen characters, and a profanity filter blocks slurs and swearing —
including leetspeak and padding, so `sh1t` and `f.u.c.k` are caught. The filter
uses a two-tier blocklist so real nicknames like `Bassist` and `Cocktail` still
work.
