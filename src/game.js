/* Rep.io client — input, netcode and rendering.

   The simulation lives in src/sim.js and runs on the server, which is
   authoritative for every room. This file sends input, interpolates the
   snapshots that come back, predicts its own tank so movement feels
   immediate, and draws the result.

   If the server cannot be reached (asleep, offline, opened as a local file)
   the same sim.js runs here in the browser instead and the game carries on
   as single player. Everything below the net layer is written against one
   normalised frame, so the renderer never knows which mode it is in. */
(() => {
'use strict';

const TAU = Math.PI * 2;
const MINI = 124;                 // minimap edge length in CSS pixels
const FLOOR = '#14161c';          // arena floor
const GRID = '#1c1f27';           // grid lines
const INTERP_DELAY = 0.1;         // render this far behind the server, in seconds
const INPUT_HZ = 20;

const clamp = Sim.clamp, lerp = Sim.lerp;
const WORLD = Sim.WORLD;

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
  return { spaced, tight, squashed: tight.replace(/(.)\1+/g, '$1') };
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
    if (new RegExp(`\\b${w}\\b`).test(f.spaced) || f.tight === w || f.squashed === w)
      return { ok: false, error: 'Pick a nickname without that word in it.' };
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------- state
const state = {
  mode: 'menu',                 // menu | playing | dead
  link: 'idle',                 // idle | connecting | online | offline
  name: 'you',
  mouse: { x: 0, y: 0, down: false },
  keys: Object.create(null),
  autofire: false,
  cam: { x: WORLD / 2, y: WORLD / 2, zoom: 1 },
  fx: [],
  time: 0,
  online: 0,
  pop: { humans: 0, bots: 0 },
  tiers: Sim.TIERS.map(t => ({ level: t.level, name: t.name })),
  skills: Sim.SKILLS,
  me: null,                     // authoritative own stats
  lb: [],
  dots: [],
  killedBy: null,
  pendingRespawn: null,     // seconds spent waiting for the server to revive us
};

// Own-tank prediction, so movement responds before the server answers.
const pred = { x: WORLD / 2, y: WORLD / 2, vx: 0, vy: 0, ready: false };

// ---------------------------------------------------------------- net
const net = {
  ws: null, id: null, snaps: [], orbs: [], lastInput: 0, offline: null,
};

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect(then) {
  if (location.protocol === 'file:') { goOffline(); then && then(); return; }
  setLink('connecting');
  let settled = false;
  let ws;
  try { ws = new WebSocket(wsUrl()); }
  catch { goOffline(); then && then(); return; }
  net.ws = ws;

  const fail = () => {
    if (settled) return;
    settled = true;
    goOffline();
    then && then();
  };
  const timer = setTimeout(fail, 4000);

  ws.onopen = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    setLink('online');
    then && then();
  };
  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };
  ws.onerror = fail;
  ws.onclose = () => {
    clearTimeout(timer);
    if (!settled) { fail(); return; }
    // Lost mid-game: fall back to a local world so play continues.
    if (state.mode === 'playing' || state.mode === 'dead') {
      goOffline();
      startLocal();
    } else setLink('offline');
  };
}

function send(obj) {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj));
}

function setLink(v) {
  state.link = v;
  const el = ui.link;
  if (!el) return;
  el.textContent = v === 'online' ? (state.online > 1 ? `Online · ${state.online} playing` : 'Online')
    : v === 'connecting' ? 'Connecting…'
    : v === 'offline' ? 'Offline · solo vs bots' : '';
  el.className = 'link ' + v;
}

