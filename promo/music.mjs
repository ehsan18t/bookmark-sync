// Synthesizes the promo soundtrack and sound effects into promo/music.wav. Event times mirror video.html.
import { writeFileSync } from 'node:fs';

const SR = 48000, LEN = 40, N = SR * LEN;
const BEAT = 0.5, BAR = BEAT * 4;
let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const noise = () => rnd() * 2 - 1;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, x) => a + (b - a) * clamp01(x);

const bus = () => [new Float32Array(N), new Float32Array(N)];
const dry = bus(), ducked = bus(), revSend = bus(), dlySend = bus();

function play(start, len, gen, sends) {
  const s0 = Math.round(start * SR), i0 = Math.max(0, s0), i1 = Math.min(N, Math.round((start + len) * SR));
  const g = sends.map(([b, gain, pan = 0]) => [b, gain * Math.cos(((pan + 1) * Math.PI) / 4), gain * Math.sin(((pan + 1) * Math.PI) / 4)]);
  for (let i = i0; i < i1; i++) {
    const v = gen((i - s0) / SR);
    for (const [b, l, r] of g) { b[0][i] += v * l; b[1][i] += v * r; }
  }
}

// Topology-preserving state-variable filter; returns low-pass, sets .bp and .hp.
function svf() {
  let ic1 = 0, ic2 = 0;
  const f = (x, fc, q = 0.707) => {
    const g = Math.tan((Math.PI * Math.min(fc, SR * 0.45)) / SR), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    f.bp = v1; f.hp = x - k * v1 - v2;
    return v2;
  };
  return f;
}
// PolyBLEP saw: a naive saw aliases audibly in the upper octaves.
function saw() {
  let ph = rnd();
  return (f) => {
    const dt = f / SR;
    ph += dt; if (ph >= 1) ph -= 1;
    let v = 2 * ph - 1;
    if (ph < dt) { const t = ph / dt; v -= t + t - t * t - 1; }
    else if (ph > 1 - dt) { const t = (ph - 1) / dt; v -= t * t + t + t + 1; }
    return v;
  };
}
const adsr = (t, gate, a, d, s, r) => {
  let e = t < a ? t / a : t < a + d ? 1 - ((1 - s) * (t - a)) / d : s;
  if (t > gate) e *= Math.max(0, 1 - (t - gate) / r);
  return e;
};

const CHORDS = { Am: [57, 60, 64], F: [53, 57, 60], C: [55, 60, 64], G: [55, 59, 62] };
const ROOTS = { Am: 33, F: 29, C: 36, G: 31 };
const chordAt = (bar) => (bar >= 18 ? 'C' : ['Am', 'F', 'C', 'G'][bar % 4]);
const inAny = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);
const GROOVE = [[12, 21], [28, 36.6]];

const padCut = (t) => (t < 5.3 ? lerp(450, 1800, t / 5.3) : t < 21 ? 1800 : t < 28 ? 2600 : t < 37 ? 2000 : lerp(2000, 700, (t - 37) / 3));
for (let bar = 0; bar < 19; bar++) {
  const name = chordAt(bar), notes = [...CHORDS[name], CHORDS[name][0] + 12];
  const start = bar * BAR, gate = bar === 18 ? 4 : BAR;
  for (const m of notes) {
    [-7, 0, 7].forEach((cents, j) => {
      const osc = saw(), lp = svf(), f = mtof(m) * 2 ** (cents / 1200);
      const a = bar === 0 ? 1.8 : 0.25;
      play(start, gate + 0.9, (t) => lp(osc(f), padCut(start + t) * (1 + 0.15 * Math.sin(2 * Math.PI * 0.2 * (start + t) + j))) * adsr(t, gate, a, 0.01, 1, 0.9), [[ducked, 0.03, (j - 1) * 0.65], [revSend, 0.012, (j - 1) * 0.65]]);
    });
  }
}

