/* Rep.io — a single-file .io arena shooter.
   Mix of diep.io (tanks, shapes, upgrades), agar.io (eat orbs to grow,
   zoom out as you get big) and slither.io (open arena, bots, leaderboard). */
(() => {
'use strict';

// ---------------------------------------------------------------- constants
const WORLD = 6400;            // square arena, 0..WORLD on both axes
const ORB_COUNT = 1350;
const SHAPE_COUNT = 190;
const BOT_COUNT = 12;
const MAX_LEVEL = 45;
const FRICTION = 0.87;
const MAGNET = 150;            // pull radius, half of what it used to be
const MAGNET_PULL = 140;       // 3.5x the old pull speed
const TAU = Math.PI * 2;
const MINI = 124;              // minimap edge length in CSS pixels

const SKILLS = [
  { key: 'reload', label: 'Reload'      },
  { key: 'damage', label: 'Damage'      },
  { key: 'pen',    label: 'Bullet HP'   },
  { key: 'bspeed', label: 'Bullet Spd'  },
  { key: 'body',   label: 'Body Damage' },
  { key: 'hp',     label: 'Health'      },
  { key: 'regen',  label: 'Regen'       },
  { key: 'speed',  label: 'Move Speed'  },
];
const SKILL_MAX = 8;

// Barrel layouts unlock with level, diep.io style.
const TIERS = [
  { level: 1,  name: 'Scout',      barrels: [{ a: 0, w: 1, spread: 0.05 }] },
  { level: 6,  name: 'Twin',       barrels: [{ a: -0.10, w: 0.8 }, { a: 0.10, w: 0.8 }] },
  { level: 12, name: 'Sniper',     barrels: [{ a: 0, w: 1.25, spread: 0.008, speed: 1.7, dmg: 1.8, rate: 2.1 }] },
  { level: 18, name: 'Triplet',    barrels: [{ a: -0.30, w: .8 }, { a: 0, w: 1 }, { a: 0.30, w: .8 }] },
  { level: 24, name: 'Hunter',     barrels: [{ a: -0.26, w: .8 }, { a: 0.26, w: .8 }, { a: Math.PI, w: 1, rate: 1.4 }] },
  { level: 30, name: 'Spreadshot', barrels: [{ a: -0.55, w: .7 }, { a: -0.28, w: .8 }, { a: 0, w: 1 }, { a: 0.28, w: .8 }, { a: 0.55, w: .7 }] },
  { level: 38, name: 'Annihilator',barrels: [
      { a: 0, w: 1.5, speed: 0.85, dmg: 2.6, rate: 2.4, size: 1.7 },
      { a: Math.PI * 0.66, w: .7 }, { a: -Math.PI * 0.66, w: .7 }] },
];

const SHAPE_KINDS = [
  { sides: 4, r: 22, hp: 12,   xp: 12,   hue: 48,  name: 'square' },
  { sides: 3, r: 19, hp: 22,   xp: 30,   hue: 8,   name: 'triangle' },
  { sides: 5, r: 38, hp: 140,  xp: 190,  hue: 232, name: 'pentagon' },
  { sides: 5, r: 78, hp: 1300, xp: 1800, hue: 276, name: 'alpha' },
];

const BOT_NAMES = ['Zap', 'Blob', 'Nomnom', 'Turret', 'Vortex', 'Pixel', 'Wasp', 'Chomp',
  'Kiwi', 'Rocket', 'Muffin', 'Glitch', 'Tofu', 'Nova', 'Bandit', 'Cobalt', 'Yeet',
  'Pancake', 'Specter', 'Wombat', 'Zigzag', 'Donut', 'Havoc', 'Noodle', 'Quark'];

// ---------------------------------------------------------------- helpers
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
const pick = a => a[(Math.random() * a.length) | 0];
const lerp = (a, b, t) => a + (b - a) * t;
function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
function xpForLevel(l) { return Math.round(16 * Math.pow(l, 1.35)); }

// ---------------------------------------------------------------- nicknames
const NAME_MIN = 2, NAME_MAX = 17;

// Two tiers of blocklist. SUB matches anywhere in the name and covers slurs and
// unambiguous profanity; WORD only matches a standalone run, which keeps real
// nicknames like "Bassist" or "Cocktail" playable.
const BLOCK_SUB = [
  'nigg', 'nigr', 'nigga', 'negro', 'faggot', 'kike', 'chink', 'gook', 'wetback',
  'beaner', 'raghead', 'tranny', 'retard', 'fuck', 'shit', 'bitch', 'cunt',
  'asshole', 'arsehole', 'motherf', 'pussy', 'whore', 'slut', 'bastard', 'wanker',
  'blowjob', 'dildo', 'jerkoff', 'rapist', 'nazi', 'hitler', 'pedo',
];
const BLOCK_WORD = [
  'fag', 'spic', 'coon', 'paki', 'dyke', 'ass', 'arse', 'dick', 'cock', 'twat',
  'prick', 'bollocks', 'penis', 'vagina', 'rape', 'kys', 'wank', 'damn', 'crap',
];
const LEET = { '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g',
               '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i',
               '+': 't', '*': '', '.': '', '_': ' ', '-': ' ' };

// Fold leetspeak and padding so "f.u.c.k" and "sh1tt" are caught too.
function foldName(raw) {
  const mapped = raw.toLowerCase().replace(/[0-9@$!|+*._-]/g, c => LEET[c] ?? c);
  const spaced = mapped.replace(/[^a-z]+/g, ' ').trim();
  const tight = spaced.replace(/\s+/g, '');
  const squashed = tight.replace(/(.)\1+/g, '$1');   // fuuuck -> fuck
  return { spaced, tight, squashed };
}

function validateName(raw) {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.replace(/[^\p{L}\p{N}]/gu, '').length < NAME_MIN)
    return { ok: false, error: `Nickname needs at least ${NAME_MIN} letters.` };
  if (name.length > NAME_MAX)
    return { ok: false, error: `Nickname can be at most ${NAME_MAX} characters.` };

  const f = foldName(name);
  for (const w of BLOCK_SUB)
    if (f.tight.includes(w) || f.squashed.includes(w))
      return { ok: false, error: 'Pick a nickname without that word in it.' };
  for (const w of BLOCK_WORD) {
    const re = new RegExp(`\\b${w}\\b`);
    if (re.test(f.spaced) || f.tight === w || f.squashed === w)
      return { ok: false, error: 'Pick a nickname without that word in it.' };
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------- state
const state = {
  orbs: [], shapes: [], tanks: [], bullets: [], fx: [],
  player: null, cam: { x: WORLD / 2, y: WORLD / 2, zoom: 1 },
  mouse: { x: 0, y: 0, down: false },
  keys: Object.create(null),
  running: false, autofire: false, time: 0, startedAt: 0,
};

// ---------------------------------------------------------------- entities
function makeOrb(x, y) {
  return {
    x: x ?? rnd(20, WORLD - 20), y: y ?? rnd(20, WORLD - 20),
    r: rnd(5, 9), hue: rnd(0, 360), xp: 4,
    ph: rnd(0, TAU), vx: 0, vy: 0,
  };
}

function makeShape(kind) {
  const k = kind || (Math.random() < 0.62 ? SHAPE_KINDS[0]
    : Math.random() < 0.75 ? SHAPE_KINDS[1]
    : Math.random() < 0.93 ? SHAPE_KINDS[2] : SHAPE_KINDS[3]);
  return {
    kind: k, x: rnd(60, WORLD - 60), y: rnd(60, WORLD - 60),
    r: k.r * rnd(0.92, 1.08), hp: k.hp, maxhp: k.hp,
    rot: rnd(0, TAU), vr: rnd(-0.4, 0.4), vx: rnd(-8, 8), vy: rnd(-8, 8),
    hue: k.hue, flash: 0,
  };
}

function makeTank(opts = {}) {
  const t = {
    id: Math.random().toString(36).slice(2),
    name: opts.name || 'anon', isBot: !!opts.isBot,
    x: opts.x ?? rnd(200, WORLD - 200), y: opts.y ?? rnd(200, WORLD - 200),
    vx: 0, vy: 0, angle: rnd(0, TAU), aim: 0,
    level: 1, xp: 0, score: 0, kills: 0, points: 0,
    skills: SKILLS.reduce((o, s) => (o[s.key] = 0, o), {}),
    hue: opts.hue ?? rnd(0, 360),
    cool: 0, recoil: 0, flash: 0, alive: true, invuln: 3,
    hp: 1, ai: { mode: 'roam', target: null, wander: rnd(0, TAU), t: 0, jitter: 0 },
  };
  t.maxhp = maxHp(t); t.hp = t.maxhp;
  return t;
}

// ---------------------------------------------------------------- derived stats
const radiusOf = t => 17 + Math.pow(t.level, 0.62) * 3.4;
// Bots start the round as pushovers and sharpen up over the first few minutes,
// so the opening is about farming and the late game is about fighting.
const botEdge = t => t.isBot ? clamp(0.45 + state.time / 240, 0.45, 1) : 1;
const maxHp    = t => (52 + (t.level - 1) * 7 + t.skills.hp * 22) * (t.isBot ? lerp(0.55, 1, botEdge(t)) : 1);
const regenOf  = t => 0.35 + t.skills.regen * 1.5 + maxHp(t) * 0.0007 * t.skills.regen;
const speedOf  = t => (262 + t.skills.speed * 26) * (1 - Math.min(0.32, t.level * 0.004));
const bodyDmg  = t => (8 + t.skills.body * 8 + t.level * 0.5) * botEdge(t);
const fireRate = t => (0.42 / (1 + t.skills.reload * 0.16)) * (t.isBot ? lerp(1.7, 1, botEdge(t)) : 1);
const bulletDmg= t => (7 + t.skills.damage * 4.5 + t.level * 0.32) * botEdge(t);
const bulletHp = t => 6 + t.skills.pen * 5 + t.level * 0.2;
const bulletSpd= t => 560 + t.skills.bspeed * 55;

function tierOf(t) {
  let best = TIERS[0];
  for (const tr of TIERS) if (t.level >= tr.level) best = tr;
  return best;
}

// ---------------------------------------------------------------- progression
function addXp(t, amount) {
  if (!t.alive) return;
  t.xp += amount; t.score += amount;
  while (t.level < MAX_LEVEL && t.xp >= xpForLevel(t.level)) {
    t.xp -= xpForLevel(t.level);
    t.level++; t.points++;
    const before = t.maxhp;
    t.maxhp = maxHp(t);
    t.hp += t.maxhp - before;
    if (t === state.player) { burst(t.x, t.y, t.hue, 26, 260); Sfx.levelUp(); }
  }
  if (t.level >= MAX_LEVEL) t.xp = Math.min(t.xp, xpForLevel(MAX_LEVEL));
}

function spend(t, key) {
  if (t.points <= 0 || t.skills[key] >= SKILL_MAX) {
    if (t === state.player) Sfx.deny();
    return false;
  }
  t.points--; t.skills[key]++;
  const before = t.maxhp; t.maxhp = maxHp(t);
  t.hp += t.maxhp - before;
  if (t === state.player) Sfx.upgrade();
  return true;
}

// ---------------------------------------------------------------- combat
function shoot(t) {
  if (t.cool > 0) return;
  const tier = tierOf(t);
  const r = radiusOf(t);
  for (const b of tier.barrels) {
    const spread = (b.spread ?? 0.045) * (t.isBot ? 1.6 / botEdge(t) : 1);
    const ang = t.angle + b.a + rnd(-spread, spread);
    const speed = bulletSpd(t) * (b.speed ?? 1);
    const size = (5.4 + r * 0.15) * (b.size ?? 1) * (b.w ?? 1);
    state.bullets.push({
      owner: t, hue: t.hue, x: t.x + Math.cos(ang) * (r + size),
      y: t.y + Math.sin(ang) * (r + size),
      vx: Math.cos(ang) * speed + t.vx * 0.35,
      vy: Math.sin(ang) * speed + t.vy * 0.35,
      r: size, dmg: bulletDmg(t) * (b.dmg ?? 1),
      hp: bulletHp(t) * (b.dmg ?? 1), life: 1.35 + (b.speed ?? 1) * 0.5,
    });
    t.vx -= Math.cos(ang) * speed * 0.035;
    t.vy -= Math.sin(ang) * speed * 0.035;
  }
  t.recoil = 1;
  t.cool = fireRate(t) * (tier.barrels[0].rate ?? 1);
  Sfx.shoot(t.x, t.y, tier.barrels[0].size ?? 1, t === state.player);
}

function hurt(target, dmg, from) {
  if (!target.alive || target.invuln > 0) return;
  target.hp -= dmg; target.flash = 1;
  if (target === state.player && dmg > 2) Sfx.hurt();
  if (target.hp <= 0) kill(target, from);
}

function kill(t, by) {
  if (!t.alive) return;
  t.alive = false;
  burst(t.x, t.y, t.hue, 46, 380);
  // Drop a share of the score as orbs — agar.io style feeding frenzy.
  const drops = clamp(Math.round(t.score * 0.02), 6, 80);
  for (let i = 0; i < drops; i++) {
    const a = rnd(0, TAU), d = rnd(0, radiusOf(t) * 3);
    const o = makeOrb(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d);
    o.hue = t.hue; o.r = rnd(7, 11); o.xp = Math.max(3, (t.score * 0.16) / drops);
    state.orbs.push(o);
  }
  if (by && by.alive && by !== t) {
    by.kills++;
    addXp(by, 40 + t.score * 0.22);
    if (by === state.player) Sfx.kill();
  }
  if (t === state.player) { Sfx.die(); endRun(by); }
}

function burst(x, y, hue, n, spd) {
  for (let i = 0; i < n; i++) {
    const a = rnd(0, TAU), s = rnd(spd * 0.2, spd);
    state.fx.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: rnd(1.5, 4), hue, life: 1, max: rnd(0.3, 0.7) });
  }
}

// ---------------------------------------------------------------- bot AI
function botThink(t, dt) {
  const ai = t.ai;
  ai.t -= dt;
  const r = radiusOf(t);

  // Re-evaluate a few times a second, not every frame.
  if (ai.t <= 0) {
    ai.t = rnd(0.18, 0.4);
    ai.jitter = rnd(-0.12, 0.12);
    let bestFood = null, bestFoodD = Infinity;
    let bestFoe = null, bestFoeD = Infinity;
    let threat = null, threatD = Infinity;

    for (const s of state.shapes) {
      const d = dist2(t, s);
      if (d > 1300 * 1300) continue;
      // Prefer shapes this bot can actually chew through.
      const cost = d * (s.kind.hp > t.level * 45 ? 5 : 1);
      if (cost < bestFoodD) { bestFoodD = cost; bestFood = s; }
    }
    for (const o of state.orbs) {
      const d = dist2(t, o) * 0.6;
      if (d < bestFoodD) { bestFoodD = d; bestFood = o; }
    }
    for (const e of state.tanks) {
      if (e === t || !e.alive) continue;
      const d = dist2(t, e);
      if (d > 1500 * 1500) continue;
      const mine = t.score + t.hp * 3, theirs = e.score + e.hp * 3;
      if (theirs > mine * 1.55 && d < threatD) { threatD = d; threat = e; }
      else if (theirs < mine * 1.3 && d < bestFoeD && !isFreshMeat(e)) { bestFoeD = d; bestFoe = e; }
    }

    if (threat && t.hp < t.maxhp * 0.45) { ai.mode = 'flee'; ai.target = threat; }
    else if (bestFoe) { ai.mode = 'fight'; ai.target = bestFoe; }
    else if (bestFood) { ai.mode = 'feed'; ai.target = bestFood; }
    else { ai.mode = 'roam'; ai.target = null; ai.wander = rnd(0, TAU); }
  }

  // Spend upgrade points on a personality-flavoured build.
  if (t.points > 0) {
    const build = t.buildOrder || (t.buildOrder = shuffle(SKILLS.map(s => s.key)));
    for (const k of build) if (spend(t, k)) break;
  }

  let mx = 0, my = 0, fire = false;
  const tg = ai.target;
  if (tg && (tg.alive === undefined || tg.alive)) {
    const dx = tg.x - t.x, dy = tg.y - t.y, d = Math.hypot(dx, dy) || 1;
    if (ai.mode === 'flee') { mx = -dx / d; my = -dy / d; t.angle = Math.atan2(dy, dx); fire = true; }
    else if (ai.mode === 'fight') {
      // Lead the shot, and keep a comfortable stand-off range.
      const lead = d / bulletSpd(t);
      const ax = tg.x + (tg.vx || 0) * lead - t.x, ay = tg.y + (tg.vy || 0) * lead - t.y;
      t.angle = lerp(t.angle, t.angle + angDiff(t.angle, Math.atan2(ay, ax) + ai.jitter), 0.35);
      const want = 320 + r * 4;
      const push = d < want * 0.7 ? -1 : d > want ? 1 : 0;
      mx = (dx / d) * push - (dy / d) * 0.5; my = (dy / d) * push + (dx / d) * 0.5;
      fire = d < 900;
    } else {
      mx = dx / d; my = dy / d;
      t.angle = lerp(t.angle, t.angle + angDiff(t.angle, Math.atan2(dy, dx)), 0.2);
      fire = tg.kind !== undefined && d < 520;   // shoot shapes, not orbs
    }
  } else {
    ai.wander += rnd(-0.6, 0.6) * dt;
    mx = Math.cos(ai.wander); my = Math.sin(ai.wander);
    t.angle += dt * 0.8;
  }

  // Stay away from the walls.
  const m = 380;
  if (t.x < m) mx += (m - t.x) / m;
  if (t.x > WORLD - m) mx -= (t.x - (WORLD - m)) / m;
  if (t.y < m) my += (m - t.y) / m;
  if (t.y > WORLD - m) my -= (t.y - (WORLD - m)) / m;

  const len = Math.hypot(mx, my) || 1;
  t.ix = mx / len; t.iy = my / len;
  if (fire) shoot(t);
}

// Don't let bots swarm a tank that just spawned — that is not fun, it is a wall.
function isFreshMeat(e) { return e.level <= 4 && e.score < 120; }

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------------------------------------------------------------- simulation
function step(dt) {
  state.time += dt;
  const p = state.player;

  // --- player input
  if (p && p.alive) {
    let ix = 0, iy = 0;
    const k = state.keys;
    if (k.KeyA || k.ArrowLeft) ix--;
    if (k.KeyD || k.ArrowRight) ix++;
    if (k.KeyW || k.ArrowUp) iy--;
    if (k.KeyS || k.ArrowDown) iy++;
    const l = Math.hypot(ix, iy) || 1;
    p.ix = ix / l * (ix || iy ? 1 : 0); p.iy = iy / l * (ix || iy ? 1 : 0);
    const w = worldFromScreen(state.mouse.x, state.mouse.y);
    p.angle = Math.atan2(w.y - p.y, w.x - p.x);
    if (state.mouse.down || state.autofire || k.Space) shoot(p);
  }

  // --- tanks
  for (const t of state.tanks) {
    if (!t.alive) continue;
    if (t.isBot) botThink(t, dt);
    const acc = speedOf(t) * 5.2;
    t.vx += (t.ix || 0) * acc * dt;
    t.vy += (t.iy || 0) * acc * dt;
    const fr = Math.pow(FRICTION, dt * 60);
    t.vx *= fr; t.vy *= fr;
    const sp = Math.hypot(t.vx, t.vy), max = speedOf(t);
    if (sp > max) { t.vx = t.vx / sp * max; t.vy = t.vy / sp * max; }
    t.x += t.vx * dt; t.y += t.vy * dt;

    const r = radiusOf(t);
    t.x = clamp(t.x, r, WORLD - r); t.y = clamp(t.y, r, WORLD - r);
    t.cool = Math.max(0, t.cool - dt);
    t.recoil *= Math.pow(0.001, dt);
    t.flash *= Math.pow(0.002, dt);
    t.invuln = Math.max(0, t.invuln - dt);
    t.maxhp = maxHp(t);
    if (t.hp < t.maxhp) t.hp = Math.min(t.maxhp, t.hp + regenOf(t) * dt);

    // eat orbs
    for (let i = state.orbs.length - 1; i >= 0; i--) {
      const o = state.orbs[i];
      if (dist2(t, o) < (r + o.r) * (r + o.r)) {
        addXp(t, o.xp);
        if (t === state.player) Sfx.pickup(o.x, o.y);
        state.fx.push({ x: o.x, y: o.y, vx: 0, vy: 0, r: o.r, hue: o.hue, life: 1, max: 0.25 });
        state.orbs[i] = state.orbs[state.orbs.length - 1]; state.orbs.pop();
      } else if (dist2(t, o) < MAGNET * MAGNET) {
        // Snappy short-range magnet: orbs you're nearly touching jump to you.
        const d = Math.hypot(o.x - t.x, o.y - t.y) || 1;
        o.x += (t.x - o.x) / d * MAGNET_PULL * dt; o.y += (t.y - o.y) / d * MAGNET_PULL * dt;
      }
    }

    // ram shapes
    for (const s of state.shapes) {
      const rr = r + s.r;
      if (dist2(t, s) < rr * rr) {
        const d = Math.hypot(s.x - t.x, s.y - t.y) || 1;
        const nx = (s.x - t.x) / d, ny = (s.y - t.y) / d;
        s.vx += nx * 90; s.vy += ny * 90;
        t.vx -= nx * 60; t.vy -= ny * 60;
        damageShape(s, bodyDmg(t) * dt * 6, t);
        hurt(t, s.kind.hp * 0.09 * dt * 6, null);
      }
    }

    // ram other tanks
    for (const e of state.tanks) {
      if (e === t || !e.alive) continue;
      const er = radiusOf(e), rr = r + er;
      if (dist2(t, e) < rr * rr) {
        const d = Math.hypot(e.x - t.x, e.y - t.y) || 1;
        const nx = (e.x - t.x) / d, ny = (e.y - t.y) / d;
        const push = (rr - d) * 6;
        t.vx -= nx * push; t.vy -= ny * push;
        e.vx += nx * push; e.vy += ny * push;
        hurt(e, bodyDmg(t) * dt * 3, t);
      }
    }
  }

  // --- bullets
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt;
    b.life -= dt;
    let dead = b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD;

    if (!dead) for (const s of state.shapes) {
      const rr = b.r + s.r;
      if (dist2(b, s) < rr * rr) {
        damageShape(s, b.dmg, b.owner);
        s.vx += b.vx * 0.05; s.vy += b.vy * 0.05;
        b.hp -= s.kind.hp * 0.25; dead = b.hp <= 0;
        state.fx.push({ x: b.x, y: b.y, vx: 0, vy: 0, r: b.r, hue: b.hue, life: 1, max: 0.18 });
        if (dead) break;
      }
    }

    if (!dead) for (const t of state.tanks) {
      if (!t.alive || t === b.owner || t.invuln > 0) continue;
      const rr = b.r + radiusOf(t);
      if (dist2(b, t) < rr * rr) {
        hurt(t, b.dmg, b.owner);
        t.vx += b.vx * 0.06; t.vy += b.vy * 0.06;
        burst(b.x, b.y, b.hue, 4, 90);
        Sfx.hit(b.x, b.y, b.owner === state.player);
        dead = true; break;
      }
    }

    if (dead) { state.bullets[i] = state.bullets[state.bullets.length - 1]; state.bullets.pop(); }
  }

  // --- shapes
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    const s = state.shapes[i];
    s.rot += s.vr * dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.vx *= Math.pow(0.2, dt); s.vy *= Math.pow(0.2, dt);
    s.flash *= Math.pow(0.002, dt);
    if (s.x < s.r || s.x > WORLD - s.r) s.vx *= -1;
    if (s.y < s.r || s.y > WORLD - s.r) s.vy *= -1;
    s.x = clamp(s.x, s.r, WORLD - s.r); s.y = clamp(s.y, s.r, WORLD - s.r);
    if (s.hp <= 0) {
      burst(s.x, s.y, s.hue, 14, 200);
      Sfx.shapeBreak(s.x, s.y, clamp(s.kind.xp / 1800, 0, 1));
      for (let n = 0; n < Math.min(14, 2 + s.kind.xp / 30); n++) {
        const a = rnd(0, TAU), d = rnd(0, s.r);
        const o = makeOrb(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d);
        o.hue = s.hue; o.xp = s.kind.xp / 14;
        state.orbs.push(o);
      }
      state.shapes[i] = state.shapes[state.shapes.length - 1]; state.shapes.pop();
    }
  }

  // --- particles
  for (let i = state.fx.length - 1; i >= 0; i--) {
    const f = state.fx[i];
    f.x += f.vx * dt; f.y += f.vy * dt;
    f.vx *= Math.pow(0.05, dt); f.vy *= Math.pow(0.05, dt);
    f.life -= dt / f.max;
    if (f.life <= 0) { state.fx[i] = state.fx[state.fx.length - 1]; state.fx.pop(); }
  }

  // --- respawn world content
  while (state.orbs.length < ORB_COUNT) state.orbs.push(makeOrb());
  while (state.shapes.length < SHAPE_COUNT) state.shapes.push(makeShape());
  for (const t of state.tanks) {
    if (!t.alive && t.isBot) {
      const level = clamp(Math.round(rnd(1, 3 + state.time / 45)), 1, 30);
      Object.assign(t, makeTank({ isBot: true, name: t.name, hue: rnd(0, 360) }));
      t.isBot = true; t.level = level;
      for (let i = 0; i < level - 1; i++) t.points++;
      t.maxhp = maxHp(t); t.hp = t.maxhp;
    }
  }

  // --- camera
  const cam = state.cam;
  const focus = p && p.alive ? p : { x: cam.x, y: cam.y, level: 20 };
  cam.x = lerp(cam.x, focus.x, 1 - Math.pow(0.0001, dt));
  cam.y = lerp(cam.y, focus.y, 1 - Math.pow(0.0001, dt));
  const want = clamp(1.05 - Math.pow(focus.level, 0.55) * 0.055, 0.42, 1.05);
  cam.zoom = lerp(cam.zoom, want, 1 - Math.pow(0.05, dt));
  Sfx.listener(cam.x, cam.y, cam.zoom);
}