function onMessage(msg) {
  switch (msg.t) {
    case 'hello':
      state.online = msg.online || 0;
      setLink(state.link);
      break;
    case 'welcome':
      net.id = msg.id;
      if (msg.tiers) state.tiers = msg.tiers;
      if (msg.skills) state.skills = msg.skills;
      buildRows();
      pred.ready = false;
      break;
    case 's': {
      const snap = {
        at: state.time, tanks: msg.tanks, bullets: msg.bullets,
        shapes: msg.shapes, me: msg.me,
      };
      net.snaps.push(snap);
      while (net.snaps.length > 4) net.snaps.shift();
      if (msg.dots) state.dots = msg.dots;
      if (msg.lb) state.lb = msg.lb;
      if (msg.pop) state.pop = msg.pop;
      if (msg.me && state.mode === 'dead' && state.pendingRespawn !== null) enterPlaying();
      if (msg.me) {
        state.me = msg.me;
        if (!pred.ready) { pred.x = msg.me.x; pred.y = msg.me.y; pred.ready = true; }
        // Reconcile against the server, extrapolated over the snapshot's age.
        const age = INTERP_DELAY;
        const sx = msg.me.x + msg.me.vx * age, sy = msg.me.y + msg.me.vy * age;
        if (Math.hypot(sx - pred.x, sy - pred.y) > 420) { pred.x = sx; pred.y = sy; }
        else { pred.x = lerp(pred.x, sx, 0.25); pred.y = lerp(pred.y, sy, 0.25); }
      }
      if (msg.ev) handleEvents(msg.ev, ev => !!ev.m, ev => ev.on === net.id);
      break;
    }
    case 'o': {
      // Kept as objects so the local magnet can nudge them between updates.
      const a = msg.o, out = [];
      for (let i = 0; i < a.length; i += 4) out.push({ x: a[i], y: a[i + 1], r: a[i + 2], hue: a[i + 3] });
      net.orbs = out;
      break;
    }
  }
}

function goOffline() {
  if (net.ws) { try { net.ws.onclose = null; net.ws.close(); } catch {} net.ws = null; }
  setLink('offline');
}

// ---------------------------------------------------------------- offline world
function startLocal() {
  const w = new Sim.World();
  const me = w.addTank({ name: state.name, hue: 198 });
  for (let i = 0; i < 12; i++) w.addBot();
  net.offline = { world: w, me };
  net.id = me.id;
  state.tiers = Sim.TIERS.map(t => ({ level: t.level, name: t.name }));
  state.skills = Sim.SKILLS;
  buildRows();
  pred.x = me.x; pred.y = me.y; pred.ready = true;
  state.mode = 'playing';
  ui.overlay.classList.add('hidden');
}

// ---------------------------------------------------------------- events -> sfx
function handleEvents(list, isMine, isOnMe) {
  for (const ev of list) {
    const mine = isMine(ev), onMe = isOnMe(ev);
    switch (ev.k) {
      case 'shoot':  Sfx.shoot(ev.x, ev.y, ev.size || 1, mine); break;
      case 'hit':    Sfx.hit(ev.x, ev.y, mine); burst(ev.x, ev.y, ev.hue, 4, 90); break;
      case 'spark':  burst(ev.x, ev.y, ev.hue, 3, 70); break;
      case 'pickup': if (mine) { Sfx.pickup(ev.x, ev.y); pop(ev.x, ev.y, ev.hue, ev.r); } break;
      case 'break':  Sfx.shapeBreak(ev.x, ev.y, ev.big); burst(ev.x, ev.y, ev.hue, 14, 200); break;
      case 'shield': Sfx.shield(ev.x, ev.y); burst(ev.x, ev.y, 200, 5, 120); break;
      case 'hurt':   if (onMe) Sfx.hurt(); break;
      case 'level':  if (mine) { Sfx.levelUp(); burst(ev.x, ev.y, ev.hue, 26, 260); } break;
      case 'gun':    if (mine) { Sfx.weapon(); syncWeapons(); } break;
      case 'up':     if (mine) Sfx.upgrade(); break;
      case 'deny':   if (mine) Sfx.deny(); break;
      case 'kill':   if (mine) Sfx.kill(); break;
      case 'die':
        burst(ev.x, ev.y, ev.hue, 46, 380);
        if (onMe) { Sfx.die(); endRun(ev.byName); }
        break;
    }
  }
}

