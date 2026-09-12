/* Rep.io simulation — the authoritative game world.

   This module has no DOM and no audio; it runs identically under Node (on the
   Render server, where it is authoritative for every room) and in the browser
   (as the offline fallback when the server cannot be reached). Anything that
   used to make a sound now lands in world.events for the presentation layer
   to interpret. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const WORLD = 6400;
  const ORB_COUNT = 1350;
  const SHAPE_COUNT = 190;
  const MAX_LEVEL = 75;
  const FRICTION = 0.87;
  const MAGNET = 150;
  const MAGNET_PULL = 280;
  const BULLET_RANGE = 1850;
  const TAU = Math.PI * 2;

  // Move Speed gets a tenth rank; everything else stops at nine.
  const SKILLS = [
    { key: 'reload', label: 'Reload',      max: 9  },
    { key: 'damage', label: 'Damage',      max: 9  },
    { key: 'pen',    label: 'Bullet HP',   max: 9  },
    { key: 'bspeed', label: 'Bullet Spd',  max: 9  },
    { key: 'hp',     label: 'Health',      max: 9  },
    { key: 'regen',  label: 'Regen',       max: 9  },
    { key: 'speed',  label: 'Move Speed',  max: 10 },
  ];

  const TIERS = [
    { level: 1,  name: 'Scout',      barrels: [{ a: 0, w: 1, spread: 0.05 }] },
    { level: 6,  name: 'Twin',       barrels: [{ a: -0.10, w: 0.8 }, { a: 0.10, w: 0.8 }] },
    { level: 12, name: 'Sniper',     barrels: [{ a: 0, w: 1.25, spread: 0.008, speed: 1.7, dmg: 1.8, rate: 2.1, range: 1.9 }] },
    { level: 18, name: 'Triplet',    barrels: [{ a: -0.30, w: .8 }, { a: 0, w: 1 }, { a: 0.30, w: .8 }] },
    { level: 24, name: 'Hunter',     barrels: [{ a: -0.26, w: .8 }, { a: 0.26, w: .8 }, { a: Math.PI, w: 1, rate: 1.4 }] },
    { level: 30, name: 'Spreadshot', barrels: [{ a: -0.55, w: .7 }, { a: -0.28, w: .8 }, { a: 0, w: 1 }, { a: 0.28, w: .8 }, { a: 0.55, w: .7 }] },
    { level: 38, name: 'Annihilator',barrels: [
        { a: 0, w: 1.5, speed: 0.85, dmg: 2.6, rate: 2.4, size: 1.7 },
        { a: Math.PI * 0.66, w: .7 }, { a: -Math.PI * 0.66, w: .7 }] },
    { level: 45, name: 'Octo', barrels: Array.from({ length: 8 }, (_, i) => (
        { a: i * Math.PI / 4, w: 0.72, dmg: 0.72, rate: 1.15, range: 0.8 })) },
    { level: 55, name: 'Railgun', barrels: [
        { a: 0, w: 1.1, spread: 0.004, speed: 2.6, dmg: 5.5, rate: 4.2, size: 1.25, range: 2.4 },
        { a: Math.PI * 0.8, w: .55, dmg: .4, rate: 4.2 },
        { a: -Math.PI * 0.8, w: .55, dmg: .4, rate: 4.2 }] },
    { level: 75, name: 'Overlord', barrels: [
        { a: 0, w: 1.6, speed: 1.15, dmg: 2.2, rate: 1.5, size: 1.4 },
        { a: -0.42, w: .85, dmg: 1.1 }, { a: 0.42, w: .85, dmg: 1.1 },
        { a: -0.85, w: .7 }, { a: 0.85, w: .7 },
        { a: Math.PI * 0.88, w: .8, rate: 1.5 }, { a: -Math.PI * 0.88, w: .8, rate: 1.5 }] },
  ];

  const SHAPE_KINDS = [
    { sides: 4, r: 22, hp: 12,   xp: 14,   hue: 48,  name: 'square' },
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
  const lerp = (a, b, t) => a + (b - a) * t;
  const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };

  function angDiff(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }

  // Squared distance from a point to a segment — used for swept collision so a
  // fast bullet cannot skip past a target between frames.
  function segDist2(ax, ay, bx, by, px, py) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t - px, qy = ay + dy * t - py;
    return qx * qx + qy * qy;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  // Levels 1-25 are unchanged; past 25 each level costs progressively more.
  function xpForLevel(l) {
    const base = 13 * Math.pow(l, 1.1);
    return Math.round(l <= 25 ? base : base * (1 + (l - 25) * 0.02));
  }

  const radiusOf = t => 17 + Math.pow(t.level, 0.62) * 3.4;
  const moveSpeed = (level, speedSkill) => (262 + speedSkill * 26) * (1 - Math.min(0.32, level * 0.004));
  const skillMax = key => SKILLS.find(s => s.key === key).max;

  function unlocked(t) { return TIERS.filter(tr => t.level >= tr.level); }

  function tierOf(t) {
    const list = unlocked(t);
    if (t.isBot) return list[list.length - 1];
    t.weapon = clamp(t.weapon | 0, 0, list.length - 1);
    return list[t.weapon];
  }

  // ---------------------------------------------------------------- world
  let nextId = 1;

  class World {
    constructor(opts = {}) {
      this.orbs = []; this.shapes = []; this.tanks = []; this.bullets = []; this.events = [];
      this.time = 0;
      this.zoomHint = opts.zoomHint || 1;   // used only for the bullet-reach floor
      for (let i = 0; i < ORB_COUNT; i++) this.orbs.push(this.makeOrb());
      for (let i = 0; i < SHAPE_COUNT; i++) this.shapes.push(this.makeShape());
      this.botNames = shuffle(BOT_NAMES.slice());
      this.botSeq = 0;
    }

    makeOrb(x, y) {
      return {
        x: x ?? rnd(20, WORLD - 20), y: y ?? rnd(20, WORLD - 20),
        r: rnd(5, 9), hue: (rnd(0, 360)) | 0, xp: 4,
      };
    }

    makeShape(kind) {
      const k = kind || (Math.random() < 0.62 ? SHAPE_KINDS[0]
        : Math.random() < 0.75 ? SHAPE_KINDS[1]
        : Math.random() < 0.93 ? SHAPE_KINDS[2] : SHAPE_KINDS[3]);
      return {
        id: nextId++, kind: k, kindIdx: SHAPE_KINDS.indexOf(k),
        x: rnd(60, WORLD - 60), y: rnd(60, WORLD - 60),
        r: k.r * rnd(0.92, 1.08), hp: k.hp, maxhp: k.hp,
        rot: rnd(0, TAU), vr: rnd(-0.4, 0.4), vx: rnd(-8, 8), vy: rnd(-8, 8),
        hue: k.hue,
      };
    }

    // Spawn clear of everyone already playing.
    safeSpawn() {
      let best = { x: WORLD / 2, y: WORLD / 2 }, bestD = -1;
      for (let i = 0; i < 24; i++) {
        const c = { x: rnd(400, WORLD - 400), y: rnd(400, WORLD - 400) };
        let d = Infinity;
        for (const t of this.tanks) if (t.alive) d = Math.min(d, dist2(c, t));
        if (d > bestD) { bestD = d; best = c; }
      }
      return best;
    }

    addTank(opts = {}) {
      const spot = this.safeSpawn();
      const t = {
        id: opts.id || 'e' + nextId++,
        name: opts.name || 'anon', isBot: !!opts.isBot,
        x: spot.x, y: spot.y, px: spot.x, py: spot.y,
        vx: 0, vy: 0, angle: rnd(0, TAU), ix: 0, iy: 0, fire: false,
        level: 1, xp: 0, score: 0, kills: 0, points: 0, weapon: 0,
        skills: SKILLS.reduce((o, s) => (o[s.key] = 0, o), {}),
        hue: opts.hue ?? (rnd(0, 360) | 0),
        cool: 0, recoil: 0, alive: true, invuln: 3, spawnedAt: this.time,
        ai: { mode: 'roam', target: null, wander: rnd(0, TAU), t: 0, jitter: 0 },
      };
      if (opts.level > 1) { t.level = opts.level; t.points = opts.level - 1; }
      t.maxhp = this.maxHp(t); t.hp = t.maxhp;
      this.tanks.push(t);
      return t;
    }

    addBot() {
      const name = this.botNames[this.botSeq % this.botNames.length] +
                   (this.botSeq >= this.botNames.length ? this.botSeq : '');
      this.botSeq++;
      return this.addTank({ isBot: true, name, level: this.botLevel() });
    }

    // Aim bots at the level of the people actually playing here.
    botLevel() {
      const humans = this.tanks.filter(t => !t.isBot && t.alive);
      const ref = humans.length
        ? humans.reduce((n, t) => n + t.level, 0) / humans.length
        : 3;
      return clamp(Math.round(rnd(1, Math.max(5, ref * 1.25))), 1, 40);
    }

    removeTank(t) {
      const i = this.tanks.indexOf(t);
      if (i >= 0) { this.tanks[i] = this.tanks[this.tanks.length - 1]; this.tanks.pop(); }
    }

    // ---- derived stats. Bots ramp from soft to full strength over four minutes.
    botEdge(t) {
      if (!t.isBot) return 1;
      return clamp(0.45 + (this.time - (t.spawnedAt || 0)) / 240, 0.45, 1);
    }
    maxHp(t) { return (52 + (t.level - 1) * 7 + t.skills.hp * 22) * (t.isBot ? lerp(0.55, 1, this.botEdge(t)) : 1); }
    regenOf(t) { return 0.35 + t.skills.regen * 1.5 + this.maxHp(t) * 0.0007 * t.skills.regen; }
    speedOf(t) { return moveSpeed(t.level, t.skills.speed); }
    bodyDmg(t) { return (10 + t.level * 1.1) * this.botEdge(t); }
    fireRate(t) { return (0.42 / (1 + t.skills.reload * 0.16)) * (t.isBot ? lerp(1.7, 1, this.botEdge(t)) : 1); }
    bulletDmg(t) { return (7 + t.skills.damage * 4.5 + t.level * 0.32) * this.botEdge(t); }
    bulletHp(t) { return 6 + t.skills.pen * 5 + t.level * 0.2; }
    bulletSpd(t) { return 560 + t.skills.bspeed * 55; }

    emit(k, data) { this.events.push(Object.assign({ k }, data)); }

    addXp(t, amount) {
      if (!t.alive) return;
      t.xp += amount; t.score += amount;
      while (t.level < MAX_LEVEL && t.xp >= xpForLevel(t.level)) {
        t.xp -= xpForLevel(t.level);
        t.level++; t.points++;
        const before = t.maxhp;
        t.maxhp = this.maxHp(t);
        t.hp += t.maxhp - before;
        this.emit('level', { by: t.id, x: t.x, y: t.y, hue: t.hue });
        const guns = unlocked(t).length;
        if (guns - 1 > t.weapon && TIERS[guns - 1].level === t.level) {
          t.weapon = guns - 1;
          this.emit('gun', { by: t.id });
        }
      }
      if (t.level >= MAX_LEVEL) t.xp = Math.min(t.xp, xpForLevel(MAX_LEVEL));
    }

    spend(t, key) {
      const max = skillMax(key);
      if (t.points <= 0 || t.skills[key] === undefined || t.skills[key] >= max) {
        this.emit('deny', { by: t.id });
        return false;
      }
      t.points--; t.skills[key]++;
      const before = t.maxhp; t.maxhp = this.maxHp(t);
      t.hp += t.maxhp - before;
      this.emit('up', { by: t.id });
      return true;
    }

    switchWeapon(t, delta) {
      const n = unlocked(t).length;
      if (n < 2) return false;
      t.weapon = ((t.weapon + delta) % n + n) % n;
      t.cool = Math.max(t.cool, 0.18);
      this.emit('gun', { by: t.id });
      return true;
    }

    selectWeapon(t, i) {
      const n = unlocked(t).length;
      if (i < 0 || i >= n || i === t.weapon) return false;
      t.weapon = i;
      t.cool = Math.max(t.cool, 0.18);
      this.emit('gun', { by: t.id });
      return true;
    }

    shoot(t) {
      if (t.cool > 0 || !t.alive) return;
      const tier = tierOf(t);
      const r = radiusOf(t);
      for (const b of tier.barrels) {
        const spread = (b.spread ?? 0.045) * (t.isBot ? 1.6 / this.botEdge(t) : 1);
        const ang = t.angle + b.a + rnd(-spread, spread);
        const speed = this.bulletSpd(t) * (b.speed ?? 1);
        const size = (5.4 + r * 0.15) * (b.size ?? 1) * (b.w ?? 1);
        this.bullets.push({
          owner: t, hue: t.hue, x: t.x + Math.cos(ang) * (r + size),
          y: t.y + Math.sin(ang) * (r + size),
          vx: Math.cos(ang) * speed + t.vx * 0.35,
          vy: Math.sin(ang) * speed + t.vy * 0.35,
          r: size, dmg: this.bulletDmg(t) * (b.dmg ?? 1),
          hp: this.bulletHp(t) * (b.dmg ?? 1),
          life: Math.max(BULLET_RANGE * (b.range ?? 1), 780 / this.zoomHint) / speed,
        });
        t.vx -= Math.cos(ang) * speed * 0.035;
        t.vy -= Math.sin(ang) * speed * 0.035;
      }
      t.recoil = 1;
      t.invuln = 0;                       // shooting drops your spawn shield
      t.cool = this.fireRate(t) * (tier.barrels[0].rate ?? 1);
      this.emit('shoot', { by: t.id, x: t.x, y: t.y, size: tier.barrels[0].size ?? 1 });
    }

    hurt(target, dmg, from) {
      if (!target.alive || target.invuln > 0) return;
      target.hp -= dmg;
      if (dmg > 2) this.emit('hurt', { on: target.id });
      if (target.hp <= 0) this.kill(target, from);
    }

    kill(t, by) {
      if (!t.alive) return;
      t.alive = false;
      t.diedAt = this.time;
      this.emit('die', { on: t.id, by: by ? by.id : null, x: t.x, y: t.y, hue: t.hue,
                         byName: by && by !== t ? by.name : null });
      const drops = clamp(Math.round(t.score * 0.02), 6, 80);
      for (let i = 0; i < drops; i++) {
        const a = rnd(0, TAU), d = rnd(0, radiusOf(t) * 3);
        const o = this.makeOrb(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d);
        o.hue = t.hue; o.r = rnd(7, 11); o.xp = Math.max(3, (t.score * 0.16) / drops);
        this.orbs.push(o);
      }
      if (by && by.alive && by !== t) {
        by.kills++;
        this.addXp(by, 40 + t.score * 0.22);
        this.emit('kill', { by: by.id, on: t.id });
      }
    }

    damageShape(s, dmg, by) {
      s.hp -= dmg;
      if (s.hp <= 0 && by && by.alive) this.addXp(by, s.kind.xp);
    }

    // ---------------------------------------------------------------- bots
    botThink(t, dt) {
      const ai = t.ai;
      ai.t -= dt;
      const r = radiusOf(t);

      if (ai.t <= 0) {
        ai.t = rnd(0.18, 0.4);
        ai.jitter = rnd(-0.12, 0.12);
        let bestFood = null, bestFoodD = Infinity;
        let bestFoe = null, bestFoeD = Infinity;
        let threat = null, threatD = Infinity;

        for (const s of this.shapes) {
          const d = dist2(t, s);
          if (d > 1300 * 1300) continue;
          const cost = d * (s.kind.hp > t.level * 45 ? 5 : 1);
          if (cost < bestFoodD) { bestFoodD = cost; bestFood = s; }
        }
        for (const o of this.orbs) {
          const d = dist2(t, o) * 0.6;
          if (d < bestFoodD) { bestFoodD = d; bestFood = o; }
        }
        for (const e of this.tanks) {
          if (e === t || !e.alive) continue;
          const d = dist2(t, e);
          if (d > 1500 * 1500) continue;
          const mine = t.score + t.hp * 3, theirs = e.score + e.hp * 3;
          if (theirs > mine * 1.55 && d < threatD) { threatD = d; threat = e; }
          else if (theirs < mine * 1.3 && d < bestFoeD && !(e.level <= 4 && e.score < 120)) {
            bestFoeD = d; bestFoe = e;
          }
        }

        if (threat && t.hp < t.maxhp * 0.45) { ai.mode = 'flee'; ai.target = threat; }
        else if (bestFoe) { ai.mode = 'fight'; ai.target = bestFoe; }
        else if (bestFood) { ai.mode = 'feed'; ai.target = bestFood; }
        else { ai.mode = 'roam'; ai.target = null; ai.wander = rnd(0, TAU); }
      }

      if (t.points > 0) {
        const build = t.buildOrder || (t.buildOrder = shuffle(SKILLS.map(s => s.key)));
        for (const k of build) if (this.spend(t, k)) break;
      }

      let mx = 0, my = 0, fire = false;
      const tg = ai.target;
      if (tg && (tg.alive === undefined || tg.alive)) {
        const dx = tg.x - t.x, dy = tg.y - t.y, d = Math.hypot(dx, dy) || 1;
        if (ai.mode === 'flee') { mx = -dx / d; my = -dy / d; t.angle = Math.atan2(dy, dx); fire = true; }
        else if (ai.mode === 'fight') {
          const lead = d / this.bulletSpd(t);
          const ax = tg.x + (tg.vx || 0) * lead - t.x, ay = tg.y + (tg.vy || 0) * lead - t.y;
          t.angle = lerp(t.angle, t.angle + angDiff(t.angle, Math.atan2(ay, ax) + ai.jitter), 0.35);
          const want = 320 + r * 4;
          const push = d < want * 0.7 ? -1 : d > want ? 1 : 0;
          mx = (dx / d) * push - (dy / d) * 0.5; my = (dy / d) * push + (dx / d) * 0.5;
          fire = d < 900;
        } else {
          mx = dx / d; my = dy / d;
          t.angle = lerp(t.angle, t.angle + angDiff(t.angle, Math.atan2(dy, dx)), 0.2);
          fire = tg.kind !== undefined && d < 520;
        }
      } else {
        ai.wander += rnd(-0.6, 0.6) * dt;
        mx = Math.cos(ai.wander); my = Math.sin(ai.wander);
        t.angle += dt * 0.8;
      }

      const m = 380;
      if (t.x < m) mx += (m - t.x) / m;
      if (t.x > WORLD - m) mx -= (t.x - (WORLD - m)) / m;
      if (t.y < m) my += (m - t.y) / m;
      if (t.y > WORLD - m) my -= (t.y - (WORLD - m)) / m;

      const len = Math.hypot(mx, my) || 1;
      t.ix = mx / len; t.iy = my / len;
      if (fire) this.shoot(t);
    }

    // ---------------------------------------------------------------- step
    step(dt) {
      this.time += dt;

      for (const t of this.tanks) {
        if (!t.alive) continue;
        if (t.isBot) this.botThink(t, dt);
        else if (t.fire) this.shoot(t);

        const acc = this.speedOf(t) * 5.2;
        t.vx += (t.ix || 0) * acc * dt;
        t.vy += (t.iy || 0) * acc * dt;
        const fr = Math.pow(FRICTION, dt * 60);
        t.vx *= fr; t.vy *= fr;
        const sp = Math.hypot(t.vx, t.vy), max = this.speedOf(t);
        if (sp > max) { t.vx = t.vx / sp * max; t.vy = t.vy / sp * max; }
        t.px = t.x; t.py = t.y;
        t.x += t.vx * dt; t.y += t.vy * dt;

        const r = radiusOf(t);
        t.x = clamp(t.x, r, WORLD - r); t.y = clamp(t.y, r, WORLD - r);
        t.cool = Math.max(0, t.cool - dt);
        t.recoil *= Math.pow(0.001, dt);
        t.invuln = Math.max(0, t.invuln - dt);
        t.maxhp = this.maxHp(t);
        if (t.hp < t.maxhp) t.hp = Math.min(t.maxhp, t.hp + this.regenOf(t) * dt);

        for (let i = this.orbs.length - 1; i >= 0; i--) {
          const o = this.orbs[i];
          if (segDist2(t.px, t.py, t.x, t.y, o.x, o.y) < (r + o.r) * (r + o.r)) {
            this.addXp(t, o.xp);
            this.emit('pickup', { by: t.id, x: o.x, y: o.y, hue: o.hue, r: o.r });
            this.orbs[i] = this.orbs[this.orbs.length - 1]; this.orbs.pop();
          } else if (dist2(t, o) < MAGNET * MAGNET) {
            const d = Math.hypot(o.x - t.x, o.y - t.y) || 1;
            o.x += (t.x - o.x) / d * MAGNET_PULL * dt;
            o.y += (t.y - o.y) / d * MAGNET_PULL * dt;
          }
        }

        for (const s of this.shapes) {
          const rr = r + s.r;
          if (dist2(t, s) < rr * rr) {
            const d = Math.hypot(s.x - t.x, s.y - t.y) || 1;
            const nx = (s.x - t.x) / d, ny = (s.y - t.y) / d;
            s.vx += nx * 90; s.vy += ny * 90;
            t.vx -= nx * 60; t.vy -= ny * 60;
            this.damageShape(s, this.bodyDmg(t) * dt * 6, t);
            this.hurt(t, s.kind.hp * 0.09 * dt * 6, null);
          }
        }

        for (const e of this.tanks) {
          if (e === t || !e.alive) continue;
          const er = radiusOf(e), rr = r + er;
          if (dist2(t, e) < rr * rr) {
            const d = Math.hypot(e.x - t.x, e.y - t.y) || 1;
            const nx = (e.x - t.x) / d, ny = (e.y - t.y) / d;
            const push = (rr - d) * 6;
            t.vx -= nx * push; t.vy -= ny * push;
            e.vx += nx * push; e.vy += ny * push;
            this.hurt(e, this.bodyDmg(t) * dt * 3, t);
          }
        }
      }

      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        const px = b.x, py = b.y;
        b.x += b.vx * dt; b.y += b.vy * dt;
        b.life -= dt;
        let dead = b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD;

        if (!dead) for (const s of this.shapes) {
          const rr = b.r + s.r;
          if (segDist2(px, py, b.x, b.y, s.x, s.y) < rr * rr) {
            this.damageShape(s, b.dmg, b.owner);
            s.vx += b.vx * 0.05; s.vy += b.vy * 0.05;
            b.hp -= s.kind.hp * 0.25; dead = b.hp <= 0;
            this.emit('spark', { x: b.x, y: b.y, hue: b.hue, r: b.r });
            if (dead) break;
          }
        }

        if (!dead) for (const t of this.tanks) {
          if (!t.alive || t === b.owner) continue;
          const rr = b.r + radiusOf(t);
          if (segDist2(px, py, b.x, b.y, t.x, t.y) < rr * rr) {
            if (t.invuln > 0) {
              this.emit('shield', { x: b.x, y: b.y });
              dead = true; break;
            }
            this.hurt(t, b.dmg, b.owner);
            t.vx += b.vx * 0.06; t.vy += b.vy * 0.06;
            this.emit('hit', { by: b.owner.id, on: t.id, x: t.x, y: t.y, hue: b.hue });
            dead = true; break;
          }
        }

        if (dead) { this.bullets[i] = this.bullets[this.bullets.length - 1]; this.bullets.pop(); }
      }

      for (let i = this.shapes.length - 1; i >= 0; i--) {
        const s = this.shapes[i];
        s.rot += s.vr * dt;
        s.x += s.vx * dt; s.y += s.vy * dt;
        s.vx *= Math.pow(0.2, dt); s.vy *= Math.pow(0.2, dt);
        if (s.x < s.r || s.x > WORLD - s.r) s.vx *= -1;
        if (s.y < s.r || s.y > WORLD - s.r) s.vy *= -1;
        s.x = clamp(s.x, s.r, WORLD - s.r); s.y = clamp(s.y, s.r, WORLD - s.r);
        if (s.hp <= 0) {
          this.emit('break', { x: s.x, y: s.y, hue: s.hue, big: clamp(s.kind.xp / 1800, 0, 1) });
          for (let n = 0; n < Math.min(14, 2 + s.kind.xp / 30); n++) {
            const a = rnd(0, TAU), d = rnd(0, s.r);
            const o = this.makeOrb(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d);
            o.hue = s.hue; o.xp = s.kind.xp / 14;
            this.orbs.push(o);
          }
          this.shapes[i] = this.shapes[this.shapes.length - 1]; this.shapes.pop();
        }
      }

      while (this.orbs.length < ORB_COUNT) this.orbs.push(this.makeOrb());
      while (this.shapes.length < SHAPE_COUNT) this.shapes.push(this.makeShape());
    }

    // Respawn dead bots in place, a little stronger as the round matures.
    recycleBots() {
      for (const t of this.tanks) {
        if (t.alive || !t.isBot) continue;
        const level = this.botLevel();
        const spot = this.safeSpawn();
        Object.assign(t, {
          x: spot.x, y: spot.y, px: spot.x, py: spot.y, vx: 0, vy: 0,
          level, xp: 0, score: 0, kills: 0, points: level - 1, weapon: 0,
          skills: SKILLS.reduce((o, s) => (o[s.key] = 0, o), {}),
          buildOrder: null, alive: true, invuln: 3, cool: 0, spawnedAt: this.time,
          hue: rnd(0, 360) | 0, ai: { mode: 'roam', target: null, wander: rnd(0, TAU), t: 0, jitter: 0 },
        });
        t.maxhp = this.maxHp(t); t.hp = t.maxhp;
      }
    }

    respawn(t) {
      const spot = this.safeSpawn();
      Object.assign(t, {
        x: spot.x, y: spot.y, px: spot.x, py: spot.y, vx: 0, vy: 0,
        level: 1, xp: 0, score: 0, kills: 0, points: 0, weapon: 0,
        skills: SKILLS.reduce((o, s) => (o[s.key] = 0, o), {}),
        alive: true, invuln: 3, cool: 0,
      });
      t.maxhp = this.maxHp(t); t.hp = t.maxhp;
    }

    leaderboard(n = 6) {
      return this.tanks.filter(t => t.alive).sort((a, b) => b.score - a.score).slice(0, n)
        .map(t => ({ id: t.id, name: t.name, score: Math.floor(t.score), bot: t.isBot }));
    }

    // Everything the given tank can see, rounded hard to keep frames small.
    snapshotFor(me, halfW, halfH) {
      const pad = 120;
      const x0 = me.x - halfW - pad, x1 = me.x + halfW + pad;
      const y0 = me.y - halfH - pad, y1 = me.y + halfH + pad;
      const vis = e => e.x > x0 && e.x < x1 && e.y > y0 && e.y < y1;
      const R = v => Math.round(v);

      const tanks = [];
      for (const t of this.tanks) {
        if (!t.alive || !vis(t)) continue;
        tanks.push([t.id, R(t.x), R(t.y), +t.angle.toFixed(2), t.level, t.hue,
                    R(t.hp), R(t.maxhp), t.invuln > 0 ? 1 : 0,
                    unlocked(t).indexOf(tierOf(t)), t.name, +t.recoil.toFixed(2)]);
      }
      const bullets = [];
      for (const b of this.bullets) if (vis(b)) bullets.push([R(b.x), R(b.y), R(b.r), b.hue, R(b.vx), R(b.vy)]);
      const shapes = [];
      for (const s of this.shapes) {
        if (!vis(s)) continue;
        shapes.push([s.id, R(s.x), R(s.y), R(s.r), s.kind.sides, s.hue,
                     R(s.hp), R(s.maxhp), +s.rot.toFixed(2)]);
      }
      const dots = this.tanks.filter(t => t.alive)
        .map(t => [R(t.x / 25), R(t.y / 25), t === me ? 1 : 0, t.hue]);
      return { tanks, bullets, shapes, dots };
    }

    orbsFor(me, halfW, halfH) {
      const pad = 100, out = [];
      for (const o of this.orbs) {
        if (o.x < me.x - halfW - pad || o.x > me.x + halfW + pad) continue;
        if (o.y < me.y - halfH - pad || o.y > me.y + halfH + pad) continue;
        out.push(Math.round(o.x), Math.round(o.y), Math.round(o.r), o.hue);
      }
      return out;
    }
  }

  return {
    World, TIERS, SKILLS, SHAPE_KINDS, WORLD, MAX_LEVEL, TAU,
    xpForLevel, radiusOf, moveSpeed, unlocked, tierOf, skillMax,
    clamp, lerp, rnd, segDist2,
    MAGNET, MAGNET_PULL, FRICTION, ORB_COUNT, BOT_NAMES,
  };
});