function damageShape(s, dmg, by) {
  s.hp -= dmg; s.flash = 1;
  if (s.hp <= 0 && by && by.alive) addXp(by, s.kind.xp);
}

// ---------------------------------------------------------------- rendering
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const mini = document.getElementById('mini');
const mctx = mini.getContext('2d');
let DPR = 1, VW = 0, VH = 0;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  VW = window.innerWidth; VH = window.innerHeight;
  canvas.width = VW * DPR; canvas.height = VH * DPR;
  mini.width = mini.height = MINI * DPR;
}
window.addEventListener('resize', resize);

function worldFromScreen(sx, sy) {
  const z = state.cam.zoom;
  return { x: (sx - VW / 2) / z + state.cam.x, y: (sy - VH / 2) / z + state.cam.y };
}

function draw() {
  const z = state.cam.zoom, cam = state.cam;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#14161c';
  ctx.fillRect(0, 0, VW, VH);
  ctx.save();
  ctx.translate(VW / 2, VH / 2); ctx.scale(z, z); ctx.translate(-cam.x, -cam.y);

  const halfW = VW / 2 / z, halfH = VH / 2 / z;
  const view = { x0: cam.x - halfW, y0: cam.y - halfH, x1: cam.x + halfW, y1: cam.y + halfH };
  const vis = (e, pad = 0) => e.x + (e.r || 40) + pad > view.x0 && e.x - (e.r || 40) - pad < view.x1
                           && e.y + (e.r || 40) + pad > view.y0 && e.y - (e.r || 40) - pad < view.y1;

  // grid
  const G = 64;
  ctx.strokeStyle = '#1c1f27'; ctx.lineWidth = 1 / z; ctx.beginPath();
  for (let x = Math.floor(view.x0 / G) * G; x < view.x1; x += G) { ctx.moveTo(x, view.y0); ctx.lineTo(x, view.y1); }
  for (let y = Math.floor(view.y0 / G) * G; y < view.y1; y += G) { ctx.moveTo(view.x0, y); ctx.lineTo(view.x1, y); }
  ctx.stroke();

  // out-of-bounds shading
  ctx.fillStyle = 'rgba(200,40,60,0.10)';
  if (view.x0 < 0) ctx.fillRect(view.x0, view.y0, -view.x0, view.y1 - view.y0);
  if (view.y0 < 0) ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, -view.y0);
  if (view.x1 > WORLD) ctx.fillRect(WORLD, view.y0, view.x1 - WORLD, view.y1 - view.y0);
  if (view.y1 > WORLD) ctx.fillRect(view.x0, WORLD, view.x1 - view.x0, view.y1 - WORLD);

  // orbs
  for (const o of state.orbs) {
    if (!vis(o, 10)) continue;
    const wob = 1 + Math.sin(state.time * 3 + o.ph) * 0.08;
    ctx.fillStyle = `hsl(${o.hue} 80% 62%)`;
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r * wob, 0, TAU); ctx.fill();
  }

  // shapes
  for (const s of state.shapes) {
    if (!vis(s, 10)) continue;
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot);
    ctx.beginPath();
    for (let i = 0; i < s.kind.sides; i++) {
      const a = (i / s.kind.sides) * TAU;
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * s.r, Math.sin(a) * s.r);
    }
    ctx.closePath();
    const light = 55 + s.flash * 35;
    ctx.fillStyle = `hsl(${s.hue} 72% ${light}%)`;
    ctx.fill();
    ctx.lineWidth = 3 / 1; ctx.strokeStyle = `hsl(${s.hue} 60% ${light - 22}%)`; ctx.stroke();
    ctx.restore();
    if (s.hp < s.maxhp) healthBar(s.x, s.y + s.r + 9, s.r * 1.5, s.hp / s.maxhp, 3);
  }

  // bullets
  for (const b of state.bullets) {
    if (!vis(b, 8)) continue;
    ctx.fillStyle = `hsl(${b.hue} 85% 66%)`;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
    ctx.strokeStyle = `hsl(${b.hue} 70% 40%)`; ctx.lineWidth = 2; ctx.stroke();
  }

  // tanks
  for (const t of state.tanks) if (t.alive && vis(t, 60)) drawTank(t);

  // particles
  for (const f of state.fx) {
    ctx.globalAlpha = clamp(f.life, 0, 1);
    ctx.fillStyle = `hsl(${f.hue} 85% 66%)`;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.4 + f.life), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  drawMinimap();
}

