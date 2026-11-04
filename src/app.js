// Feature logic and DOM wiring. The timing model is meter.js, the clockwork
// engine.js; this file only turns settings into a config for them and paints
// what they report back.

import {
  BARS_MAX, SIGNATURES, TEMPO_MAX, TEMPO_MIN,
  beatRoles, clampTempo, signature, subsFor, tempoMarking, trainerPlan, trainerProgress, trainerTempo,
} from './meter.js';
import { SOUNDS } from './sounds.js';
import { createEngine } from './engine.js';
import { readLink, writeLink } from './link.js';
import {
  INSTRUMENTS, decodeGroove, defaultGroove, encodeGroove, resize, slotAt, slotsPerBar, slotsPerBeat,
} from './groove.js';

const $ = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// --- State -----------------------------------------------------------------

const STORE = 'metronome-state';
const DEFAULTS = {
  tempo: 100, sig: '4/4', sound: 'click', eighths: false, swing: false, bars: 4,
  trainer: false, step: 5, target: 140, rhythm: false, groove: null, view: 'ring', volume: 80,
};
const STEP_MAX = 30;

function loadState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { /* private mode, or not ours */ }
  // a shared link wins over what this browser last had, key by key
  saved = { ...saved, ...readLink(location.search) };
  const int = (v, min, max, fallback) => (Number.isFinite(v) ? clamp(Math.round(v), min, max) : fallback);
  return {
    tempo: int(saved.tempo, TEMPO_MIN, TEMPO_MAX, DEFAULTS.tempo),
    sig: signature(saved.sig).id,
    sound: SOUNDS.some((s) => s.id === saved.sound) ? saved.sound : DEFAULTS.sound,
    eighths: saved.eighths === true,
    swing: saved.swing === true,
    bars: int(saved.bars, 1, BARS_MAX, DEFAULTS.bars),
    trainer: saved.trainer === true,
    step: int(saved.step, 1, STEP_MAX, DEFAULTS.step),
    target: int(saved.target, TEMPO_MIN, TEMPO_MAX, DEFAULTS.target),
    rhythm: saved.rhythm === true,
    // checked against the meter once there is one: see loadCells
    groove: typeof saved.groove === 'string' ? saved.groove : null,
    view: saved.view === 'bar' ? 'bar' : 'ring',
    volume: int(saved.volume, 0, 100, DEFAULTS.volume),
  };
}

const state = loadState();
const engine = createEngine();

// The tempo being played, while the trainer has moved it off state.tempo.
let live = null;
const shownTempo = () => live ?? state.tempo;

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* private mode */ }
  syncLink();
}

// The address bar always holds a link to the current exercise. Debounced: a
// dragged slider saves on every step, and Safari throws once a page rewrites its
// URL more than about a hundred times in thirty seconds.
let linkTimer = null;
function syncLink() {
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    try { history.replaceState(history.state, '', writeLink(state) + location.hash); } catch (e) { /* throttled */ }
  }, 250);
}

function engineCfg() {
  const sig = signature(state.sig);
  const rhythm = rhythmOn();
  return {
    sig,
    // a rhythm is written in eighths, so it runs on them
    subs: subsFor(sig, state.eighths || rhythm),
    groove: rhythm ? cells : null,
    swing: state.swing,
    bars: state.bars,
    sound: state.sound,
    trainer: { on: state.trainer, step: state.step, target: state.target },
  };
}

// --- Display: ring, beats, phrase -------------------------------------------

const RING_C = 160;
const RING_R = 142;
const CLIMB_R = 128;   // the trainer's whole climb, just inside the phrase
const display = $('display');
let ringFills = [];
let ringSpans = [];   // [startDeg, endDeg] per bar, for the playhead
let playhead = null;
let climbFill = null;
let phraseFills = [];
let beatEls = [];
let lastStep = null;

const polar = (deg) => {
  const rad = (deg - 90) * Math.PI / 180;
  return [RING_C + RING_R * Math.cos(rad), RING_C + RING_R * Math.sin(rad)];
};

