/* Rep.io server — static files plus an authoritative WebSocket game server.
   One process serves both, which is what Render's single-port model wants. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Sim = require('../src/sim.js');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

const TICK = 1 / 30;          // simulation steps per second
const SNAP_HZ = 20;           // entity snapshots per client per second
const ORB_HZ = 6;             // orbs change slowly, so they go out less often
const ROOM_CAP = 16;          // humans per room
const MIN_POP = 10;           // never leave an arena emptier than this

// Bots backfill toward roughly 35% bots / 65% humans. Below about nine humans
// that ratio alone would leave a near-empty arena, so MIN_POP wins there.
function targetBots(humans) {
  return Sim.clamp(Math.max(MIN_POP - humans, Math.round(humans * 0.538)), 0, 24);
}

// ---------------------------------------------------------------- static files
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const SERVE = new Set(['/index.html', '/style.css', '/src/game.js', '/src/audio.js', '/src/sim.js']);

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/healthz') { res.writeHead(200).end('ok'); return; }
  if (!SERVE.has(url)) { res.writeHead(404).end('not found'); return; }
  fs.readFile(path.join(ROOT, url), (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(url)] || 'application/octet-stream',
      'Cache-Control': url === '/index.html' ? 'no-cache' : 'public, max-age=300',
    }).end(buf);
  });
});

// ---------------------------------------------------------------- rooms
let roomSeq = 1;

class Room {
  constructor() {
    this.id = 'r' + roomSeq++;
    this.world = new Sim.World();
    this.clients = new Set();
    this.acc = 0; this.snapAcc = 0; this.orbAcc = 0; this.lbAcc = 0;
    this.lbCache = [];
    this.last = Date.now();
    this.topUpBots();
  }

  get humans() { return this.clients.size; }

  topUpBots() {
    const want = targetBots(this.humans);
    const bots = this.world.tanks.filter(t => t.isBot);
    for (let i = bots.length; i < want; i++) this.world.addBot();
    for (let i = bots.length - 1; i >= want; i--) this.world.removeTank(bots[i]);
  }

  join(client) {
    this.clients.add(client);
    client.room = this;
    client.tank = this.world.addTank({ name: client.name });
    this.topUpBots();
    client.send({
      t: 'welcome', id: client.tank.id, world: Sim.WORLD, room: this.id,
      tiers: Sim.TIERS.map(x => ({ level: x.level, name: x.name })),
      skills: Sim.SKILLS,
    });
  }

  leave(client) {
    this.clients.delete(client);
    if (client.tank) this.world.removeTank(client.tank);
    client.room = null; client.tank = null;
    this.topUpBots();
  }

  tick() {
    const now = Date.now();
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.5) dt = 0.5;                 // never simulate a huge catch-up jump
    this.acc += dt;

    let steps = 0;
    while (this.acc >= TICK && steps < 6) { this.world.step(TICK); this.acc -= TICK; steps++; }
    if (steps === 0) return;

    this.world.recycleBots();

    // Pending respawns, once the brief re-entry delay has passed.
    for (const c of this.clients) {
      const t = c.tank;
      if (t && !t.alive && t.wantRespawn && this.world.time - (t.diedAt || 0) >= 0.5) {
        t.wantRespawn = false;
        this.world.respawn(t);
      }
    }

    // Route events to the clients that should hear them.
    for (const c of this.clients) c.pending.length = 0;
    for (const ev of this.world.events) {
      for (const c of this.clients) {
        if (!c.tank) continue;
        const mine = ev.by === c.tank.id, onMe = ev.on === c.tank.id;
        if (ev.x !== undefined) {
          const dx = ev.x - c.tank.x, dy = ev.y - c.tank.y;
          if (dx * dx + dy * dy > 1900 * 1900 && !mine && !onMe) continue;
        } else if (!mine && !onMe) continue;
        c.pending.push(mine ? Object.assign({ m: 1 }, ev) : ev);
      }
    }
    this.world.events.length = 0;

    this.snapAcc += dt; this.orbAcc += dt; this.lbAcc += dt;
    const sendSnap = this.snapAcc >= 1 / SNAP_HZ;
    const sendOrbs = this.orbAcc >= 1 / ORB_HZ;
    const sendLb = this.lbAcc >= 0.5;
    if (sendSnap) this.snapAcc = 0;
    if (sendOrbs) this.orbAcc = 0;
    if (sendLb) { this.lbAcc = 0; this.lbCache = this.world.leaderboard(6); }

    for (const c of this.clients) {
      const t = c.tank;
      if (!t) continue;
      if (sendSnap) {
        const snap = this.world.snapshotFor(t, c.halfW, c.halfH);
        snap.t = 's';
        snap.me = t.alive ? {
          x: Math.round(t.x), y: Math.round(t.y),
          vx: Math.round(t.vx), vy: Math.round(t.vy), hp: Math.round(t.hp),
          maxhp: Math.round(t.maxhp), level: t.level, xp: Math.round(t.xp),
          need: Sim.xpForLevel(t.level), score: Math.floor(t.score),
          points: t.points, weapon: t.weapon, guns: Sim.unlocked(t).length,
          skills: t.skills, kills: t.kills, invuln: +t.invuln.toFixed(2),
        } : null;
        snap.pop = { humans: this.humans, bots: this.world.tanks.filter(x => x.isBot).length };
        if (c.pending.length) snap.ev = c.pending.slice(0, 40);
        if (sendLb) snap.lb = this.lbCache;
        c.send(snap);
      }
      if (sendOrbs && t.alive) c.send({ t: 'o', o: this.world.orbsFor(t, c.halfW, c.halfH) });
    }
  }
}

const rooms = [];

function totalHumans() { return rooms.reduce((n, r) => n + r.humans, 0); }

// Put a new player in the busiest room that still has space, so two or nine
// people online end up in the same arena rather than three empty ones.
function pickRoom() {
  let best = null;
  for (const r of rooms) {
    if (r.humans >= ROOM_CAP) continue;
    if (!best || r.humans > best.humans) best = r;
  }
  if (!best) { best = new Room(); rooms.push(best); }
  return best;
}

// ---------------------------------------------------------------- sockets
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

const CTRL = /[\x00-\x1f\x7f]/g;   // strip control characters from names
function cleanName(raw) {
  const s = String(raw == null ? '' : raw).replace(CTRL, '').trim().slice(0, 17);
  return s.length >= 2 ? s : 'anon';
}

wss.on('connection', ws => {
  const client = {
    ws, room: null, tank: null, name: 'anon', pending: [],
    halfW: 700, halfH: 420,
    send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
  };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  client.send({ t: 'hello', online: totalHumans(), rooms: rooms.length });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const w = client.room && client.room.world;
    const t = client.tank;

    switch (msg.t) {
      case 'join':
        client.name = cleanName(msg.name);
        if (client.room) client.room.leave(client);
        pickRoom().join(client);
        break;

      case 'in': {                         // movement, aim and trigger
        if (!t || !t.alive) return;
        const ix = +msg.ix || 0, iy = +msg.iy || 0;
        const len = Math.hypot(ix, iy);
        t.ix = len > 1 ? ix / len : ix;
        t.iy = len > 1 ? iy / len : iy;
        if (Number.isFinite(+msg.a)) t.angle = +msg.a;
        t.fire = !!msg.f;
        if (Number.isFinite(+msg.hw)) client.halfW = Sim.clamp(+msg.hw, 200, 1800);
        if (Number.isFinite(+msg.hh)) client.halfH = Sim.clamp(+msg.hh, 200, 1400);
        break;
      }

      case 'up': if (t && w) w.spend(t, String(msg.k)); break;
      case 'w':  if (t && w) w.selectWeapon(t, +msg.i | 0); break;

      case 'respawn':
        if (!t || t.alive || !w) return;
        // Honour it now, or remember it: dropping an early request would leave
        // the player stuck on the death screen with nothing to retry.
        if (w.time - (t.diedAt || 0) < 0.5) t.wantRespawn = true;
        else w.respawn(t);
        break;

      case 'ping': client.send({ t: 'pong', n: msg.n }); break;
    }
  });

  const bye = () => { if (client.room) client.room.leave(client); };
  ws.on('close', bye);
  ws.on('error', bye);
});

// Drop sockets that stop answering, so rooms do not fill with ghosts.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

// ---------------------------------------------------------------- loop
setInterval(() => {
  for (const r of rooms) r.tick();
  // Retire empty rooms, always keeping one warm for the next visitor.
  for (let i = rooms.length - 1; i >= 0; i--) {
    if (rooms[i].humans === 0 && rooms.length > 1) rooms.splice(i, 1);
  }
}, 1000 / 30);

server.listen(PORT, () => {
  console.log('Rep.io listening on :' + PORT);
});