function drawTank(t) {
  const r = radiusOf(t), tier = tierOf(t);
  ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(t.angle);
  // barrels
  const back = t.recoil * 4;
  for (const b of tier.barrels) {
    const w = r * 0.66 * (b.w ?? 1), len = r * (1.35 + ((b.speed ?? 1) - 1) * 0.45) * (b.size ?? 1);
    ctx.save(); ctx.rotate(b.a);
    ctx.fillStyle = '#9aa3b2'; ctx.strokeStyle = '#6e7684'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.rect(-back, -w / 2, len, w); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // body
  const light = 58 + t.flash * 30;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = t.invuln > 0 && ((state.time * 10) | 0) % 2 ? '#ffffff' : `hsl(${t.hue} 68% ${light}%)`;
  ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = `hsl(${t.hue} 55% ${light - 24}%)`; ctx.stroke();
  ctx.restore();

  // name + bars
  ctx.font = '600 15px Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.55)';
  const label = t === state.player ? t.name : `${t.name}`;
  ctx.strokeText(label, t.x, t.y - r - 16);
  ctx.fillStyle = t === state.player ? '#ffffff' : '#dfe6f0';
  ctx.fillText(label, t.x, t.y - r - 16);
  ctx.font = '500 11px Segoe UI, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fillText(`Lv ${t.level} ${tier.name}`, t.x, t.y - r - 4);
  if (t.hp < t.maxhp) healthBar(t.x, t.y + r + 11, r * 1.4, t.hp / t.maxhp, 5);
}

function healthBar(x, y, halfW, frac, h) {
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.beginPath(); ctx.roundRect(x - halfW, y, halfW * 2, h, h / 2); ctx.fill();
  ctx.fillStyle = frac > 0.4 ? '#45dd80' : frac > 0.18 ? '#ffc65a' : '#ff5a5a';
  ctx.beginPath(); ctx.roundRect(x - halfW, y, halfW * 2 * clamp(frac, 0, 1), h, h / 2); ctx.fill();
}

function drawMinimap() {
  const S = MINI;
  mctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  mctx.clearRect(0, 0, S, S);
  const k = S / WORLD;
  for (const t of state.tanks) {
    if (!t.alive) continue;
    const me = t === state.player;
    mctx.fillStyle = me ? '#57d2ff' : `hsl(${t.hue} 70% 60%)`;
    mctx.beginPath(); mctx.arc(t.x * k, t.y * k, me ? 3.4 : 2, 0, TAU); mctx.fill();
  }
}

// ---------------------------------------------------------------- UI
const el = id => document.getElementById(id);
const ui = {
  name: el('name'), sub: el('sub'), xpfill: el('xpfill'), hpfill: el('hpfill'),
  score: el('score'), lb: el('lb'), up: el('upgrades'), ulist: el('ulist'),
  uhint: el('uhint'), overlay: el('overlay'), card: el('card'),
};

// Upgrade rows are built once, then only their pips change.
const rows = SKILLS.map((s, i) => {
  const d = document.createElement('button');
  d.className = 'u'; d.type = 'button';
  d.innerHTML = `<kbd>${i + 1}</kbd><span class="label">${s.label}</span>` +
                `<span class="meter"><i></i></span>`;
  d.onclick = () => { spend(state.player, s.key); syncUI(); };
  ui.ulist.appendChild(d);
  return { el: d, fill: d.querySelector('.meter i'), key: s.key };
});

function syncUI() {
  const p = state.player;
  if (!p) return;
  ui.name.textContent = p.name;
  ui.sub.textContent = `Lv ${p.level} \u00b7 ${tierOf(p).name}`;
  const need = xpForLevel(p.level);
  ui.xpfill.style.width = (p.level >= MAX_LEVEL ? 100 : (p.xp / need) * 100) + '%';
  ui.hpfill.style.width = clamp(p.hp / p.maxhp, 0, 1) * 100 + '%';
  ui.score.textContent = Math.floor(p.score).toLocaleString();
  // The upgrade panel only exists when there is something to spend.
  ui.up.classList.toggle('show', p.points > 0);
  if (p.points > 0) {
    ui.uhint.textContent = p.points === 1 ? '1 point' : `${p.points} points`;
    for (const r of rows) {
      const n = p.skills[r.key];
      r.fill.style.width = (n / SKILL_MAX) * 100 + '%';
      r.el.disabled = n >= SKILL_MAX;
    }
  }
}

function syncLeaderboard() {
  const top = state.tanks.filter(t => t.alive).sort((a, b) => b.score - a.score).slice(0, 6);
  ui.lb.innerHTML = top.map((t, i) =>
    `<li class="${t === state.player ? 'me' : ''}"><b>${i + 1}</b><span>${escapeHtml(t.name)}</span><em>${Math.floor(t.score).toLocaleString()}</em></li>`
  ).join('');
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------------------------------------------------------------- run lifecycle
// Pick the candidate point furthest from any living tank.
function safeSpawn() {
  let best = { x: WORLD / 2, y: WORLD / 2 }, bestD = -1;
  for (let i = 0; i < 24; i++) {
    const c = { x: rnd(400, WORLD - 400), y: rnd(400, WORLD - 400) };
    let d = Infinity;
    for (const t of state.tanks) if (t.alive) d = Math.min(d, dist2(c, t));
    if (d > bestD) { bestD = d; best = c; }
  }
  return best;
}

function startRun(name) {
  state.orbs.length = state.shapes.length = state.tanks.length = 0;
  state.bullets.length = state.fx.length = 0;
  state.time = 0; state.startedAt = performance.now();
  for (let i = 0; i < ORB_COUNT; i++) state.orbs.push(makeOrb());
  for (let i = 0; i < SHAPE_COUNT; i++) state.shapes.push(makeShape());

  const p = makeTank({ name: name || 'you', x: WORLD / 2, y: WORLD / 2, hue: 198 });
  state.player = p;
  state.tanks.push(p);

  const names = shuffle(BOT_NAMES.slice());
  for (let i = 0; i < BOT_COUNT; i++) {
    const b = makeTank({ isBot: true, name: names[i % names.length] + (i >= names.length ? i : '') });
    const lv = clamp(Math.round(rnd(1, 5)), 1, 8);
    b.level = lv;
    for (let j = 0; j < lv - 1; j++) b.points++;
    b.maxhp = maxHp(b); b.hp = b.maxhp;
    state.tanks.push(b);
  }
  const spot = safeSpawn();          // bots exist by now, so place the player clear of them
  p.x = spot.x; p.y = spot.y; p.invuln = 3;
  state.cam.x = p.x; state.cam.y = p.y; state.cam.zoom = 1;
  state.running = true;
  Sfx.start();
  ui.overlay.classList.add('hidden');
  syncUI();
}

function endRun(killer) {
  state.running = false;
  const p = state.player;
  const secs = Math.round((performance.now() - state.startedAt) / 1000);
  const place = state.tanks.filter(t => t.score > p.score).length + 1;
  ui.card.innerHTML = `
    <h1>Rekt<span>.</span></h1>
    <p class="sub">${killer ? 'Taken down by ' + escapeHtml(killer.name) : 'You were destroyed'}</p>
    <p id="stats">
      Score <b>${Math.floor(p.score).toLocaleString()}</b><br>
      Level <b>${p.level}</b> &middot; ${tierOf(p).name}<br>
      Kills <b>${p.kills}</b> &middot; Survived <b>${Math.floor(secs / 60)}m ${secs % 60}s</b><br>
      Leaderboard place <b>#${place}</b>
    </p>
    <button id="again">Play again</button>
    <p class="help">Press <b>Enter</b> to respawn</p>`;
  ui.overlay.classList.remove('hidden');
  el('again').onclick = () => startRun(p.name);
}

// ---------------------------------------------------------------- input
canvas.addEventListener('mousemove', e => { state.mouse.x = e.clientX; state.mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => { if (e.button === 0) state.mouse.down = true; });
window.addEventListener('mouseup', () => { state.mouse.down = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('touchstart', e => {
  e.preventDefault(); const t = e.touches[0];
  state.mouse.x = t.clientX; state.mouse.y = t.clientY; state.mouse.down = true;
  if (state.player && state.player.alive) {
    const w = worldFromScreen(t.clientX, t.clientY);
    const d = Math.hypot(w.x - state.player.x, w.y - state.player.y) || 1;
    state.player.ix = (w.x - state.player.x) / d; state.player.iy = (w.y - state.player.y) / d;
  }
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  e.preventDefault(); const t = e.touches[0];
  state.mouse.x = t.clientX; state.mouse.y = t.clientY;
}, { passive: false });
canvas.addEventListener('touchend', e => { e.preventDefault(); state.mouse.down = false; if (state.player) { state.player.ix = state.player.iy = 0; } }, { passive: false });

window.addEventListener('keydown', e => {
  state.keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (!state.running) {
    if (e.code === 'Enter') {
      const btn = el('again');
      if (btn) btn.click(); else tryPlay();
    }
    return;
  }
  if (e.code === 'KeyE') { state.autofire = !state.autofire; }
  if (e.code === 'KeyM') { setMuteLabel(Sfx.toggle()); }
  const n = e.code.match(/^Digit([1-8])$/);
  if (n) { spend(state.player, SKILLS[+n[1] - 1].key); syncUI(); }
});
window.addEventListener('keyup', e => { state.keys[e.code] = false; });
window.addEventListener('blur', () => { state.keys = Object.create(null); state.mouse.down = false; });

// ---------------------------------------------------------------- main loop
let last = performance.now(), lbTimer = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.running) {
    step(dt);
    syncUI();
    lbTimer -= dt;
    if (lbTimer <= 0) { lbTimer = 0.35; syncLeaderboard(); }
  }
  draw();
  requestAnimationFrame(frame);
}

function setMuteLabel(m) {
  const b = el('mute');
  if (b) { b.textContent = m ? 'Sound off' : 'Sound on'; b.classList.toggle('off', m); }
}

function tryPlay() {
  const input = el('nick'), err = el('nameerr');
  const v = validateName(input.value || '');
  if (!v.ok) {
    Sfx.init(); Sfx.deny();
    err.textContent = v.error;
    input.focus();
    return;
  }
  err.textContent = '';
  startRun(v.name);
}

resize();
el('play').onclick = tryPlay;
el('nick').addEventListener('input', () => { el('nameerr').textContent = ''; });
el('mute').onclick = () => { Sfx.init(); setMuteLabel(Sfx.toggle()); };
requestAnimationFrame(frame);
})();