function arcPath(a0, a1) {
  const [x0, y0] = polar(a0);
  const [x1, y1] = polar(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${RING_R} ${RING_R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function buildPhrase() {
  const n = state.bars;
  const slice = 360 / n;
  // a lone bar closes the circle but for a hair: an arc can't end where it starts
  const gap = n > 1 ? Math.min(5, slice * 0.2) : 0.02;
  ringSpans = Array.from({ length: n }, (_, i) => [i * slice + gap / 2, (i + 1) * slice - gap / 2]);
  $('ring').innerHTML = ringSpans.map(([a0, a1]) => {
    const d = arcPath(a0, a1);
    return `<path class="seg-track" d="${d}"/><path class="seg-fill" d="${d}" pathLength="1"/>`;
  }).join('') +
    // rotated so the circle's own start, at three o'clock, sits at the top
    `<g class="climb" transform="rotate(-90 ${RING_C} ${RING_C})">` +
    `<circle class="climb-track" cx="${RING_C}" cy="${RING_C}" r="${CLIMB_R}"/>` +
    `<circle class="climb-fill" cx="${RING_C}" cy="${RING_C}" r="${CLIMB_R}" pathLength="1"/></g>` +
    '<circle class="playhead" r="7"/>';
  ringFills = [...$('ring').querySelectorAll('.seg-fill')];
  climbFill = $('ring').querySelector('.climb-fill');
  playhead = $('ring').querySelector('.playhead');

  $('phrase').innerHTML = '<span class="phrase-seg"><i></i></span>'.repeat(n);
  phraseFills = [...$('phrase').querySelectorAll('i')];
  display.classList.toggle('many-bars', n > 12);
  paintProgress(0);
}

function buildBeats() {
  const sig = signature(state.sig);
  // 2+2 is how everyone hears 4/4 anyway; only show the grouping where it
  // tells you something
  const grouped = sig.unit === 8 || sig.beats > 4;
  $('beats').innerHTML = beatRoles(sig).map(({ role }, i) =>
    `<span class="beat${role === 'A' ? ' down' : ''}${grouped && role === 'a' ? ' group-start' : ''}">${i + 1}</span>`).join('');
  beatEls = [...$('beats').children];
  $('beats').dataset.count = sig.beats;
}

// `climb`: how far the trainer's whole run has come, 0..1.
function paintProgress(p, climb = 0) {
  climbFill.style.strokeDasharray = `${climb.toFixed(4)} 1`;
  $('climb-strip').style.transform = `scaleX(${climb.toFixed(4)})`;
  const n = ringFills.length;
  const at = clamp(p, 0, 1) * n;
  for (let i = 0; i < n; i++) {
    const v = clamp(at - i, 0, 1);
    ringFills[i].style.strokeDasharray = `${v.toFixed(4)} 1`;
    phraseFills[i].style.transform = `scaleX(${v.toFixed(4)})`;
  }
  const bar = Math.min(n - 1, Math.floor(at));
  const [a0, a1] = ringSpans[bar];
  const [x, y] = polar(a0 + (a1 - a0) * clamp(at - bar, 0, 1));
  playhead.setAttribute('cx', x.toFixed(2));
  playhead.setAttribute('cy', y.toFixed(2));
}

// Restarting a CSS animation needs the class gone for a style flush.
function retrigger(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function onStep(step) {
  lastStep = step;
  markRhythmSlot(step);
  if (step.tempo !== shownTempo()) {
    const from = shownTempo();
    live = step.tempo;
    renderTempo();
    rollTempo(from);
  }
  if (step.sub > 0) return;
  beatEls.forEach((el, i) => el.classList.toggle('on', i === step.beat));
  if (beatEls[step.beat]) retrigger(beatEls[step.beat], 'hit');
  display.classList.toggle('accent', step.beat === 0);
  retrigger(display, 'pulse');
  if (step.beat === 0) {
    if (step.bar === 0 && step.pass > 0) retrigger(display, 'lap');
    renderBarCount(step);
    renderStatus(step);
  }
}

function frame() {
  if (!engine.running) return;
  for (const step of engine.drain()) onStep(step);
  if (lastStep) {
    const into = clamp((engine.clock() - lastStep.time) / lastStep.dur, 0, 1);
    const p = lastStep.at + into * lastStep.span;
    paintProgress(p, state.trainer ? trainerProgress(state.tempo, lastStep.tempo, p, engineCfg()) : 0);
  }
  requestAnimationFrame(frame);
}

const phraseText = (n) => `${n} ${n === 1 ? 'bar' : 'bars'} per phrase`;

function renderBarCount(step) {
  $('bar-count').textContent = step ? `Bar ${step.bar + 1} of ${state.bars}` : phraseText(state.bars);
}

// --- Tempo -------------------------------------------------------------------

function renderTempo() {
  const tempo = shownTempo();
  const bpm = $('bpm');
  if (document.activeElement !== bpm) bpm.value = tempo;
  const slider = $('tempo');
  slider.value = tempo;
  slider.style.setProperty('--pct', `${(tempo - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN) * 100}%`);
  $('marking').textContent = tempoMarking(tempo);
  $('tempo-down').disabled = tempo <= TEMPO_MIN;
  $('tempo-up').disabled = tempo >= TEMPO_MAX;
}

// A jump the player didn't dial in — a trainer step, a restart, a tap — rolls in
// from the side it came from. Slider and held buttons change it far too often.
function rollTempo(from) {
  const to = shownTempo();
  if (to === from) return;
  const bpm = $('bpm');
  bpm.classList.remove('roll-up', 'roll-down');
  void bpm.offsetWidth;
  bpm.classList.add(to > from ? 'roll-up' : 'roll-down');
}

// A tempo the player sets is the new base — also mid-run, where it overrides
// whatever the trainer had climbed to.
function setTempo(value) {
  const tempo = clampTempo(value);
  if (tempo !== null) {
    state.tempo = tempo;
    if (live !== null) live = tempo;
    engine.setTempo(tempo);
    save();
  }
  renderTempo();
  renderTrainer();
}

let taps = [];
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 6) taps.shift();
  if (taps.length > 1) {
    const from = shownTempo();
    setTempo(60000 * (taps.length - 1) / (now - taps[0]));
    rollTempo(from);
  }
  retrigger($('tap'), 'tapped');
}

// Fires once on press, then repeats while held. Keyboard activation arrives as
// a click with no pointer behind it (detail 0).
function holdRepeat(btn, fn) {
  let delay = null;
  let repeat = null;
  const stop = () => { clearTimeout(delay); clearInterval(repeat); };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    stop();
    fn();
    delay = setTimeout(() => {
      // a button that disabled itself at its limit never sees the pointerup
      repeat = setInterval(() => { if (btn.disabled) stop(); else fn(); }, 70);
    }, 420);
  });
  ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((type) => btn.addEventListener(type, stop));
  btn.addEventListener('click', (e) => { if (e.detail === 0) fn(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function initStepper(el, { key, min, max, format, caption, onChange }) {
  el.innerHTML =
    '<button type="button" class="step-btn" data-dir="-1" aria-label="Less">&minus;</button>' +
    `<output class="step-val"${caption ? ` data-caption="${caption}"` : ''}></output>` +
    '<button type="button" class="step-btn" data-dir="1" aria-label="More">+</button>';
  const out = el.querySelector('output');
  const btns = [...el.querySelectorAll('button')];
  const render = () => {
    out.textContent = format(state[key]);
    btns[0].disabled = state[key] <= min;
    btns[1].disabled = state[key] >= max;
  };
  btns.forEach((btn) => holdRepeat(btn, () => {
    const next = clamp(state[key] + Number(btn.dataset.dir), min, max);
    if (next === state[key]) return;
    state[key] = next;
    save();
    render();
    onChange();
  }));
  render();
  return render;
}

// --- Settings ------------------------------------------------------------------

const icon = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// Click and beep as their waveforms: one transient against a held tone.
const SOUND_ICONS = {
  click: icon('<path d="M2.5 17h8l1.5-12.5 1.5 12.5h8" />'),
  drums: icon('<ellipse cx="12" cy="13" rx="8" ry="2.6" /><path d="M4 13v4.9c0 1.45 3.6 2.6 8 2.6s8-1.15 8-2.6V13" /><path d="M4.5 4.3l9.2 7M19.5 4.3l-9.2 7" />'),
  claves: icon('<rect x="3" y="15.4" width="18" height="3.6" rx="1.8" transform="rotate(-6 12 17.2)" /><rect x="2.5" y="6.5" width="14" height="3.6" rx="1.8" transform="rotate(40 9.5 8.3)" /><path d="M18.2 12.6l1.6-1.5M17 10.6l.4-1.9" />'),
  beep: icon('<path d="M2.5 12c1.6 0 1.6-5.5 3.2-5.5S7.3 17.5 8.9 17.5s1.6-11 3.2-11 1.6 11 3.2 11 1.6-11 3.2-11 1.6 5.5 3.2 5.5" />'),
};

function initChips(container, items, key, onChange, icons = {}) {
  container.innerHTML = items.map(({ id, label }) =>
    `<button type="button" class="chip" role="radio" data-id="${id}">${icons[id] ?? ''}${label}</button>`).join('');
  const render = () => [...container.children].forEach((chip) => {
    chip.setAttribute('aria-checked', String(chip.dataset.id === state[key]));
  });
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.dataset.id === state[key]) return;
    state[key] = chip.dataset.id;
    save();
    render();
    onChange();
  });
  render();
}

// Eighth-note subdivisions only exist where the beat is a quarter. In an
// eighth-note meter the switch shows what happens anyway: the kit's hi-hat is
// on every eighth, the other sounds have nothing finer to play.
function renderEighths() {
  const custom = rhythmOn();
  const input = $('eighths');
  const drums = state.sound === 'drums';
  const fixed = signature(state.sig).unit === 8;
  // A rhythm of one's own puts the hi-hat where its grid says; the switch keeps
  // the player's own choice for when the kit plays on its own again.
  input.disabled = fixed || custom;
  input.checked = fixed ? drums : state.eighths;
  const label = input.closest('.switch');
  label.classList.toggle('is-fixed', fixed || custom);
  label.title = custom ? 'The custom rhythm sets the hi-hat' : '';
  $('eighths-text').textContent = drums ? 'Hi-hat on eighths' : 'Eighth-note ticks';
  // only a beat split in two can swing
  const swing = $('swing');
  const off = subsFor(signature(state.sig), state.eighths || custom) !== 2;
  swing.disabled = off;
  swing.checked = state.swing && !off;
  swing.closest('.switch').classList.toggle('is-fixed', off);
}

const clock = (seconds) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// A short phrase in whole seconds would read the same from start to target.
const span = (seconds) => (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds)));

