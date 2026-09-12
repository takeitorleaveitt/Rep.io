# Rep.io

A multiplayer browser arena shooter in the spirit of **diep.io**, **agar.io** and
**slither.io** — real players and bots in one arena, ten guns, no build step.

## Play

**Multiplayer:** `yarn && yarn start`, then open `http://localhost:3000`. The one
process serves the page and runs the authoritative game server.

**Solo:** open `index.html` directly. With no server to talk to, the same
simulation runs in the browser and you play against bots alone. The game also
falls back to this automatically if the server is unreachable or drops
mid-match, so a sleeping host never means a broken page.

## Deploying to Render

Push the repo, create a **Web Service** (not a Static Site — a static host
cannot run WebSockets) and use:

| Setting | Value |
| --- | --- |
| Build Command | `yarn` |
| Start Command | `yarn start` |
| Health Check Path | `/healthz` |

No environment variables are needed; the server reads Render's `PORT` itself.
`render.yaml` in the repo carries the same settings as a blueprint if you would
rather let Render configure the service. Note that the free plan sleeps after
~15 minutes idle, so the next visit waits ~50s for a cold start and anyone
connected at the time is disconnected.

## Controls

| Input | Action |
| --- | --- |
| `WASD` / arrows | Move |
| Mouse | Aim |
| Left click / `Space` | Shoot |
| `Q` / scroll wheel | Switch gun (`Shift`+`Q` goes back) |
| `E` | Toggle autofire |
| `M` | Mute / unmute |
| `1`–`7` (or click the panel) | Spend an upgrade point |
| `Enter` | Respawn on the death screen |

Touch works too: drag anywhere to move and fire toward your finger.

## Multiplayer

- **You join the busiest arena with room in it**, so two or nine people online
  end up in the same game rather than sitting in separate empty ones. Rooms hold
  16 humans and a new one only opens when they are all full.
- **Bots backfill toward 35% bots / 65% humans.** Nine humans gives 36% bots,
  twelve gives 33%. Below about nine that ratio alone would leave a near-empty
  arena, so a floor of ten tanks takes over instead — a solo player gets nine
  bots rather than an empty map.
- **Bots are levelled against the people in the room**, not against how long the
  server has been up, and each one ramps from soft to full strength over its own
  first four minutes alive. A room that has been running for hours therefore
  still greets newcomers with a mix of fresh and dangerous opponents instead of
  a wall of maximum-level veterans.
- The server is authoritative: it owns the simulation, ticks at 30Hz, and sends
  each client only what that client can see — entities at 20Hz, orbs at 6Hz,
  and sound events only to players in earshot. The client predicts its own tank
  so movement is immediate, interpolates everyone else, and dead-reckons bullets
  from their velocity.

## How it plays

- **Grow by eating.** Drifting orbs get magnetised in when you're close, agar.io style.
  The bigger your level, the wider the camera zooms out.
- **Farm the shapes.** Squares, triangles, pentagons and rare purple alphas are worth
  escalating XP — the alphas will flatten a low-level tank that rams one.
- **Level up into a new gun.** Ten unlock across a run, at levels 1, 6, 12, 18, 24,
  30, 38, 45, 55 and 75: Scout, Twin, Sniper, Triplet, Hunter, Spreadshot,
  Annihilator, Octo, Railgun, Overlord.
- **Keep every gun you unlock.** A new one is selected the moment it drops, but the
  strip along the bottom holds all of them and `Q` or the scroll wheel swaps between
  them mid-fight. They are answers to different problems rather than a straight
  ladder — Octo covers all eight directions for crowd control and farming, the
  Railgun is a single devastating long-range shot on a slow reload, the Overlord is
  a seven-barrel all-rounder, and the old Sniper and Spreadshot stay genuinely
  useful. Swapping costs a short reload so it is not a free burst.
- **Spend points on a build.** Seven stats: reload, damage, bullet health, bullet
  speed, max health and regen go to nine ranks, and move speed to ten. Body damage
  is a flat stat that scales with your level, not something you spend on.
- **Levelling steepens after 25.** Levels 1-25 cost what they always did; past
  that each one costs progressively more, taking a full run to 75 from 53k XP to
  81k.
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
index.html        markup + HUD
style.css         UI chrome
src/sim.js        the simulation — world, bots, collisions. Runs under Node on
                  the server and in the browser for solo play
src/audio.js      procedural sound — synthesised at runtime, no audio files
src/game.js       client: input, netcode, prediction, rendering
server/index.js   static files + authoritative WebSocket server, one process
render.yaml       Render blueprint
```

## Hit registration

Three separate things used to make a shot look like it was ignored:

1. **Bullets expired on a timer, not a distance.** A Scout round lived 1.85s and
   so died after about 1036 units, while the camera at higher levels shows over
   1500 units in every direction — shots evaporated in front of targets you were
   aiming at. Range is now a distance (1850 units by default, 1.9x for the Sniper
   and 2.4x for the Railgun) and never falls short of what is on screen.
2. **Spawn shields swallowed rounds silently.** A shot at a protected tank passed
   straight through with no sound or spark. Now it stops on the shield with a
   spark and a glassy ping, and firing your own gun drops your shield, so nobody
   shoots from behind one.
3. **Fast rounds tunnelled between frames.** Collision tested the bullet's end
   position only; a round moving further per frame than the target is wide went
   straight through. Bullet and pickup tests now sweep the segment travelled
   during the frame. Verified against the previous build: a 20000 u/s round
   scored 0 damage before and lands every time now.

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