const arpBright = (t) => (t < 5.3 ? lerp(500, 2600, t / 5.3) : t < 21 ? 3200 : t < 28 ? 2400 : 4200);
const arpGain = (t) => (t < 5.3 ? lerp(0.2, 1, t / 5.3) : t < 21 ? 1 : t < 26 ? 0.8 : 1);
const PATTERN = [0, 1, 2, 3, 4, 3, 2, 1];
for (let s = 0; s * BEAT / 4 < 37; s++) {
  const t0 = (s * BEAT) / 4, chord = CHORDS[chordAt(Math.floor(t0 / BAR))];
  const tones = [...chord.map((m) => m + 12), ...chord.map((m) => m + 24)];
  const m = tones[PATTERN[s % 8]], f = mtof(m);
  const o1 = saw(), o2 = saw(), lp = svf(), bright = arpBright(t0), g = arpGain(t0) * (s % 4 === 0 ? 1 : 0.75);
  play(t0, 0.6, (t) => lp(o1(f * 1.003) + o2(f * 0.997), 250 + bright * Math.exp(-t / 0.07), 1.3) * Math.exp(-t / 0.16) * g, [[ducked, 0.05, s % 2 ? 0.35 : -0.35], [dlySend, 0.03], [revSend, 0.012]]);
}

const MOTIF = {
  Am: [[0, 76, 0.75], [0.75, 74, 0.75], [1.5, 72, 1.5], [3, 74, 1]],
  F: [[0, 72, 0.75], [0.75, 72, 0.75], [1.5, 69, 1], [2.5, 72, 1.5]],
  C: [[0, 76, 0.75], [0.75, 79, 0.75], [1.5, 76, 1], [2.5, 72, 1.5]],
  G: [[0, 74, 0.75], [0.75, 71, 0.75], [1.5, 74, 1], [2.5, 79, 1.5]],
};
function bell(start, m, gate, gain, sends = [[dry, 1], [dlySend, 0.4], [revSend, 0.5]], ratio = 2, index = 2) {
  const f = mtof(m);
  play(start, gate + 1.2, (t) => {
    const mod = index * Math.exp(-t / 0.25) * Math.sin(2 * Math.PI * f * ratio * t);
    return (Math.sin(2 * Math.PI * f * t + mod) + 0.25 * Math.sin(4 * Math.PI * f * t)) * adsr(t, gate, 0.004, 0.35, 0.45, 0.6) * gain;
  }, sends);
}
for (let bar = 14; bar < 18; bar++) for (const [b, m, d] of MOTIF[chordAt(bar)]) bell(bar * BAR + b * BEAT, m, d * BEAT, 0.07);
for (const [b, m, d] of MOTIF.C) bell(37 + b * BEAT * 1.5, m, d * BEAT * 1.5, 0.045);

for (let bar = 3; bar < 18; bar++) {
  const name = chordAt(bar), f = mtof(ROOTS[name]), start = bar * BAR;
  if (start >= 21 && start < 28) continue;
  const voice = (t0, gate, g) => {
    const o = saw(), lp = svf();
    play(t0, gate + 0.15, (t) => (Math.sin(2 * Math.PI * f * t) * 0.9 + lp(o(f * 2), 380) * 0.5) * adsr(t, gate, 0.005, 0.1, 0.8, 0.08) * g, [[ducked, 0.2]]);
  };
  if (inAny(start, GROOVE)) for (let e = 0; e < 8; e++) voice(start + e * BEAT / 2, BEAT / 2 - 0.03, e % 2 ? 1 : 0.8);
  else voice(start, BAR - 0.05, 0.8);
}
bass808(37, mtof(36), 3);
function bass808(t0, f, len) { play(t0, len, (t) => Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 1.2) * 0.5, [[dry, 1]]); }