function renderTrainer() {
  const on = state.trainer;
  $('trainer').setAttribute('aria-pressed', String(on));
  $('stage').classList.toggle('training', on);
  $('trainer-panel').inert = !on;
  const share = $('setup-share');
  if (!share.classList.contains('copied')) share.title = setupShareTitle();
  share.setAttribute('aria-label', setupShareTitle());
  renderRestart();
  renderStatus(engine.running ? lastStep : null);
}

// Stopping already drops back to the start tempo; only a running climb has
// anywhere to restart from.
function renderRestart() {
  const btn = $('restart');
  btn.disabled = !state.trainer || !engine.running;
  btn.title = `Restart at ${state.tempo} BPM, phrase 1`;
  btn.setAttribute('aria-label', btn.title);
}

function restartClimb() {
  if (!engine.running) return;
  const from = shownTempo();
  engine.restart(state.tempo);
  live = state.tempo;
  lastStep = null;
  beatEls.forEach((el) => el.classList.remove('on', 'hit'));
  markRhythmSlot(null);
  paintProgress(0);
  renderTempo();
  rollTempo(from);
  renderBarCount(null);
  renderStatus(null);
}

function renderStatus(step) {
  if (!state.trainer) return;
  const el = $('trainer-status');
  if (step) {
    const tempo = shownTempo();
    const next = trainerTempo(tempo, engineCfg().trainer);
    el.textContent = next > tempo ? `Phrase ${step.pass + 1} · next ${next} BPM` : `Holding at ${tempo} BPM`;
    return;
  }
  const cfg = engineCfg();
  const { passes, seconds } = trainerPlan(state.tempo, cfg);
  if (!passes) {
    el.textContent = `Already at ${state.tempo} — raise the target`;
    return;
  }
  // Every phrase is shorter than the last, so "each" is a range: the first
  // phrase, at the start tempo, down to the last one below the target.
  const phrase = (tempo) => cfg.bars * cfg.sig.beats * 60 / tempo;
  const first = span(phrase(state.tempo));
  const last = span(phrase(state.tempo + state.step * (passes - 1)));
  const each = passes === 1 ? '' : ` · ${first === last ? first : `${first}–${last}`} s each`;
  el.textContent = `${state.tempo} → ${state.target} BPM in ${passes} ${passes === 1 ? 'phrase' : 'phrases'}\n${clock(seconds)} total${each}`;
}