function burst(x, y, hue, n, spd) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = Sim.rnd(spd * 0.2, spd);
    state.fx.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
                    r: Sim.rnd(1.5, 4), hue, life: 1, max: Sim.rnd(0.3, 0.7) });
  }
}
function pop(x, y, hue, r) {
  state.fx.push({ x, y, vx: 0, vy: 0, r: r || 6, hue, life: 1, max: 0.25 });
}

// ---------------------------------------------------------------- frame
// One shape for the renderer, whichever mode produced it.
const frame = { tanks: [], bullets: [], shapes: [], orbs: [] };

function buildFrameOnline() {
  const rt = state.time - INTERP_DELAY;
  const s = net.snaps;
  let a = null, b = null;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].at <= rt) { a = s[i]; b = s[i + 1] || null; break; }
  }
  if (!a) { a = s[0]; b = s[1] || null; }
  if (!a) { frame.tanks = frame.bullets = frame.shapes = []; frame.orbs = net.orbs; return; }
  const t = b && b.at > a.at ? clamp((rt - a.at) / (b.at - a.at), 0, 1) : 0;

  // Tanks: interpolate by id between the bracketing snapshots.
  const prev = b ? indexById(a.tanks) : null;
  frame.tanks = (b ? b.tanks : a.tanks).map(row => {
    const [id, x, y, angle, level, hue, hp, maxhp, inv, tierIdx, name, recoil] = row;
    let rx = x, ry = y, ra = angle;
    if (prev) {
      const p = prev[id];
      if (p) {
        rx = lerp(p[1], x, t); ry = lerp(p[2], y, t);
        ra = p[3] + Sim.clamp(((angle - p[3] + Math.PI * 3) % TAU) - Math.PI, -Math.PI, Math.PI) * t;
      }
    }
    const own = id === net.id;
    if (own) { rx = pred.x; ry = pred.y; ra = aimAngle(); }
    return { id, x: rx, y: ry, angle: ra, level, hue, hp, maxhp, invuln: inv,
             tierIdx, name, recoil, own };
  });

  // Bullets carry velocity, so they are dead-reckoned rather than interpolated.
  const src = b || a;
  const age = rt - src.at;
  frame.bullets = src.bullets.map(([x, y, r, hue, vx, vy]) =>
    ({ x: x + vx * age, y: y + vy * age, r, hue }));

  const shPrev = b ? indexById(a.shapes) : null;
  frame.shapes = (b ? b.shapes : a.shapes).map(row => {
    const [id, x, y, r, sides, hue, hp, maxhp, rot] = row;
    let rx = x, ry = y, rr = rot;
    if (shPrev && shPrev[id]) {
      const p = shPrev[id];
      rx = lerp(p[1], x, t); ry = lerp(p[2], y, t);
      rr = p[8] + Sim.clamp(((rot - p[8] + Math.PI * 3) % TAU) - Math.PI, -Math.PI, Math.PI) * t;
    }
    return { x: rx, y: ry, r, sides, hue, hp, maxhp, rot: rr };
  });

  frame.orbs = net.orbs;
}

function indexById(rows) {
  const m = Object.create(null);
  for (const r of rows) m[r[0]] = r;
  return m;
}

