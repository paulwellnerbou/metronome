// Feature logic and DOM wiring. The timing model is meter.js, the clockwork
// engine.js; this file only turns settings into a config for them and paints
// what they report back.

import {
  BARS_MAX, SIGNATURES, TEMPO_MAX, TEMPO_MIN,
  beatRoles, clampTempo, signature, subsFor, tempoMarking, trainerPlan, trainerTempo,
} from './meter.js';
import { SOUNDS } from './sounds.js';
import { createEngine } from './engine.js';

const $ = (id) => document.getElementById(id);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// --- State -----------------------------------------------------------------

const STORE = 'metronome-state';
const DEFAULTS = {
  tempo: 100, sig: '4/4', sound: 'click', eighths: false, bars: 4,
  trainer: false, step: 5, target: 140, view: 'ring', volume: 80,
};
const STEP_MAX = 30;

function loadState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { /* private mode, or not ours */ }
  const int = (v, min, max, fallback) => (Number.isFinite(v) ? clamp(Math.round(v), min, max) : fallback);
  return {
    tempo: int(saved.tempo, TEMPO_MIN, TEMPO_MAX, DEFAULTS.tempo),
    sig: signature(saved.sig).id,
    sound: SOUNDS.some((s) => s.id === saved.sound) ? saved.sound : DEFAULTS.sound,
    eighths: saved.eighths === true,
    bars: int(saved.bars, 1, BARS_MAX, DEFAULTS.bars),
    trainer: saved.trainer === true,
    step: int(saved.step, 1, STEP_MAX, DEFAULTS.step),
    target: int(saved.target, TEMPO_MIN, TEMPO_MAX, DEFAULTS.target),
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
}

function engineCfg() {
  const sig = signature(state.sig);
  return {
    sig,
    subs: subsFor(sig, state.eighths),
    bars: state.bars,
    sound: state.sound,
    trainer: { on: state.trainer, step: state.step, target: state.target },
  };
}

// --- Display: ring, beats, phrase -------------------------------------------

const RING_C = 160;
const RING_R = 142;
const display = $('display');
let ringFills = [];
let ringSpans = [];   // [startDeg, endDeg] per bar, for the playhead
let playhead = null;
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
  }).join('') + '<circle class="playhead" r="7"/>';
  ringFills = [...$('ring').querySelectorAll('.seg-fill')];
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

function paintProgress(p) {
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
  if (step.tempo !== shownTempo()) {
    live = step.tempo;
    renderTempo();
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
    paintProgress((lastStep.index + into) / lastStep.steps);
  }
  requestAnimationFrame(frame);
}

function renderBarCount(step) {
  const n = state.bars;
  $('bar-count').textContent = step
    ? `Bar ${step.bar + 1} of ${n}`
    : `${n} ${n === 1 ? 'bar' : 'bars'} per phrase`;
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
  if (taps.length > 1) setTempo(60000 * (taps.length - 1) / (now - taps[0]));
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

function initStepper(el, { key, min, max, format, onChange }) {
  el.innerHTML =
    '<button type="button" class="step-btn" data-dir="-1" aria-label="Less">&minus;</button>' +
    '<output class="step-val"></output>' +
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

function initChips(container, items, key, onChange) {
  container.innerHTML = items.map(({ id, label }) =>
    `<button type="button" class="chip" role="radio" data-id="${id}">${label}</button>`).join('');
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
  const input = $('eighths');
  const drums = state.sound === 'drums';
  const fixed = signature(state.sig).unit === 8;
  input.disabled = fixed;
  input.checked = fixed ? drums : state.eighths;
  input.closest('.switch').classList.toggle('is-fixed', fixed);
  $('eighths-text').textContent = drums ? 'Hi-hat on eighths' : 'Eighth-note ticks';
}

const clock = (seconds) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function renderTrainer() {
  $('trainer-body').inert = !state.trainer;
  const cfg = engineCfg();
  // planned as if switched on: the dimmed panel previews the climb, and with
  // the real flag an idle trainer reads as one that has nothing left to do
  const { passes, seconds } = trainerPlan(state.tempo, { ...cfg, trainer: { ...cfg.trainer, on: true } });
  $('trainer-plan').textContent = passes
    ? `${state.tempo} → ${state.target} BPM takes ${passes} ${passes === 1 ? 'phrase' : 'phrases'}, about ${clock(seconds)}. Then it holds.`
    : `Already at ${state.tempo} BPM — set a higher target, or a slower tempo to start from.`;
  renderStatus(engine.running ? lastStep : null);
}

function renderStatus(step) {
  const el = $('trainer-status');
  el.hidden = !state.trainer;
  if (!state.trainer) return;
  const tempo = shownTempo();
  const next = trainerTempo(tempo, engineCfg().trainer);
  if (!step) el.textContent = next > tempo ? `Trainer: ${tempo} → ${state.target} BPM, +${state.step} per phrase` : `Trainer: already at ${state.target} BPM`;
  else if (next > tempo) el.textContent = `Phrase ${step.pass + 1} · next ${next} BPM`;
  else el.textContent = `Holding at ${tempo} BPM`;
}

function renderView() {
  display.dataset.view = state.view;
  $('view').dataset.view = state.view;
  $('view-label').textContent = state.view === 'ring' ? 'Ring' : 'Bar';
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
  display.classList.toggle('running', on);
}

function start() {
  live = state.tempo;
  lastStep = null;
  engine.configure(engineCfg());
  engine.start(state.tempo);
  holdScreen(true);
  renderTransport();
  requestAnimationFrame(frame);
}

function stop() {
  engine.stop();
  holdScreen(false);
  live = null;
  lastStep = null;
  beatEls.forEach((el) => el.classList.remove('on', 'hit'));
  display.classList.remove('pulse', 'lap', 'accent');
  paintProgress(0);
  renderTransport();
  renderTempo();
  renderBarCount(null);
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

// --- Wiring ------------------------------------------------------------------------

function init() {
  initTheme();
  initInstall();

  initChips($('sigs'), SIGNATURES.map(({ id }) => ({ id, label: id })), 'sig', () => {
    buildBeats();
    renderEighths();
    renderTrainer();
    reconfigure(true);
  });
  initChips($('sounds'), SOUNDS, 'sound', () => {
    renderEighths();
    reconfigure(false);
  });

  $('eighths').addEventListener('change', (e) => {
    state.eighths = e.target.checked;
    save();
    reconfigure(true);
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
    key: 'bars', min: 1, max: BARS_MAX, format: String,
    onChange() {
      buildPhrase();
      renderBarCount(null);
      renderTrainer();
      reconfigure(true);
    },
  });
  const trainerChanged = () => { renderTrainer(); reconfigure(false); };
  initStepper($('step'), { key: 'step', min: 1, max: STEP_MAX, format: (n) => `+${n} BPM`, onChange: trainerChanged });
  initStepper($('target'), { key: 'target', min: TEMPO_MIN, max: TEMPO_MAX, format: (n) => `${n} BPM`, onChange: trainerChanged });
  $('trainer').checked = state.trainer;
  $('trainer').addEventListener('change', (e) => {
    state.trainer = e.target.checked;
    save();
    trainerChanged();
  });

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
  $('view').addEventListener('click', () => {
    state.view = state.view === 'ring' ? 'bar' : 'ring';
    save();
    renderView();
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
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, #theme-cbx')) return;
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
  renderEighths();
  renderTrainer();
  renderBarCount(null);
  renderTransport();
  engine.configure(engineCfg());
}

init();