function renderView() {
  display.dataset.view = state.view;
  $('view').dataset.view = state.view;
  const label = state.view === 'ring'
    ? 'Ring display. Switch to the bar display'
    : 'Bar display. Switch to the ring display';
  $('view').setAttribute('aria-label', label);
  $('view').title = label.split('. ')[1];
}

const calm = matchMedia('(prefers-reduced-motion: reduce)');
let viewSwitch = null;
let switchPath = null;   // the box the switch glides through while switching
function setView(view) {
  state.view = view;
  save();
  if (!document.startViewTransition || calm.matches) { renderView(); return; }
  const root = document.documentElement;
  root.classList.add('view-switching');
  const from = $('view').getBoundingClientRect();
  const t = viewSwitch = document.startViewTransition(() => {
    renderView();
    const to = $('view').getBoundingClientRect();
    switchPath = {
      left: Math.min(from.left, to.left), right: Math.max(from.right, to.right),
      top: Math.min(from.top, to.top), bottom: Math.max(from.bottom, to.bottom),
    };
  });
  // a switch started mid-switch takes over the names; don't strip them from it
  t.finished.finally(() => {
    if (viewSwitch !== t) return;
    viewSwitch = null;
    root.classList.remove('view-switching');
  });
}
const flipView = () => setView(state.view === 'ring' ? 'bar' : 'ring');


// --- Rhythm --------------------------------------------------------------------

let cells = [];
const rhythmOn = () => state.rhythm && state.sound === 'drums';

// The saved rhythm where it fits this meter and phrase, or else what the kit
// plays on its own.
function loadCells() {
  const sig = signature(state.sig);
  cells = decodeGroove(state.groove, sig, state.bars) ?? defaultGroove(sig, state.eighths, state.bars);
}