function buildFrameLocal() {
  const w = net.offline.world, me = net.offline.me;
  frame.tanks = w.tanks.filter(t => t.alive).map(t => ({
    id: t.id, x: t === me ? pred.x : t.x, y: t === me ? pred.y : t.y,
    angle: t === me ? aimAngle() : t.angle, level: t.level, hue: t.hue,
    hp: t.hp, maxhp: t.maxhp, invuln: t.invuln > 0 ? 1 : 0,
    tierIdx: Sim.unlocked(t).indexOf(Sim.tierOf(t)), name: t.name,
    recoil: t.recoil, own: t === me,
  }));
  frame.bullets = w.bullets;
  frame.shapes = w.shapes.map(s => ({ x: s.x, y: s.y, r: s.r, sides: s.kind.sides,
                                      hue: s.hue, hp: s.hp, maxhp: s.maxhp, rot: s.rot }));
  frame.orbs = w.orbs;
  state.dots = w.tanks.filter(t => t.alive).map(t => [t.x / 25, t.y / 25, t === me ? 1 : 0, t.hue]);
  state.lb = w.leaderboard(6);
  state.pop = { humans: 1, bots: w.tanks.filter(t => t.isBot).length };
  if (me.alive) {
    state.me = {
      x: me.x, y: me.y, hp: me.hp, maxhp: me.maxhp, level: me.level,
      xp: me.xp, need: Sim.xpForLevel(me.level), score: me.score, points: me.points,
      weapon: me.weapon, guns: Sim.unlocked(me).length, skills: me.skills, kills: me.kills,
    };
  }
}

// ---------------------------------------------------------------- input
function inputVector() {
  const k = state.keys;
  let ix = 0, iy = 0;
  if (k.KeyA || k.ArrowLeft) ix--;
  if (k.KeyD || k.ArrowRight) ix++;
  if (k.KeyW || k.ArrowUp) iy--;
  if (k.KeyS || k.ArrowDown) iy++;
  if (state.touch) { ix = state.touch.x; iy = state.touch.y; }
  const l = Math.hypot(ix, iy);
  return l > 1 ? { x: ix / l, y: iy / l } : { x: ix, y: iy };
}

function aimAngle() {
  const w = worldFromScreen(state.mouse.x, state.mouse.y);
  return Math.atan2(w.y - pred.y, w.x - pred.x);
}

function firing() {
  return state.mouse.down || state.autofire || !!state.keys.Space;
}

// Predict own movement with the same numbers the server uses.
function predict(dt) {
  const me = state.me;
  if (!me || !pred.ready) return;
  const v = inputVector();
  const max = Sim.moveSpeed(me.level, me.skills ? me.skills.speed : 0);
  pred.vx += v.x * max * 5.2 * dt;
  pred.vy += v.y * max * 5.2 * dt;
  const fr = Math.pow(Sim.FRICTION, dt * 60);
  pred.vx *= fr; pred.vy *= fr;
  const sp = Math.hypot(pred.vx, pred.vy);
  if (sp > max) { pred.vx = pred.vx / sp * max; pred.vy = pred.vy / sp * max; }
  pred.x = clamp(pred.x + pred.vx * dt, 20, WORLD - 20);
  pred.y = clamp(pred.y + pred.vy * dt, 20, WORLD - 20);
}

