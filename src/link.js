// A link carries the exercise, so it opens the same setup elsewhere: tempo,
// meter, sound, rhythm and the trainer. Volume, view and theme belong to whoever is
// playing and stay out. Values are raw here; the app validates them as it does
// its own saved state.

const FLAGS = ['eighths', 'swing', 'electronic', 'trainer'];
const NUMBERS = { bpm: 'tempo', bars: 'bars', step: 'step', target: 'target' };

// Only the keys the link has: a hand-written `?bpm=120` changes the tempo and
// leaves everything else as the visitor had it.
export function readLink(search) {
  const q = new URLSearchParams(search);
  const out = {};
  for (const [key, field] of Object.entries(NUMBERS)) {
    const raw = (q.get(key) || '').trim();
    const v = raw ? Number(raw) : NaN;
    if (Number.isFinite(v)) out[field] = v;
  }
  for (const key of FLAGS) {
    const v = q.get(key);
    if (v !== null) out[key] = v === '1' || v === 'true';
  }
  // "6-8" for anyone typing a link by hand, where a slash looks like a path
  const sig = q.get('sig');
  if (sig) out.sig = sig.replace('-', '/');
  const sound = q.get('sound');
  if (sound) out.sound = sound;
  // a rhythm of one's own travels as its pattern; 0 is the kit playing its own
  const rhythm = q.get('rhythm');
  if (rhythm !== null) {
    out.rhythm = rhythm !== '0' && rhythm !== '';
    if (out.rhythm) out.groove = rhythm;
  }
  return out;
}

// Every key spelled out, so the visitor's own settings can't leak into the
// exercise; only an idle trainer's step and target are left out.
export function writeLink(state) {
  const q = new URLSearchParams({
    bpm: state.tempo,
    sig: state.sig,
    sound: state.sound,
    eighths: state.eighths ? 1 : 0,
    swing: state.swing ? 1 : 0,
    electronic: state.electronic ? 1 : 0,
    bars: state.bars,
    trainer: state.trainer ? 1 : 0,
    rhythm: state.rhythm && state.sound === 'drums' && state.groove ? state.groove : 0,
  });
  if (state.trainer) {
    q.set('step', state.step);
    q.set('target', state.target);
  }
  // a slash is legal in a query and far easier to read than %2F
  return `?${q}`.replace(/%2F/g, '/');
}