// Back to the kit's own pattern. A rhythm that is on keeps it as its own, so a
// link to it still carries one.
function resetRhythm() {
  state.groove = null;
  loadCells();
  if (state.rhythm) state.groove = encodeGroove(cells, signature(state.sig));
}

function resizeRhythm() {
  cells = resize(cells, state.bars * slotsPerBar(signature(state.sig)));
  if (state.groove) state.groove = encodeGroove(cells, signature(state.sig));
}

function renderRhythm() {
  $('rhythm-row').hidden = state.sound !== 'drums';
  $('rhythm').checked = state.rhythm;
  $('rhythm-off').hidden = state.rhythm;
  $('rhythm-dialog').classList.toggle('is-off', !state.rhythm);
}

function rhythmChanged() {
  save();
  renderRhythm();
  renderEighths();
  reconfigure(false);
}

function setRhythm(on) {
  state.rhythm = on;
  if (on && !state.groove) state.groove = encodeGroove(cells, signature(state.sig));
  rhythmChanged();
}

// An edit is a rhythm of one's own, so it switches it on.
function editRhythm() {
  state.groove = encodeGroove(cells, signature(state.sig));
  state.rhythm = true;
  rhythmChanged();
  paintRhythm();
}

let slotEls = [];   // per slot of the phrase: its count and its four cells
let nowSlot = -1;

function buildRhythm() {
  const sig = signature(state.sig);
  const per = slotsPerBeat(sig);
  const bar = slotsPerBar(sig);
  const roles = beatRoles(sig);
  // Beats stand apart, a meter's groups further still, by spacer columns: a
  // margin on a cell would narrow that cell instead.
  const tracks = ['var(--label)'];
  const cols = Array.from({ length: bar }, (_, s) => {
    const beat = Math.floor(s / per);
    const on = s % per === 0;
    if (on && s > 0) tracks.push(roles[beat].role === '.' ? 'var(--beat-gap)' : 'var(--group-gap)');
    tracks.push('minmax(0, 1fr)');
    return {
      count: on ? String(beat + 1) : '+',
      spoken: on ? `beat ${beat + 1}` : `beat ${beat + 1} and`,
      cls: on ? 'beat-start' : '',
      at: `grid-column:${tracks.length}`,
    };
  });
  let html = '';
  for (let b = 0; b < state.bars; b++) {
    html += `<section class="rbar"><div class="rbar-head"><h3>Bar ${b + 1}</h3>` +
      (state.bars > 1 ? `<button type="button" class="rbar-copy" data-bar="${b}">Copy to every bar</button>` : '') +
      `</div><div class="rgrid" style="grid-template-columns:${tracks.join(' ')}"><span></span>` +
      cols.map((c, s) => `<span class="rcount ${c.cls}" style="${c.at}" data-slot="${b * bar + s}" aria-hidden="true">${c.count}</span>`).join('');
    INSTRUMENTS.forEach((inst, i) => {
      html += `<span class="rlabel">${inst.label}</span>`;
      html += cols.map((c, s) => `<button type="button" class="cell ${c.cls}" style="${c.at}" data-slot="${b * bar + s}" data-inst="${i}" tabindex="-1" aria-pressed="false" aria-label="${inst.label}, bar ${b + 1}, ${c.spoken}"></button>`).join('');
    });
    html += '</div></section>';
  }
  const host = $('rhythm-bars');
  host.innerHTML = html;
  slotEls = [];
  host.querySelectorAll('[data-slot]').forEach((el) => { (slotEls[el.dataset.slot] ??= []).push(el); });
  const first = host.querySelector('.cell');
  if (first) first.tabIndex = 0;
  nowSlot = -1;
  $('rhythm-meta').textContent = `${sig.id} · ${state.bars} ${state.bars === 1 ? 'bar' : 'bars'} · ${per === 2 ? 'eighths' : 'one cell per beat'}`;
  paintRhythm();
}

function paintRhythm() {
  slotEls.forEach((els, slot) => els.forEach((el) => {
    if (el.dataset.inst !== undefined) el.setAttribute('aria-pressed', String(Boolean(cells[slot] & (1 << el.dataset.inst))));
  }));
}

function markRhythmSlot(step) {
  if (!$('rhythm-dialog').open) return;
  const slot = step ? slotAt(step, signature(state.sig)) : -1;
  if (slot === nowSlot) return;
  slotEls[nowSlot]?.forEach((el) => el.classList.remove('now'));
  slotEls[slot]?.forEach((el) => el.classList.add('now'));
  nowSlot = slot;
}

function setCell(cell, on) {
  const slot = Number(cell.dataset.slot);
  const mask = 1 << Number(cell.dataset.inst);
  if (Boolean(cells[slot] & mask) === on) return;
  cells[slot] ^= mask;
  if (on) engine.audition(mask);
  editRhythm();
}