function sendInput() {
  const v = inputVector();
  send({ t: 'in', ix: +v.x.toFixed(3), iy: +v.y.toFixed(3), a: +aimAngle().toFixed(3),
         f: firing(), hw: Math.round(VW / 2 / state.cam.zoom), hh: Math.round(VH / 2 / state.cam.zoom) });
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
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, VW, VH);
  ctx.save();
  ctx.translate(VW / 2, VH / 2); ctx.scale(z, z); ctx.translate(-cam.x, -cam.y);

  const halfW = VW / 2 / z, halfH = VH / 2 / z;
  const view = { x0: cam.x - halfW, y0: cam.y - halfH, x1: cam.x + halfW, y1: cam.y + halfH };
  const vis = (e, pad = 0) => e.x + (e.r || 40) + pad > view.x0 && e.x - (e.r || 40) - pad < view.x1
                           && e.y + (e.r || 40) + pad > view.y0 && e.y - (e.r || 40) - pad < view.y1;

  const G = 64;
  ctx.strokeStyle = GRID; ctx.lineWidth = 1 / z; ctx.beginPath();
  for (let x = Math.floor(view.x0 / G) * G; x < view.x1; x += G) { ctx.moveTo(x, view.y0); ctx.lineTo(x, view.y1); }
  for (let y = Math.floor(view.y0 / G) * G; y < view.y1; y += G) { ctx.moveTo(view.x0, y); ctx.lineTo(view.x1, y); }
  ctx.stroke();

  ctx.fillStyle = 'rgba(200,40,60,0.10)';
  if (view.x0 < 0) ctx.fillRect(view.x0, view.y0, -view.x0, view.y1 - view.y0);
  if (view.y0 < 0) ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, -view.y0);
  if (view.x1 > WORLD) ctx.fillRect(WORLD, view.y0, view.x1 - WORLD, view.y1 - view.y0);
  if (view.y1 > WORLD) ctx.fillRect(view.x0, WORLD, view.x1 - view.x0, view.y1 - WORLD);

  for (const o of frame.orbs) {
    if (!vis(o, 10)) continue;
    ctx.fillStyle = `hsl(${o.hue} 80% 62%)`;
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
  }

  for (const s of frame.shapes) {
    if (!vis(s, 10)) continue;
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot);
    ctx.beginPath();
    for (let i = 0; i < s.sides; i++) {
      const a = (i / s.sides) * TAU;
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * s.r, Math.sin(a) * s.r);
    }
    ctx.closePath();
    ctx.fillStyle = `hsl(${s.hue} 72% 55%)`;
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = `hsl(${s.hue} 60% 33%)`; ctx.stroke();
    ctx.restore();
    if (s.hp < s.maxhp) healthBar(s.x, s.y + s.r + 9, s.r * 1.5, s.hp / s.maxhp, 3);
  }

  for (const b of frame.bullets) {
    if (!vis(b, 8)) continue;
    ctx.fillStyle = `hsl(${b.hue} 85% 66%)`;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
    ctx.strokeStyle = `hsl(${b.hue} 70% 40%)`; ctx.lineWidth = 2; ctx.stroke();
  }

  for (const t of frame.tanks) if (vis(t, 60)) drawTank(t);

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
  const r = Sim.radiusOf(t);
  const tier = Sim.TIERS[clamp(t.tierIdx, 0, Sim.TIERS.length - 1)] || Sim.TIERS[0];
  ctx.save(); ctx.translate(t.x, t.y); ctx.rotate(t.angle);
  const back = (t.recoil || 0) * 4;
  for (const b of tier.barrels) {
    const w = r * 0.66 * (b.w ?? 1), len = r * (1.35 + ((b.speed ?? 1) - 1) * 0.45) * (b.size ?? 1);
    ctx.save(); ctx.rotate(b.a);
    ctx.fillStyle = '#9aa3b2'; ctx.strokeStyle = '#6e7684'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.rect(-back, -w / 2, len, w); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU);
  ctx.fillStyle = t.invuln && ((state.time * 10) | 0) % 2 ? '#ffffff' : `hsl(${t.hue} 68% 58%)`;
  ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = `hsl(${t.hue} 55% 34%)`; ctx.stroke();
  ctx.restore();

  ctx.font = '600 15px Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.strokeText(t.name, t.x, t.y - r - 16);
  ctx.fillStyle = t.own ? '#ffffff' : '#dfe6f0';
  ctx.fillText(t.name, t.x, t.y - r - 16);
  ctx.font = '500 11px Segoe UI, system-ui, sans-serif';
  ctx.strokeText(`Lv ${t.level} ${tier.name}`, t.x, t.y - r - 4);
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
  const S = MINI, k = S / (WORLD / 25);
  mctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  mctx.clearRect(0, 0, S, S);
  for (const [x, y, me, hue] of state.dots) {
    mctx.fillStyle = me ? '#57d2ff' : `hsl(${hue} 70% 60%)`;
    mctx.beginPath(); mctx.arc(x * k, y * k, me ? 3.4 : 2, 0, TAU); mctx.fill();
  }
}

