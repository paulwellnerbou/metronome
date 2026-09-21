// Pure timing model: time signatures, the order steps are played in, and the
// speed trainer's tempo curve. No DOM and no audio in here.

export const TEMPO_MIN = 30;
export const TEMPO_MAX = 300;
export const BARS_MAX = 32;

// One character per beat: 'A' the downbeat, 'a' the start of a later group,
// '.' the beats in between. The odd meters take their most common grouping.
const PATTERNS = {
  '2/4': 'A.',
  '3/4': 'A..',
  '4/4': 'A.a.',
  '5/4': 'A..a.',
  '6/4': 'A..a..',
  '7/4': 'A.a.a..',
  '3/8': 'A..',
  '5/8': 'A..a.',
  '6/8': 'A..a..',
  '7/8': 'A.a.a..',
  '9/8': 'A..a..a..',
  '12/8': 'A..a..a..a..',
};

export const SIGNATURES = Object.entries(PATTERNS).map(([id, pattern]) => {
  const [beats, unit] = id.split('/').map(Number);
  return { id, beats, unit, pattern };
});

export function signature(id) {
  return SIGNATURES.find((s) => s.id === id) || SIGNATURES.find((s) => s.id === '4/4');
}

// Per beat: its role and which group of the bar it belongs to (0-based).
export function beatRoles(sig) {
  let group = -1;
  return [...sig.pattern].map((role) => {
    if (role !== '.') group += 1;
    return { role, group };
  });
}

// The tempo counts the signature's own unit, so eighth-note subdivisions only
// exist where that unit is the quarter.
export function subsFor(sig, eighths) {
  return eighths && sig.unit === 4 ? 2 : 1;
}

export function clampTempo(bpm) {
  const n = Math.round(Number(bpm));
  if (!Number.isFinite(n)) return null;
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, n));
}

const MARKINGS = [
  [40, 'Grave'], [60, 'Largo'], [66, 'Larghetto'], [76, 'Adagio'],
  [108, 'Andante'], [120, 'Moderato'], [156, 'Allegro'], [176, 'Vivace'],
  [200, 'Presto'],
];

export function tempoMarking(bpm) {
  const hit = MARKINGS.find(([below]) => bpm < below);
  return hit ? hit[1] : 'Prestissimo';
}

// cfg: { sig, subs, bars, trainer: { on, step, target } }
// pos: { beat, sub, bar, pass, tempo } — the step about to be played.
export function firstPos(tempo) {
  return { beat: 0, sub: 0, bar: 0, pass: 0, tempo };
}

export function trainerTempo(tempo, trainer) {
  // A tempo already past the target is the player's own choice: leave it.
  if (!trainer.on || tempo >= trainer.target) return tempo;
  return Math.min(trainer.target, tempo + trainer.step);
}

export function nextPos(pos, cfg) {
  let { beat, sub, bar, pass, tempo } = pos;
  sub += 1;
  if (sub < cfg.subs) return { beat, sub, bar, pass, tempo };
  sub = 0;
  beat += 1;
  if (beat < cfg.sig.beats) return { beat, sub, bar, pass, tempo };
  beat = 0;
  bar += 1;
  if (bar < cfg.bars) return { beat, sub, bar, pass, tempo };
  return { beat, sub, bar: 0, pass: pass + 1, tempo: trainerTempo(tempo, cfg.trainer) };
}

export function stepSeconds(pos, cfg) {
  return 60 / pos.tempo / cfg.subs;
}

export function stepsPerPhrase(cfg) {
  return cfg.bars * cfg.sig.beats * cfg.subs;
}

export function stepIndex(pos, cfg) {
  return (pos.bar * cfg.sig.beats + pos.beat) * cfg.subs + pos.sub;
}

// What the trainer has ahead of it from `tempo`: how many phrases are played
// before the target is reached, and how long those take.
export function trainerPlan(tempo, cfg) {
  const { trainer } = cfg;
  if (!trainer.on || trainer.step <= 0 || tempo >= trainer.target) return { passes: 0, seconds: 0 };
  let passes = 0;
  let seconds = 0;
  for (let t = tempo; t < trainer.target; t = trainerTempo(t, trainer)) {
    passes += 1;
    seconds += cfg.bars * cfg.sig.beats * 60 / t;
  }
  return { passes, seconds };
}