function initRhythm() {
  const dialog = $('rhythm-dialog');
  const host = $('rhythm-bars');

  $('rhythm-edit').addEventListener('click', () => {
    buildRhythm();
    dialog.showModal();
    if (engine.running && lastStep) markRhythmSlot(lastStep);
  });
  const close = () => dialog.close();
  $('rhythm-close').addEventListener('click', close);
  $('rhythm-done').addEventListener('click', close);
  // the backdrop is the dialog's own box; the sheet covers the rest of it
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener('close', () => { slotEls = []; nowSlot = -1; });

  $('rhythm').addEventListener('change', (e) => setRhythm(e.target.checked));
  $('rhythm-play').addEventListener('click', () => (engine.running ? stop() : start()));
  $('rhythm-reset').addEventListener('click', () => {
    resetRhythm();
    rhythmChanged();
    paintRhythm();
  });
  $('rhythm-clear').addEventListener('click', () => {
    cells.fill(0);
    editRhythm();
  });

  // A mouse paints: press on a cell and drag along its row. A finger taps, so
  // a swipe stays a scroll.
  let paint = null;
  let mouse = false;
  host.addEventListener('pointerdown', (e) => {
    mouse = e.pointerType === 'mouse';
    const cell = e.target.closest('.cell');
    if (!cell || !mouse || e.button !== 0) return;
    paint = { inst: cell.dataset.inst, on: cell.getAttribute('aria-pressed') !== 'true' };
    setCell(cell, paint.on);
  });
  host.addEventListener('pointerover', (e) => {
    const cell = paint && e.target.closest('.cell');
    if (cell && cell.dataset.inst === paint.inst) setCell(cell, paint.on);
  });
  window.addEventListener('pointerup', () => { paint = null; });
  host.addEventListener('click', (e) => {
    const copy = e.target.closest('.rbar-copy');
    if (copy) {
      const per = slotsPerBar(signature(state.sig));
      const from = Number(copy.dataset.bar) * per;
      const bar = cells.slice(from, from + per);
      cells = resize(bar, cells.length);
      editRhythm();
      return;
    }
    const cell = e.target.closest('.cell');
    // a mouse press already toggled it; keyboard clicks have no detail
    if (!cell || (mouse && e.detail > 0)) return;
    setCell(cell, cell.getAttribute('aria-pressed') !== 'true');
  });

  // One tab stop for the whole grid; arrows walk it.
  host.addEventListener('focusin', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    host.querySelectorAll('.cell[tabindex="0"]').forEach((el) => { if (el !== cell) el.tabIndex = -1; });
    cell.tabIndex = 0;
  });
  host.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.cell');
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!cell || !move) return;
    e.preventDefault();
    const slot = Number(cell.dataset.slot) + move[0];
    const inst = Number(cell.dataset.inst) + move[1];
    slotEls[slot]?.find((el) => Number(el.dataset.inst) === inst)?.focus();
  });
}

// --- Transport -------------------------------------------------------------------

let wakeLock = null;
async function holdScreen(on) {
  try {
    if (!on) {
      if (wakeLock) await wakeLock.release();
      wakeLock = null;
    } else if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* low battery or no permission: the metronome plays on regardless */ }
}

function renderTransport() {
  const btn = $('toggle');
  const on = engine.running;
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'Stop' : 'Start');
  btn.title = on ? 'Stop (Space)' : 'Start (Space)';
  const play = $('rhythm-play');
  play.setAttribute('aria-pressed', String(on));
  play.setAttribute('aria-label', on ? 'Stop' : 'Start');
  play.title = btn.title;
  display.classList.toggle('running', on);
}

function start() {
  live = state.tempo;
  lastStep = null;
  engine.configure(engineCfg());
  engine.start(state.tempo);
  holdScreen(true);
  renderTransport();
  renderRestart();
  requestAnimationFrame(frame);
}

function stop() {
  engine.stop();
  holdScreen(false);
  const from = shownTempo();
  live = null;
  lastStep = null;
  beatEls.forEach((el) => el.classList.remove('on', 'hit'));
  display.classList.remove('pulse', 'lap', 'accent');
  markRhythmSlot(null);
  paintProgress(0);
  renderTransport();
  renderTempo();
  rollTempo(from);
  renderBarCount(null);
  renderRestart();
  renderStatus(null);
}

// `restart`: the change redefines the phrase, so a running metronome goes back
// to its first beat.
function reconfigure(restart) {
  engine.configure(engineCfg(), restart);
  if (restart && engine.running) lastStep = null;
}