// ---------------------------------------------------------------- UI
const el = id => document.getElementById(id);
const ui = {
  name: el('name'), sub: el('sub'), xpfill: el('xpfill'), hpfill: el('hpfill'),
  score: el('score'), lb: el('lb'), up: el('upgrades'), ulist: el('ulist'),
  uhint: el('uhint'), overlay: el('overlay'), card: el('card'), guns: el('guns'),
  link: el('link'), pop: el('pop'),
};

let rows = [];
function buildRows() {
  ui.ulist.innerHTML = '';
  rows = state.skills.map((s, i) => {
    const d = document.createElement('button');
    d.className = 'u'; d.type = 'button';
    d.innerHTML = `<kbd>${i + 1}</kbd><span class="label">${s.label}</span><span class="meter"><i></i></span>`;
    d.onclick = () => spend(s.key);
    ui.ulist.appendChild(d);
    return { el: d, fill: d.querySelector('.meter i'), key: s.key, max: s.max };
  });
  gunChips = [];
}

function spend(key) {
  if (net.offline) net.offline.world.spend(net.offline.me, key);
  else send({ t: 'up', k: key });
}

let gunChips = [];
function syncWeapons() {
  const me = state.me;
  if (!me) return;
  const names = state.tiers.slice(0, me.guns || 1).map(t => t.name);
  if (gunChips.length !== names.length) {
    ui.guns.innerHTML = '';
    gunChips = names.map((nm, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'gun';
      b.innerHTML = `<span>${nm}</span>`;
      b.onclick = () => selectWeapon(i);
      ui.guns.appendChild(b);
      return b;
    });
  }
  ui.guns.classList.toggle('show', names.length > 1);
  gunChips.forEach((b, i) => b.classList.toggle('on', i === me.weapon));
}

function selectWeapon(i) {
  if (net.offline) net.offline.world.selectWeapon(net.offline.me, i);
  else send({ t: 'w', i });
}

function cycleWeapon(d) {
  const me = state.me;
  if (!me || (me.guns || 1) < 2) return;
  selectWeapon(((me.weapon + d) % me.guns + me.guns) % me.guns);
}

function syncUI() {
  const me = state.me;
  if (!me) return;
  ui.name.textContent = state.name;
  const tier = state.tiers[clamp(me.weapon, 0, state.tiers.length - 1)];
  ui.sub.textContent = `Lv ${me.level} · ${tier ? tier.name : ''}`;
  ui.xpfill.style.width = (me.level >= Sim.MAX_LEVEL ? 100 : (me.xp / me.need) * 100) + '%';
  ui.hpfill.style.width = clamp(me.hp / me.maxhp, 0, 1) * 100 + '%';
  ui.score.textContent = Math.floor(me.score).toLocaleString();
  ui.pop.textContent = state.pop.humans > 1
    ? `${state.pop.humans} players · ${state.pop.bots} bots`
    : `${state.pop.bots} bots`;
  ui.up.classList.toggle('show', me.points > 0);
  if (me.points > 0) {
    ui.uhint.textContent = me.points === 1 ? '1 point' : `${me.points} points`;
    for (const r of rows) {
      const n = me.skills ? me.skills[r.key] || 0 : 0;
      r.fill.style.width = (n / r.max) * 100 + '%';
      r.el.disabled = n >= r.max;
    }
  }
  if (gunChips.length !== (me.guns || 1)) syncWeapons();
  else gunChips.forEach((b, i) => b.classList.toggle('on', i === me.weapon));
}

