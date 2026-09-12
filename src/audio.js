/* Rep.io audio — everything is synthesised at runtime, so there are no
   asset loads and no CSP-blocked media requests.

   Design notes:
   - One master chain: voices -> compressor -> destination, plus a short
     procedural convolution reverb on a send so the arena has some space.
   - Voices are positioned: panned by screen offset and attenuated by
     distance from the camera, so a firefight across the map reads as
     distant rather than as clipping mush.
   - Every emitter type has a minimum retrigger interval. With a dozen
     bots firing, un-throttled one-shots turn into noise and eat CPU. */
window.Sfx = (() => {
  'use strict';

  let ctx = null, master = null, wet = null, noise = null;
  let muted = false, ready = false;
  const listener = { x: 0, y: 0, zoom: 1 };
  const last = Object.create(null);
  const AUDIBLE = 1500;           // world units past which a sound is dropped
  const PENTA = [0, 2, 4, 7, 9];  // pickup blips walk a pentatonic scale

  const now = () => ctx.currentTime;
  const note = n => 440 * Math.pow(2, n / 12);

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 12;
    comp.ratio.value = 7; comp.attack.value = 0.003; comp.release.value = 0.18;
    comp.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(comp);

    // Reusable white noise — one buffer for every noise voice in the game.
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // Small procedural room: exponentially decaying stereo noise tail.
    const len = Math.floor(ctx.sampleRate * 1.1);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * (1 - t * 0.3);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass'; damp.frequency.value = 2600;
    wet = ctx.createGain(); wet.gain.value = 0.16;
    wet.connect(damp); damp.connect(conv); conv.connect(master);
    ready = true;
  }

  // Per-voice output stage: pan + distance gain, dry to master, tail to reverb.
  function out(x, y, gain, send = 0.5) {
    const g = ctx.createGain();
    const pan = ctx.createStereoPanner();
    let vol = gain;
    if (x !== undefined) {
      const dx = x - listener.x, dy = y - listener.y;
      const d = Math.hypot(dx, dy);
      vol *= Math.max(0, 1 - d / AUDIBLE) ** 1.6;
      pan.pan.value = Math.max(-0.85, Math.min(0.85, (dx / 900)));
    }
    g.gain.value = vol;
    g.connect(pan); pan.connect(master);
    if (send > 0) { const s = ctx.createGain(); s.gain.value = send; pan.connect(s); s.connect(wet); }
    return { node: g, vol };
  }

  function gate(key, interval, x, y) {
    if (!ready || muted) return false;
    if (x !== undefined && Math.hypot(x - listener.x, y - listener.y) > AUDIBLE) return false;
    const t = now();
    if (last[key] !== undefined && t - last[key] < interval) return false;
    last[key] = t;
    return true;
  }

  function noiseVoice(dur, type, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    src.connect(f);
    src.start(now(), Math.random() * 1.5);
    src.stop(now() + dur + 0.05);
    return { src, f };
  }

  function tone(type, f0, f1, dur, t0) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.02);
    return o;
  }

  function env(g, t0, peak, attack, dur, curve = 0.0008) {
    g.gain.cancelScheduledValues(t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(Math.max(0.00001, peak * curve), t0 + dur);
  }

  const api = {
    init,
    get muted() { return muted; },
    listener(x, y, zoom) { listener.x = x; listener.y = y; listener.zoom = zoom; },
    toggle() {
      muted = !muted;
      if (ready) master.gain.setTargetAtTime(muted ? 0 : 0.85, now(), 0.02);
      return muted;
    },

    // Muzzle report: body thump plus a filtered crack. Bigger barrels sit lower.
    shoot(x, y, size = 1, mine = false) {
      if (!gate('shoot' + (mine ? 'P' : 'B'), mine ? 0.02 : 0.05, x, y)) return;
      const t0 = now(), pitch = 1 / Math.max(0.55, size);
      const o = out(x, y, (mine ? 0.3 : 0.16), 0.35);
      const body = ctx.createGain();
      tone('triangle', 220 * pitch, 70 * pitch, 0.1, t0).connect(body);
      env(body, t0, 1, 0.002, 0.11);
      body.connect(o.node);
      const { f } = noiseVoice(0.09, 'bandpass', 1500 * pitch, 1.1);
      const crack = ctx.createGain();
      f.connect(crack); env(crack, t0, 0.55, 0.001, 0.085);
      crack.connect(o.node);
    },

    // Bullet landing on a tank: tight click with a short metallic ring.
    hit(x, y, mine = false) {
      if (!gate('hit', 0.035, x, y)) return;
      const t0 = now();
      const o = out(x, y, mine ? 0.3 : 0.2, 0.4);
      const { f } = noiseVoice(0.07, 'bandpass', 2600, 2);
      const g = ctx.createGain(); f.connect(g); env(g, t0, 0.8, 0.001, 0.06); g.connect(o.node);
      const r = ctx.createGain();
      tone('square', 520, 300, 0.09, t0).connect(r);
      env(r, t0, 0.22, 0.002, 0.085); r.connect(o.node);
    },

    // Orb pickup: quiet blip that walks up the scale while you keep collecting.
    pickup(x, y) {
      if (!gate('pickup', 0.028, x, y)) return;
      const t0 = now();
      if (t0 - (api._streakAt || 0) > 0.55) api._streak = 0;
      api._streakAt = t0;
      api._streak = ((api._streak || 0) + 1) % 15;
      const s = api._streak;
      const n = PENTA[s % 5] + 12 * Math.floor(s / 5) + 12;
      const o = out(x, y, 0.085, 0.45);
      const g = ctx.createGain();
      tone('sine', note(n), note(n + 0.2), 0.13, t0).connect(g);
      tone('triangle', note(n + 12), note(n + 12), 0.07, t0).connect(g);
      env(g, t0, 0.7, 0.004, 0.13);
      g.connect(o.node);
    },

    // Shape destroyed: shattering noise plus a detuned stab, heavier for big shapes.
    shapeBreak(x, y, big = 0) {
      if (!gate('break', 0.05, x, y)) return;
      const t0 = now(), dur = 0.24 + big * 0.25;
      const o = out(x, y, 0.26 + big * 0.12, 0.6);
      const { f } = noiseVoice(dur, 'highpass', 900 - big * 500);
      const g = ctx.createGain(); f.connect(g);
      env(g, t0, 0.7, 0.003, dur); g.connect(o.node);
      f.frequency.exponentialRampToValueAtTime(Math.max(120, 220 - big * 100), t0 + dur);
      const stab = ctx.createGain();
      const base = 150 - big * 55;
      tone('sawtooth', base, base * 0.55, dur * 0.8, t0).connect(stab);
      tone('sawtooth', base * 1.01, base * 0.56, dur * 0.8, t0).connect(stab);
      env(stab, t0, 0.3, 0.004, dur * 0.8); stab.connect(o.node);
    },

    // Taking damage: dull low thud, no pitch, so it never competes with music-ish cues.
    hurt() {
      if (!gate('hurt', 0.13)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.34, 0.2);
      const g = ctx.createGain();
      tone('sine', 150, 52, 0.18, t0).connect(g);
      env(g, t0, 1, 0.002, 0.19); g.connect(o.node);
      const { f } = noiseVoice(0.1, 'lowpass', 420);
      const n = ctx.createGain(); f.connect(n); env(n, t0, 0.3, 0.002, 0.1); n.connect(o.node);
    },

    // Level up: quick major arpeggio, the one cue allowed to be bright.
    levelUp() {
      if (!gate('level', 0.1)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.3, 0.7);
      [0, 4, 7, 12].forEach((n, i) => {
        const t = t0 + i * 0.055;
        const g = ctx.createGain();
        tone('triangle', note(n), note(n), 0.3, t).connect(g);
        tone('sine', note(n + 12), note(n + 12), 0.3, t).connect(g);
        env(g, t, 0.5 - i * 0.06, 0.005, 0.3);
        g.connect(o.node);
      });
    },

    // Kill confirm: two-note rise, short and dry so it cuts through a fight.
    kill() {
      if (!gate('kill', 0.08)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.36, 0.35);
      [[0, 0], [7, 0.07]].forEach(([n, dt]) => {
        const t = t0 + dt, g = ctx.createGain();
        tone('square', note(n - 12), note(n - 12), 0.12, t).connect(g);
        env(g, t, 0.45, 0.003, 0.13); g.connect(o.node);
      });
    },

    // Death: the long one. Falling saw, filter closing, noise wash.
    die() {
      if (!gate('die', 0.5)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.5, 0.9);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2200, t0);
      lp.frequency.exponentialRampToValueAtTime(180, t0 + 1.1);
      const g = ctx.createGain();
      tone('sawtooth', 330, 42, 1.2, t0).connect(lp);
      tone('sawtooth', 331.5, 42.4, 1.2, t0).connect(lp);
      lp.connect(g); env(g, t0, 0.6, 0.01, 1.2); g.connect(o.node);
      const { f } = noiseVoice(0.9, 'lowpass', 900);
      const n = ctx.createGain(); f.connect(n); env(n, t0, 0.25, 0.02, 0.9); n.connect(o.node);
    },

    // UI: spend a point.
    upgrade() {
      if (!gate('ui', 0.03)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.24, 0.3);
      const g = ctx.createGain();
      tone('sine', note(12), note(19), 0.09, t0).connect(g);
      env(g, t0, 0.7, 0.002, 0.09); g.connect(o.node);
    },

    // Shot stopped by a spawn shield: glassy ping, clearly not a flesh hit.
    shield(x, y) {
      if (!gate('shield', 0.05, x, y)) return;
      const t0 = now();
      const o = out(x, y, 0.22, 0.8);
      const g = ctx.createGain();
      tone('sine', 1250, 1150, 0.22, t0).connect(g);
      tone('sine', 1870, 1740, 0.22, t0).connect(g);
      env(g, t0, 0.5, 0.002, 0.22);
      g.connect(o.node);
    },

    // Weapon swap: mechanical two-stage clunk, no pitch content.
    weapon() {
      if (!gate('weapon', 0.06)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.3, 0.25);
      const a1 = noiseVoice(0.05, 'bandpass', 1800, 3);
      const g1 = ctx.createGain(); a1.f.connect(g1); env(g1, t0, 0.5, 0.001, 0.05); g1.connect(o.node);
      const a2 = noiseVoice(0.07, 'bandpass', 700, 4);
      const g2 = ctx.createGain(); a2.f.connect(g2); env(g2, t0 + 0.045, 0.6, 0.001, 0.075); g2.connect(o.node);
      const th = ctx.createGain();
      tone('sine', 180, 90, 0.1, t0 + 0.04).connect(th);
      env(th, t0 + 0.04, 0.4, 0.002, 0.1); th.connect(o.node);
    },

    // UI: rejected input (bad nickname, no points left).
    deny() {
      if (!gate('ui', 0.05)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.24, 0.2);
      const g = ctx.createGain();
      tone('square', 190, 120, 0.12, t0).connect(g);
      env(g, t0, 0.35, 0.003, 0.12); g.connect(o.node);
    },

    // Round start: soft swell so the world doesn't open in silence.
    start() {
      init();
      if (!gate('start', 0.5)) return;
      const t0 = now();
      const o = out(undefined, undefined, 0.3, 0.8);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(200, t0);
      lp.frequency.exponentialRampToValueAtTime(2400, t0 + 0.5);
      const g = ctx.createGain();
      tone('sawtooth', note(-24), note(-12), 0.7, t0).connect(lp);
      lp.connect(g); env(g, t0, 0.5, 0.25, 0.75); g.connect(o.node);
    },
  };
  return api;
})();