// --- Theme ---------------------------------------------------------------------
// The theme is set pre-paint by an inline script; here we wire the menu up.
const THEMES = ['warm', 'cool', 'dark'];
const THEME_BAR = { warm: '#f3e8d4', cool: '#eaeef2', dark: '#1d2531' };

function initTheme() {
  const root = document.documentElement;
  const btn = $('theme-toggle');
  const menu = $('theme-menu');
  const meta = document.querySelector('meta[name="theme-color"]');
  const opts = () => [...menu.querySelectorAll('.theme-opt')];
  let open = false;
  let activeIndex = 0;

  const apply = (theme) => {
    root.dataset.theme = theme;
    if (meta) meta.content = THEME_BAR[theme];
    const label = `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    opts().forEach((li) => li.setAttribute('aria-selected', String(li.dataset.theme === theme)));
  };
  const setActive = (i) => {
    const list = opts();
    activeIndex = (i + list.length) % list.length;
    list.forEach((li, n) => li.classList.toggle('active', n === activeIndex));
  };
  const openMenu = () => {
    open = true;
    menu.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    setActive(Math.max(0, opts().findIndex((li) => li.dataset.theme === root.dataset.theme)));
  };
  const closeMenu = (focus) => {
    open = false;
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (focus) btn.focus();
  };
  const choose = (theme) => {
    apply(theme);
    try { localStorage.setItem('metronome-theme', theme); } catch (e) { /* private mode */ }
    closeMenu(true);
  };

  apply(THEMES.includes(root.dataset.theme) ? root.dataset.theme : 'dark');

  btn.addEventListener('click', () => { open ? closeMenu() : openMenu(); });
  menu.addEventListener('click', (e) => {
    const li = e.target.closest('.theme-opt');
    if (li) choose(li.dataset.theme);
  });
  btn.addEventListener('keydown', (e) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openMenu(); }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive(activeIndex + 1); break;
      case 'ArrowUp': e.preventDefault(); setActive(activeIndex - 1); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(opts().length - 1); break;
      case 'Enter': case ' ': e.preventDefault(); choose(opts()[activeIndex].dataset.theme); break;
      case 'Escape': case 'Tab': closeMenu(e.key === 'Escape'); break;
    }
  });
  document.addEventListener('click', (e) => { if (open && !e.target.closest('#theme-cbx')) closeMenu(); });
}

// --- Install + offline -------------------------------------------------------------

function initInstall() {
  const btn = $('install');
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    prompt = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

// --- Sharing ------------------------------------------------------------------------

const setupShareTitle = () => (state.trainer ? 'Share trainer settings' : 'Share settings');

function shareText() {
  const { tempo, sig, bars, step, target } = state;
  const rhythm = rhythmOn() ? ', with my own drum rhythm' : '';
  return state.trainer
    ? `Speed trainer in ${sig}: ${tempo} → ${target} BPM, +${step} every ${bars} ${bars === 1 ? 'bar' : 'bars'}${rhythm}`
    : `Metronome: ${tempo} BPM in ${sig}${rhythm}`;
}

// The share sheet where there is one; elsewhere the link goes to the clipboard,
// and the button says so for a moment.
function initShareButton(btn, data, title) {
  const label = btn.querySelector('span');
  const idleLabel = label?.textContent;
  let done = null;
  btn.addEventListener('click', async () => {
    const { url, text } = data();
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, text, url });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;   // the sheet was dismissed
      }
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch (e) {
      return;
    }
    btn.classList.add('copied');
    btn.title = 'Link copied';
    if (label) label.textContent = 'Copied';
    clearTimeout(done);
    done = setTimeout(() => {
      btn.classList.remove('copied');
      btn.title = title();
      if (label) label.textContent = idleLabel;
    }, 1800);
  });
}

function initShare() {
  // the app itself: a recommendation shouldn't carry this player's settings
  initShareButton($('share'), () => ({ url: new URL('./', location.href).href }), () => 'Share this app');
  // The rhythm comes with the settings that make it sound as built: the same
  // link as the card's, shared from where the rhythm is made.
  const setup = () => ({ url: new URL(writeLink(state), location.href).href, text: shareText() });
  initShareButton($('setup-share'), setup, setupShareTitle);
  initShareButton($('rhythm-share'), setup, () => 'Share this rhythm');
}

// --- Wiring ------------------------------------------------------------------------

function init() {
  initTheme();
  initInstall();
  initShare();
  loadCells();
  // a saved or linked rhythm that didn't fit gives way to the one in the grid
  if (state.groove !== null || state.rhythm) state.groove = encodeGroove(cells, signature(state.sig));
  initRhythm();

  initChips($('sigs'), SIGNATURES.map(({ id }) => ({ id, label: id })), 'sig', () => {
    // a new meter is a new grid; nothing of the old one maps onto it
    resetRhythm();
    save();
    buildBeats();
    renderEighths();
    renderTrainer();
    reconfigure(true);
  });
  initChips($('sounds'), SOUNDS, 'sound', () => {
    renderRhythm();
    renderEighths();
    reconfigure(false);
  }, SOUND_ICONS);

  $('eighths').addEventListener('change', (e) => {
    state.eighths = e.target.checked;
    // until there is a rhythm of one's own, the grid shows what the kit plays
    if (!state.groove) loadCells();
    save();
    renderEighths();
    reconfigure(false);
  });
  $('swing').addEventListener('change', (e) => {
    state.swing = e.target.checked;
    save();
    reconfigure(false);
  });
  $('volume').value = state.volume;
  $('volume').style.setProperty('--pct', `${state.volume}%`);
  engine.setVolume(state.volume / 100);
  $('volume').addEventListener('input', (e) => {
    state.volume = Number(e.target.value);
    e.target.style.setProperty('--pct', `${state.volume}%`);
    engine.setVolume(state.volume / 100);
    save();
  });

  initStepper($('bars'), {
    key: 'bars', min: 1, max: BARS_MAX, format: phraseText,
    onChange() {
      resizeRhythm();
      save();
      buildPhrase();
      renderBarCount(null);
      renderTrainer();
      reconfigure(true);
    },
  });
  // Its value is the dial's own bar count, so the control reads as part of it.
  const barCount = $('bars').querySelector('output');
  barCount.id = 'bar-count';
  barCount.className = 'bar-count';
  const trainerChanged = () => { renderTrainer(); reconfigure(false); };
  initStepper($('step'), { key: 'step', min: 1, max: STEP_MAX, format: (n) => `+${n}`, caption: 'step', onChange: trainerChanged });
  initStepper($('target'), { key: 'target', min: TEMPO_MIN, max: TEMPO_MAX, format: String, caption: 'up to', onChange: trainerChanged });
  $('trainer').addEventListener('click', () => {
    state.trainer = !state.trainer;
    save();
    trainerChanged();
  });
  $('restart').addEventListener('click', restartClimb);

  $('tempo').min = TEMPO_MIN;
  $('tempo').max = TEMPO_MAX;
  $('tempo').addEventListener('input', (e) => setTempo(e.target.value));
  holdRepeat($('tempo-down'), () => setTempo(shownTempo() - 1));
  holdRepeat($('tempo-up'), () => setTempo(shownTempo() + 1));

  const bpm = $('bpm');
  bpm.addEventListener('focus', () => bpm.select());
  bpm.addEventListener('input', () => { bpm.value = bpm.value.replace(/\D/g, ''); });
  bpm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') bpm.blur();
    if (e.key === 'Escape') { bpm.value = shownTempo(); bpm.blur(); }
  });
  bpm.addEventListener('blur', () => setTempo(bpm.value === '' ? shownTempo() : bpm.value));

  $('toggle').addEventListener('click', () => (engine.running ? stop() : start()));
  // pointerdown, not click: a tap should be read when the finger lands
  $('tap').addEventListener('pointerdown', (e) => { if (e.button === 0) tap(); });
  $('tap').addEventListener('click', (e) => { if (e.detail === 0) tap(); });
  $('view').addEventListener('click', flipView);
  // While a switch animates, its overlay takes every press, and the real button
  // already sits where the switch is still heading; a press on its path counts.
  document.addEventListener('click', (e) => {
    const p = switchPath;
    if (!viewSwitch || !p || e.target !== document.documentElement) return;
    if (e.clientX >= p.left && e.clientX <= p.right && e.clientY >= p.top && e.clientY <= p.bottom) flipView();
  });

  // Space belongs to the transport wherever the focus is — after picking a
  // meter, the chip still has it — so the key is kept from the focused control
  // on both edges: buttons click on keyup.
  const spaceIsOurs = (e) => e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey &&
    !e.target.closest('#bpm, #theme-cbx');
  document.addEventListener('keyup', (e) => { if (spaceIsOurs(e)) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if (spaceIsOurs(e)) {
      e.preventDefault();
      if (!e.repeat) (engine.running ? stop() : start());
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, #theme-cbx, dialog')) return;
    const nudge = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (nudge) {
      e.preventDefault();
      setTempo(shownTempo() + nudge * (e.shiftKey ? 5 : 1));
    } else if (e.key.toLowerCase() === 't' && !e.repeat) {
      tap();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !engine.running) return;
    engine.wake();
    holdScreen(true);   // the lock is dropped whenever the page is hidden
  });

  buildPhrase();
  buildBeats();
  renderView();
  renderTempo();
  renderRhythm();
  renderEighths();
  renderTrainer();
  renderBarCount(null);
  renderTransport();
  engine.configure(engineCfg());
  save();
}

init();