function syncLeaderboard() {
  ui.lb.innerHTML = state.lb.map((t, i) =>
    `<li class="${t.id === net.id ? 'me' : ''}"><b>${i + 1}</b><span>${escapeHtml(t.name)}</span>` +
    `<em>${t.score.toLocaleString()}</em></li>`).join('');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------- run lifecycle
function startRun(name) {
  state.name = name;
  state.fx.length = 0;
  net.snaps.length = 0; net.orbs = [];
  state.me = null; state.lb = []; state.dots = [];
  state.mode = 'playing';
  Sfx.start();
  ui.overlay.classList.add('hidden');

  if (net.ws && net.ws.readyState === 1) { net.offline = null; send({ t: 'join', name }); }
  else if (state.link === 'connecting' || state.link === 'idle') {
    connect(() => {
      if (net.ws && net.ws.readyState === 1) { net.offline = null; send({ t: 'join', name }); }
      else startLocal();
    });
  } else startLocal();
}

function endRun(byName) {
  if (state.mode !== 'playing') return;
  state.mode = 'dead';
  state.killedBy = byName || null;
  const me = state.me || { score: 0, level: 1, kills: 0, weapon: 0 };
  const tier = state.tiers[clamp(me.weapon, 0, state.tiers.length - 1)];
  ui.card.innerHTML = `
    <h1>Rekt<span>.</span></h1>
    <p class="sub">${byName ? 'Taken down by ' + escapeHtml(byName) : 'You were destroyed'}</p>
    <p id="stats">
      Score <b>${Math.floor(me.score).toLocaleString()}</b><br>
      Level <b>${me.level}</b> &middot; ${tier ? tier.name : ''}<br>
      Kills <b>${me.kills || 0}</b>
    </p>
    <button id="again">Play again</button>
    <p class="help">Press <b>Enter</b> to respawn</p>`;
  ui.overlay.classList.remove('hidden');
  el('again').onclick = respawn;
}

function respawn() {
  state.fx.length = 0;
  pred.ready = false;
  if (net.offline) {
    net.offline.world.respawn(net.offline.me);
    enterPlaying();
    return;
  }
  // Online the server decides when we are back, so ask and wait for the tank
  // rather than clearing the screen on optimism.
  state.pendingRespawn = 0;
  send({ t: 'respawn' });
  const btn = el('again');
  if (btn) { btn.disabled = true; btn.textContent = 'Respawning…'; }
}

function enterPlaying() {
  state.mode = 'playing';
  state.pendingRespawn = null;
  ui.overlay.classList.add('hidden');
  Sfx.start();
}

// ---------------------------------------------------------------- input wiring
canvas.addEventListener('mousemove', e => { state.mouse.x = e.clientX; state.mouse.y = e.clientY; });
canvas.addEventListener('mousedown', e => { if (e.button === 0) state.mouse.down = true; });
window.addEventListener('mouseup', () => { state.mouse.down = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  if (state.mode !== 'playing') return;
  e.preventDefault();
  cycleWeapon(e.deltaY > 0 ? 1 : -1);
}, { passive: false });

function touchAim(t) {
  state.mouse.x = t.clientX; state.mouse.y = t.clientY;
  const w = worldFromScreen(t.clientX, t.clientY);
  const d = Math.hypot(w.x - pred.x, w.y - pred.y) || 1;
  state.touch = { x: (w.x - pred.x) / d, y: (w.y - pred.y) / d };
}
canvas.addEventListener('touchstart', e => {
  e.preventDefault(); state.mouse.down = true; touchAim(e.touches[0]);
}, { passive: false });
canvas.addEventListener('touchmove', e => { e.preventDefault(); touchAim(e.touches[0]); }, { passive: false });
canvas.addEventListener('touchend', e => {
  e.preventDefault(); state.mouse.down = false; state.touch = null;
}, { passive: false });

window.addEventListener('keydown', e => {
  state.keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (state.mode !== 'playing') {
    if (e.code === 'Enter') {
      const btn = el('again');
      if (btn) btn.click(); else tryPlay();
    }
    return;
  }
  if (e.code === 'KeyE') state.autofire = !state.autofire;
  if (e.code === 'KeyM') setMuteLabel(Sfx.toggle());
  if (e.code === 'KeyQ' || e.code === 'Tab') { e.preventDefault(); cycleWeapon(e.shiftKey ? -1 : 1); }
  const n = e.code.match(/^Digit([1-9])$/);
  if (n && +n[1] <= state.skills.length) spend(state.skills[+n[1] - 1].key);
});
window.addEventListener('keyup', e => { state.keys[e.code] = false; });
window.addEventListener('blur', () => {
  state.keys = Object.create(null); state.mouse.down = false; state.touch = null;
});

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

// ---------------------------------------------------------------- main loop
let last = performance.now(), inputAcc = 0, lbAcc = 0;

function frameLoop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.time += dt;

  if (state.mode !== 'menu') {
    if (net.offline) {
      const w = net.offline.world, me = net.offline.me;
      const v = inputVector();
      me.ix = v.x; me.iy = v.y;
      me.angle = aimAngle();
      me.fire = firing();
      w.step(dt);
      w.recycleBots();
      handleEvents(w.events, ev => ev.by === me.id, ev => ev.on === me.id);
      w.events.length = 0;
      if (me.alive) { pred.x = me.x; pred.y = me.y; }
      buildFrameLocal();
    } else {
      predict(dt);
      inputAcc += dt;
      if (inputAcc >= 1 / INPUT_HZ) { inputAcc = 0; sendInput(); }
      buildFrameOnline();
    }

    // Camera and the zoom that makes the arena open up as you grow.
    const lvl = state.me ? state.me.level : 1;
    state.cam.x = lerp(state.cam.x, pred.x, 1 - Math.pow(0.0001, dt));
    state.cam.y = lerp(state.cam.y, pred.y, 1 - Math.pow(0.0001, dt));
    const want = clamp(1.05 - Math.pow(lvl, 0.55) * 0.055, 0.42, 1.05);
    state.cam.zoom = lerp(state.cam.zoom, want, 1 - Math.pow(0.05, dt));
    Sfx.listener(state.cam.x, state.cam.y, state.cam.zoom);

    // Pull nearby orbs in visually between server updates so collection reads
    // as smooth rather than stepping at the orb update rate.
    if (!net.offline && state.mode === 'playing') {
      for (const o of frame.orbs) {
        const dx = pred.x - o.x, dy = pred.y - o.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < Sim.MAGNET * Sim.MAGNET) {
          const d = Math.sqrt(d2) || 1;
          o.x += dx / d * Sim.MAGNET_PULL * dt; o.y += dy / d * Sim.MAGNET_PULL * dt;
        }
      }
    }

    if (state.mode === 'dead' && state.pendingRespawn !== null) {
      state.pendingRespawn += dt;
      if (state.pendingRespawn > 0.5) { state.pendingRespawn = 0; send({ t: 'respawn' }); }
    }
    syncUI();
    lbAcc += dt;
    if (lbAcc >= 0.3) { lbAcc = 0; syncLeaderboard(); }
  }

  for (let i = state.fx.length - 1; i >= 0; i--) {
    const f = state.fx[i];
    f.x += f.vx * dt; f.y += f.vy * dt;
    f.vx *= Math.pow(0.05, dt); f.vy *= Math.pow(0.05, dt);
    f.life -= dt / f.max;
    if (f.life <= 0) { state.fx[i] = state.fx[state.fx.length - 1]; state.fx.pop(); }
  }

  draw();
  requestAnimationFrame(frameLoop);
}

resize();
buildRows();
el('play').onclick = tryPlay;
el('nick').addEventListener('input', () => { el('nameerr').textContent = ''; });
el('mute').onclick = () => { Sfx.init(); setMuteLabel(Sfx.toggle()); };
connect();                       // warm the socket so the menu can show the count
requestAnimationFrame(frameLoop);
})();