const kicks = [];
for (let t = 8; t < 21 - 0.01; t += BEAT) kicks.push(t);
for (let t = 28; t < 36.6; t += BEAT) kicks.push(t);
for (const k of kicks) {
  let ph = 0;
  play(k, 0.45, (t) => {
    ph += (2 * Math.PI * (45 + 120 * Math.exp(-t / 0.03))) / SR;
    return Math.sin(ph) * Math.exp(-t / 0.3) + (t < 0.003 ? noise() * 0.4 : 0);
  }, [[dry, k < 12 ? 0.5 : 0.75]]);
}
function clap(t0, g) {
  const bp = svf();
  play(t0, 0.35, (t) => {
    const env = t < 0.03 ? Math.exp(-((t % 0.01) / 0.003)) : Math.exp(-(t - 0.03) / 0.12);
    bp(noise(), 1400, 1.4);
    return bp.bp * env * g;
  }, [[dry, 0.9], [revSend, 0.25]]);
}
function snare(t0, g, tone = 200) {
  const hp = svf();
  play(t0, 0.25, (t) => {
    hp(noise(), 1800);
    return (hp.hp * 0.7 + Math.sin(2 * Math.PI * tone * t) * 0.5) * Math.exp(-t / 0.08) * g;
  }, [[dry, 0.5], [revSend, 0.2]]);
}
function hat(t0, g, decay = 0.03, pan = 0.25) {
  const f = svf();
  play(t0, decay * 6, (t) => { f(noise(), 7500, 0.9); return f.hp * Math.exp(-t / decay) * g; }, [[dry, 0.35, pan]]);
}
for (let t = 12; t < 36.6; t += BEAT) {
  const beat = Math.round(t / BEAT);
  if (inAny(t, GROOVE) && beat % 2 === 1) clap(t, 0.9);
}
for (let s = 0; s * 0.125 < 36.6; s++) {
  const t = s * 0.125;
  if (inAny(t, [[10, 21], ...GROOVE])) { if (s % 4 === 2) hat(t, 0.9, 0.05); else if (t >= 12) hat(t, 0.35, 0.02, -0.25); }
  else if (t >= 22 && t < 26) hat(t, s % 2 ? 0.15 : 0.25, 0.02, -0.2);
}
const roll = (from, to) => {
  for (let t = from; t < to - 0.01; t += t < (from + to) / 2 ? 0.25 : 0.125) snare(t, lerp(0.25, 0.9, (t - from) / (to - from)), lerp(180, 320, (t - from) / (to - from)));
};
roll(10, 12);
roll(26.5, 28);

function crash(t0, g = 1) {
  const f = svf();
  play(t0, 2.5, (t) => { f(noise(), 5000, 0.6); return f.hp * Math.exp(-t / 0.9) * g; }, [[dry, 0.22], [revSend, 0.15]]);
}
function riser(from, to, g = 1) {
  const f = svf();
  play(from, to - from, (t) => {
    const x = t / (to - from);
    f(noise(), 300 * 30 ** x, 2.2);
    return f.bp * x * x * g * (x > 0.985 ? (1 - x) / 0.015 : 1);
  }, [[dry, 0.5], [revSend, 0.25]]);
}
function impactSfx(t0, g = 1) {
  let ph = 0;
  const lp = svf();
  play(t0, 2.4, (t) => {
    ph += (2 * Math.PI * (28 + 50 * Math.exp(-t / 0.12))) / SR;
    return (Math.sin(ph) * Math.exp(-t / 0.9) + lp(noise(), 900) * Math.exp(-t / 0.25) * 0.8) * g;
  }, [[dry, 0.8], [revSend, 0.35]]);
}
function whoosh(t0, len = 0.6, g = 1) {
  const f = svf();
  play(t0, len, (t) => {
    const x = t / len;
    f(noise(), 500 + 3500 * Math.sin(Math.PI * x) ** 2, 1.5);
    return f.bp * Math.sin(Math.PI * x) ** 2 * g;
  }, [[dry, 0.55, -0.6], [dry, 0.55, 0.6], [revSend, 0.15]]);
}
function pop(t0) {
  let ph = 0;
  play(t0, 0.12, (t) => { ph += (2 * Math.PI * (500 + 900 * Math.exp(-t / 0.02))) / SR; return Math.sin(ph) * Math.exp(-t / 0.04) * 0.3; }, [[dry, 1], [revSend, 0.1]]);
}
function click(t0) {
  const f = svf();
  play(t0, 0.05, (t) => { f(noise(), 3000); return (f.hp * Math.exp(-t / 0.003) + Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t / 0.008) * 0.5) * 0.5; }, [[dry, 1], [revSend, 0.05]]);
}
function blip(t0, f) { play(t0, 0.07, (t) => Math.sign(Math.sin(2 * Math.PI * f * t)) * Math.exp(-t / 0.02) * 0.05, [[dry, 1, rnd() - 0.5], [dlySend, 0.3]]); }
const ping = (t0, m, g = 0.05) => bell(t0, m, 0.1, g, [[dry, 1, rnd() * 0.8 - 0.4], [revSend, 0.6], [dlySend, 0.25]], 3.5, 1.5);

