// The metronome's voices, synthesised on the spot: no samples to load, so the
// app works offline from its first visit and every hit lands sample-accurate on
// the time it is scheduled for.

export const SOUNDS = [
  { id: 'click', label: 'Click' },
  { id: 'drums', label: 'Drums' },
  { id: 'claves', label: 'Claves' },
  { id: 'beep', label: 'Beep' },
];

const SILENT = 0.0001;   // exponential ramps can't reach zero
const ATTACK = 0.001;    // long enough not to click, short enough to stay a hit
const STOP_TAIL = 0.02;

let noise = null;

function noiseBuffer(ctx) {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

function hitEnvelope(ctx, dest, time, peak, decay) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENT, time);
  gain.gain.linearRampToValueAtTime(peak, time + ATTACK);
  gain.gain.exponentialRampToValueAtTime(SILENT, time + ATTACK + decay);
  gain.connect(dest);
  return gain;
}

// A decaying oscillator; `to` lets the pitch fall during the hit (drum skins).
function tone(ctx, dest, time, { freq, to, type = 'sine', peak, decay }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, time + decay * 0.45);
  osc.connect(hitEnvelope(ctx, dest, time, peak, decay));
  osc.start(time);
  osc.stop(time + ATTACK + decay + STOP_TAIL);
}

// A decaying burst of filtered noise: stick attacks, snare wires, cymbals.
function burst(ctx, dest, time, { filter, freq, q = 0.8, peak, decay }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  // a different slice of the buffer per hit, or every hat is the same sample
  const offset = Math.random() * 0.5;
  const shape = ctx.createBiquadFilter();
  shape.type = filter;
  shape.frequency.value = freq;
  shape.Q.value = q;
  src.connect(shape);
  shape.connect(hitEnvelope(ctx, dest, time, peak, decay));
  src.start(time, offset);
  src.stop(time + ATTACK + decay + STOP_TAIL);
}

// A held tone with soft edges — the electronic metronome's pip.
function pip(ctx, dest, time, freq, peak, hold = 0.04) {
  const EDGE = 0.006;
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(peak, time + EDGE);
  gain.gain.setValueAtTime(peak, time + EDGE + hold);
  gain.gain.linearRampToValueAtTime(0, time + EDGE * 2 + hold);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(time);
  osc.stop(time + EDGE * 2 + hold + STOP_TAIL);
}

// Woodblock pair: the low block is the "toc", the high one the "tic".
function toc(ctx, dest, time, level) {
  tone(ctx, dest, time, { freq: 920, peak: 0.8 * level, decay: 0.075 });
  tone(ctx, dest, time, { freq: 1390, peak: 0.3 * level, decay: 0.04 });
  burst(ctx, dest, time, { filter: 'bandpass', freq: 2100, q: 1.2, peak: 0.45 * level, decay: 0.012 });
}
function tic(ctx, dest, time, level) {
  tone(ctx, dest, time, { freq: 1850, peak: 0.7 * level, decay: 0.04 });
  tone(ctx, dest, time, { freq: 2790, peak: 0.22 * level, decay: 0.022 });
  burst(ctx, dest, time, { filter: 'bandpass', freq: 4200, q: 1.2, peak: 0.3 * level, decay: 0.008 });
}

// Two layers: the falling sweep is the beater hitting the skin, the steady low
// sine under it is the shell ringing on. The sweep alone reads as a tom.
function synthKick(ctx, dest, time, level) {
  tone(ctx, dest, time, { freq: 118, to: 40, peak: 0.52 * level, decay: 0.34 });
  tone(ctx, dest, time, { freq: 52, peak: 0.36 * level, decay: 0.42 });
  burst(ctx, dest, time, { filter: 'bandpass', freq: 2600, peak: 0.1 * level, decay: 0.007 });
}
function synthSnare(ctx, dest, time, level) {
  burst(ctx, dest, time, { filter: 'highpass', freq: 1500, peak: 0.5 * level, decay: 0.15 });
  tone(ctx, dest, time, { freq: 215, to: 160, type: 'triangle', peak: 0.4 * level, decay: 0.09 });
}
function synthHat(ctx, dest, time, level) {
  burst(ctx, dest, time, { filter: 'highpass', freq: 7600, peak: 0.34 * level, decay: 0.04 });
}

