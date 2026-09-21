// The metronome's voices, synthesised on the spot: no samples to load, so the
// app works offline from its first visit and every hit lands sample-accurate on
// the time it is scheduled for.

export const SOUNDS = [
  { id: 'click', label: 'Click' },
  { id: 'drums', label: 'Drum kit' },
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
function pip(ctx, dest, time, freq, peak) {
  const HOLD = 0.04;
  const EDGE = 0.006;
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(peak, time + EDGE);
  gain.gain.setValueAtTime(peak, time + EDGE + HOLD);
  gain.gain.linearRampToValueAtTime(0, time + EDGE * 2 + HOLD);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(time);
  osc.stop(time + EDGE * 2 + HOLD + STOP_TAIL);
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

function kick(ctx, dest, time, level) {
  tone(ctx, dest, time, { freq: 155, to: 46, peak: 0.85 * level, decay: 0.3 });
  burst(ctx, dest, time, { filter: 'bandpass', freq: 3200, peak: 0.2 * level, decay: 0.008 });
}
function snare(ctx, dest, time, level) {
  burst(ctx, dest, time, { filter: 'highpass', freq: 1500, peak: 0.6 * level, decay: 0.15 });
  tone(ctx, dest, time, { freq: 215, to: 160, type: 'triangle', peak: 0.45 * level, decay: 0.09 });
}
function hat(ctx, dest, time, level) {
  burst(ctx, dest, time, { filter: 'highpass', freq: 7600, peak: 0.34 * level, decay: 0.04 });
}

function clave(ctx, dest, time, freq, level) {
  tone(ctx, dest, time, { freq, peak: 0.75 * level, decay: 0.06 });
  tone(ctx, dest, time, { freq: freq * 2.71, peak: 0.12 * level, decay: 0.02 });
  burst(ctx, dest, time, { filter: 'bandpass', freq: freq * 1.5, q: 2, peak: 0.25 * level, decay: 0.006 });
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
    if (step.offbeat) { hat(ctx, dest, time, 0.7); return; }
    if (step.unit === 8) {
      // Eighth-note meters groove as kick on the one, snare answering from the
      // next group, hi-hat carrying every eighth: 6/8 and 12/8 come out as the
      // shuffle they are, instead of a snare on every weak eighth.
      hat(ctx, dest, time, step.role === '.' ? 1 : 0.8);
      if (step.role === 'A') kick(ctx, dest, time, 1);
      else if (step.role === 'a') (step.group % 2 ? snare : kick)(ctx, dest, time, 0.85);
      return;
    }
    if (step.eighths) hat(ctx, dest, time, 1);
    if (step.role === 'A') kick(ctx, dest, time, 1);
    else if (step.role === 'a') kick(ctx, dest, time, 0.72);
    else snare(ctx, dest, time, 0.9);
  },

  claves(ctx, dest, time, step) {
    if (step.offbeat) clave(ctx, dest, time, 1900, OFFBEAT);
    else if (step.role === 'A') clave(ctx, dest, time, 2480, 1);
    else clave(ctx, dest, time, 1900, step.role === 'a' && step.unit === 8 ? 1 : 0.85);
  },

  beep(ctx, dest, time, step) {
    if (step.offbeat) pip(ctx, dest, time, 880, 0.24);
    else if (step.role === 'A') pip(ctx, dest, time, 1760, 0.7);
    else pip(ctx, dest, time, 880, step.role === 'a' && step.unit === 8 ? 0.62 : 0.5);
  },
};

// step: { sound, role, group, offbeat, unit, eighths }
export function playStep(ctx, dest, time, step) {
  (VOICES[step.sound] || VOICES.click)(ctx, dest, time, step);
}