riser(3.3, 5.3, 0.9); impactSfx(5.3, 1); crash(5.3, 0.7);
whoosh(4.6, 1.3, 0.7);
[72, 76, 79, 84, 88].forEach((m, i) => ping(8.6 + i * 0.09, m, 0.03));
riser(10, 12, 0.6); crash(12, 1);
[84, 88, 91, 93, 96].forEach((m, i) => ping(10.2 + i * 0.04, m));
pop(12.9); ping(13.15, 88);
[84, 88, 91, 93].forEach((m, i) => ping(14.95 + i * 0.05, m));
pop(15.9); pop(15.95); ping(16.15, 91); ping(16.2, 93);
bell(17.25, 67, 0.4, 0.05, [[dry, 1], [revSend, 0.6]], 1.5, 3);
[84, 88, 91, 93, 96].forEach((m, i) => ping(18.15 + i * 0.04, m));
[84, 88, 91, 96, 100].forEach((m, i) => ping(19.05 + i * 0.09, m, 0.04));
crash(21, 0.5); whoosh(20.8, 0.9, 0.5);
[0, 1, 2, 3, 4, 5, 6].forEach((i) => pop(21.5 + i * 0.11));
whoosh(23.5, 0.8, 0.5);
click(24.8); click(24.86); bass808(24.8, 70, 0.4);
bell(25.05, 79, 0.6, 0.05); bell(25.05, 86, 0.6, 0.035);
for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) blip(25.3 + i * 0.11 + j * 0.03, 1200 + rnd() * 2400);
riser(26, 28, 1); whoosh(26.5, 0.9, 0.9);
impactSfx(28, 0.8); crash(28, 1);
for (const t of [29.55, 31.9, 34.25]) whoosh(t - 0.1, 0.6, 0.35);
for (const t of [28.76, 31.11, 33.46, 34.06, 35.61]) click(t);
whoosh(35.05, 0.7, 0.4); whoosh(36.5, 0.8, 0.8);
impactSfx(37, 1.1); crash(37, 0.9);

const duckEnv = new Float32Array(N).fill(1);
for (const k of kicks) {
  const i0 = Math.round(k * SR), len = Math.round(0.24 * SR);
  for (let i = 0; i < len && i0 + i < N; i++) duckEnv[i0 + i] = Math.min(duckEnv[i0 + i], 1 - 0.6 * (1 - i / len) ** 2);
}

function freeverb(input, room = 0.86, damp = 0.25, spread = 23) {
  const sc = SR / 44100;
  const out = bus();
  for (let ch = 0; ch < 2; ch++) {
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({ buf: new Float32Array(Math.round((n + ch * spread) * sc)), i: 0, store: 0 }));
    const aps = [556, 441, 341, 225].map((n) => ({ buf: new Float32Array(Math.round((n + ch * spread) * sc)), i: 0 }));
    const fb = room * 0.28 + 0.7;
    for (let n = 0; n < N; n++) {
      const x = (input[0][n] + input[1][n]) * 0.015;
      let y = 0;
      for (const c of combs) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * fb;
        if (++c.i >= c.buf.length) c.i = 0;
        y += o;
      }
      for (const a of aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = y + b * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        y = b - y;
      }
      out[ch][n] = y;
    }
  }
  return out;
}
function pingPong(input, time = 0.375, fb = 0.38) {
  const d = Math.round(time * SR), out = bus(), lpL = svf(), lpR = svf();
  for (let n = 0; n < N; n++) {
    const l = n >= d ? out[1][n - d] * fb : 0, r = n >= d ? out[0][n - d] * fb : 0;
    out[0][n] = lpL(input[0][n] + input[1][n] + l, 4500);
    out[1][n] = lpR(r, 4500);
  }
  return out;
}
const rev = freeverb(revSend), dly = pingPong(dlySend);

const mix = bus();
for (let n = 0; n < N; n++) {
  const t = n / SR, fade = t < 38.4 ? 1 : Math.max(0, 1 - (t - 38.4) / 1.6) ** 1.5;
  for (let ch = 0; ch < 2; ch++) mix[ch][n] = (dry[ch][n] + ducked[ch][n] * duckEnv[n] + rev[ch][n] * 2.2 + dly[ch][n] * 0.5) * fade;
}
let peak = 0;
for (const ch of mix) for (const v of ch) peak = Math.max(peak, Math.abs(v));
const drive = 1.8, norm = Math.tanh(drive);
const pcm = Buffer.alloc(N * 4);
for (let n = 0; n < N; n++) for (let ch = 0; ch < 2; ch++) {
  const v = (Math.tanh((mix[ch][n] / peak) * drive) / norm) * 0.89;
  pcm.writeInt16LE(Math.round(v * 32767), (n * 2 + ch) * 2);
}
const head = Buffer.alloc(44);
head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34);
head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
writeFileSync('promo/music.wav', Buffer.concat([head, pcm]));
console.log('peak before limiting', peak.toFixed(3));