// A shaker's beads roll before they hit the end of the egg: the noise swells
// in, and the swell starts early so that the hit, not the roll, is on time.
function shake(ctx, dest, time, { freq, swell, peak, decay }) {
  const start = Math.max(ctx.currentTime, time - swell);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const shape = ctx.createBiquadFilter();
  shape.type = 'bandpass';
  shape.frequency.value = freq;
  shape.Q.value = 0.9;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(SILENT, start);
  gain.gain.exponentialRampToValueAtTime(peak, Math.max(time, start + ATTACK));
  gain.gain.exponentialRampToValueAtTime(SILENT, Math.max(time, start + ATTACK) + decay);
  src.connect(shape);
  shape.connect(gain);
  gain.connect(dest);
  src.start(start, Math.random() * 0.5);
  src.stop(time + decay + STOP_TAIL);
}
// The stroke away from the body is crisp; the one back rolls longer and darker.
function synthShaker(ctx, dest, time, level) {
  shake(ctx, dest, time, { freq: 6800, swell: 0.012, peak: 0.42 * level, decay: 0.05 });
}
function synthShakerBack(ctx, dest, time, level) {
  shake(ctx, dest, time, { freq: 5200, swell: 0.035, peak: 0.36 * level, decay: 0.06 });
}

// The drum kit's recorded hits, one per drum, from SM Drums, and the shaker's
// two strokes from the Versilian Community Sample Library (both public domain).
// WAV, not a compressed format: those start with encoder padding that browsers
// don't reliably strip, and every hit would land late. Until a hit has arrived
// and decoded, or if it never does, its synthesized drum plays. `gain` brings
// each recording level with the synthesized drum it stands in for; `lead` is
// how far into the recording its hit comes, and it starts that much early.
const SAMPLES = {
  kick: { file: 'kick.wav', gain: 1, synth: synthKick },
  snare: { file: 'snare.wav', gain: 0.45, synth: synthSnare },
  hat: { file: 'hat.wav', gain: 0.46, synth: synthHat },
  shaker: { file: 'shaker.wav', gain: 0.4, lead: 0.005, synth: synthShaker },
  shakerBack: { file: 'shaker-back.wav', gain: 0.4, lead: 0.016, synth: synthShakerBack },
};
const IDS = Object.keys(SAMPLES);
const buffers = {};
let fetched = null;
let decoded = null;

// Only the bytes: there may be no AudioContext yet, and the first hit
// shouldn't wait on the network once there is.
export function fetchSamples() {
  fetched ??= Promise.all(IDS.map((id) =>
    fetch(new URL(`../sounds/${SAMPLES[id].file}`, import.meta.url))
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .catch(() => null)));
  return fetched;
}

export function decodeSamples(ctx) {
  decoded ??= fetchSamples().then((list) => Promise.all(list.map(async (bytes, i) => {
    if (!bytes) return false;
    try {
      buffers[IDS[i]] = await ctx.decodeAudioData(bytes);
      return true;
    } catch (e) { return false; }
  }))).then((ok) => {
    // offline on a first visit: try again on the next start
    if (ok.includes(false)) { fetched = null; decoded = null; }
  });
  return decoded;
}

function drum(id) {
  const { gain, lead = 0, synth } = SAMPLES[id];
  return (ctx, dest, time, level) => {
    const buffer = buffers[id];
    if (!buffer) { synth(ctx, dest, time, level); return; }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const amp = ctx.createGain();
    amp.gain.value = gain * level;
    src.connect(amp);
    amp.connect(dest);
    // too late to start early: skip into the recording instead, hit still on time
    const now = ctx.currentTime;
    if (time - lead < now) src.start(now, Math.min(lead, now - (time - lead)));
    else src.start(time - lead);
  };
}
const RECORDED = Object.fromEntries(IDS.map((id) => [id, drum(id)]));
const ELECTRONIC = Object.fromEntries(IDS.map((id) => [id, SAMPLES[id].synth]));
const kitFor = (step) => (step.electronic ? ELECTRONIC : RECORDED);

function clave(ctx, dest, time, freq, level) {
  tone(ctx, dest, time, { freq, peak: 0.75 * level, decay: 0.06 });
  tone(ctx, dest, time, { freq: freq * 2.71, peak: 0.12 * level, decay: 0.02 });
  burst(ctx, dest, time, { filter: 'bandpass', freq: freq * 1.5, q: 2, peak: 0.25 * level, decay: 0.006 });
}

// A rhythm's kit: bit i of a step's hits is INSTRUMENTS[i] of groove.js.
function kitHits(ctx, dest, time, step) {
  const { kick, snare, hat, shaker, shakerBack } = kitFor(step);
  const [kickOn, snareOn, hatOn, claveOn, shakerOn] = [1, 2, 4, 8, 16].map((b) => step.hits & b);
  if (kickOn) kick(ctx, dest, time, 1);
  if (snareOn) snare(ctx, dest, time, 0.9);
  // the same balance the kit keeps on its own: down under a drum, the off-beats
  // below the beats
  if (hatOn) hat(ctx, dest, time, kickOn || snareOn ? 0.5 : step.offbeat ? 0.7 : 1);
  if (claveOn) clave(ctx, dest, time, 2480, kickOn || snareOn ? 0.45 : 0.6);
  // away on the even eighths, back on the odd ones, as the hand goes
  if (shakerOn) (step.backstroke ? shakerBack : shaker)(ctx, dest, time, step.offbeat ? 0.75 : 1);
}

// The off-beat eighths sit under the beats, never level with them.
const OFFBEAT = 0.4;

const VOICES = {
  click(ctx, dest, time, step) {
    if (step.offbeat) tic(ctx, dest, time, OFFBEAT);
    else if (step.role === 'A') toc(ctx, dest, time, 1);
    // in an eighth-note meter the group starts are the pulse you count along to
    else tic(ctx, dest, time, step.role === 'a' && step.unit === 8 ? 1 : 0.8);
  },

  drums(ctx, dest, time, step) {
    if (step.hits !== undefined) { kitHits(ctx, dest, time, step); return; }
    const { kick, snare, hat } = kitFor(step);
    if (step.offbeat) { hat(ctx, dest, time, 0.7); return; }
    // The kick is the one, and only the one: a second kick inside the bar
    // (beat 3 of 4/4) makes the bar sound half as long as it is.
    if (step.unit === 8) {
      // Eighth-note meters: the snare answers from each later group and the
      // hi-hat carries every eighth, so 6/8 and 12/8 come out as the shuffle
      // they are instead of a snare on every weak eighth.
      hat(ctx, dest, time, step.role === '.' ? 1 : 0.5);
      if (step.role === 'A') kick(ctx, dest, time, 1);
      else if (step.role === 'a') snare(ctx, dest, time, 0.85);
      return;
    }
    // on a beat the hat sits under a drum that masks it anyway; kept down, the
    // pair stays below full scale (snare and hat are both noise, and add up)
    if (step.eighths) hat(ctx, dest, time, 0.5);
    if (step.role === 'A') kick(ctx, dest, time, 1);
    else snare(ctx, dest, time, 0.9);
  },

  // Every voice marks the one the same way — with its LOW sound, as the click's
  // toc does — so switching sounds never flips which beat is the downbeat. The
  // ear hears 2–4 kHz far louder than 1 kHz, so the high voice is kept down for
  // the low one to stay the accent.
  claves(ctx, dest, time, step) {
    if (step.offbeat) clave(ctx, dest, time, 2480, OFFBEAT * 0.8);
    else if (step.role === 'A') clave(ctx, dest, time, 1900, 1);
    else clave(ctx, dest, time, 2480, step.role === 'a' && step.unit === 8 ? 0.8 : 0.65);
  },

  beep(ctx, dest, time, step) {
    if (step.offbeat) pip(ctx, dest, time, 1760, 0.16);
    else if (step.role === 'A') pip(ctx, dest, time, 880, 0.72, 0.06);
    else pip(ctx, dest, time, 1760, step.role === 'a' && step.unit === 8 ? 0.46 : 0.36);
  },
};

// step: { sound, role, group, offbeat, unit, eighths, electronic, hits?, backstroke? }
export function playStep(ctx, dest, time, step) {
  (VOICES[step.sound] || VOICES.click)(ctx, dest, time, step);
}
