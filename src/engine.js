// The clockwork. Timers are far too loose to place a beat, so they only wake
// the scheduler: each tick queues every step that falls inside the next AHEAD
// seconds on the audio clock, which is sample-accurate. The same steps are kept
// as events so the display can light them up when they sound, not when they
// were queued.

import { beatRoles, firstPos, nextPos, stepIndex, stepSeconds, stepsPerPhrase } from './meter.js';
import { playStep } from './sounds.js';

const TICK_MS = 25;
const AHEAD = 0.12;
const LEAD_IN = 0.1;      // a fresh context needs a moment before its clock is steady
const HEADROOM = 0.85;    // kick and hi-hat land together; keep their sum under full scale
const DUCK = 0.008;

export function createEngine() {
  let ctx = null;
  let master = null;
  let worker = null;
  let fallbackTimer = null;

  let cfg = null;
  let roles = [];
  let pos = null;
  let nextTime = 0;
  let running = false;
  let volume = 0.8;
  let events = [];

  function audio() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // iOS plays Web Audio in the "ambient" session, which the ring/silent
    // switch mutes. "playback" is what music apps use, and is exempt.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) { /* an unsettable session must not cost us the sound */ }
    master = ctx.createGain();
    master.gain.value = volume * HEADROOM;
    master.connect(ctx.destination);
    return ctx;
  }

  // Covers iOS's 'interrupted' (a call, Siri) as well as 'suspended'.
  function wake() {
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  function setTimer(on) {
    if (worker === null) {
      try {
        worker = new Worker(new URL('./tick-worker.js', import.meta.url));
        worker.onmessage = tick;
        worker.onerror = () => { worker = false; if (running) setTimer(true); };
      } catch (e) { worker = false; }
    }
    if (worker) { worker.postMessage(on ? TICK_MS : 0); return; }
    clearInterval(fallbackTimer);
    fallbackTimer = on ? setInterval(tick, TICK_MS) : null;
  }

  function tick() {
    if (!running) return;
    const now = ctx.currentTime;
    // After a stall (a suspended context, a frozen tab) the backlog would all
    // fire at once as one burst. Pick the beat up from here instead.
    if (nextTime < now) nextTime = now + LEAD_IN;
    while (nextTime < now + AHEAD) {
      const role = roles[pos.beat];
      playStep(ctx, master, nextTime, {
        sound: cfg.sound,
        role: role.role,
        group: role.group,
        offbeat: pos.sub > 0,
        unit: cfg.sig.unit,
        eighths: cfg.subs > 1,
      });
      const dur = stepSeconds(pos, cfg);
      events.push({ ...pos, time: nextTime, dur, index: stepIndex(pos, cfg), steps: stepsPerPhrase(cfg) });
      nextTime += dur;
      pos = nextPos(pos, cfg);
    }
  }

  return {
    get running() { return running; },

    // `restart` puts a running metronome back on the first beat of the phrase:
    // a position counted in the old meter means nothing in the new one.
    configure(next, restart = false) {
      cfg = next;
      roles = beatRoles(cfg.sig);
      if (running && restart) pos = { ...firstPos(pos.tempo), pass: pos.pass };
    },

    setTempo(tempo) {
      if (!pos) return;
      pos = { ...pos, tempo };
      // Steps already queued were timed at the old tempo, but the display must
      // not report it back: under a dragged slider it would fight the thumb.
      events.forEach((ev) => { ev.tempo = tempo; });
    },

    setVolume(v) {
      volume = v;
      if (master) master.gain.setTargetAtTime(v * HEADROOM, ctx.currentTime, 0.01);
    },

    start(tempo) {
      audio();
      wake();
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(volume * HEADROOM, ctx.currentTime);
      pos = firstPos(tempo);
      nextTime = ctx.currentTime + LEAD_IN;
      events = [];
      running = true;
      setTimer(true);
      tick();
    },

    stop() {
      if (!running) return;
      running = false;
      setTimer(false);
      events = [];
      // whatever is already queued inside the look-ahead would still sound
      master.gain.setTargetAtTime(0, ctx.currentTime, DUCK);
    },

    wake,

    // The audio clock as it is heard: what was scheduled for `t` leaves the
    // speaker outputLatency later, which on Bluetooth is far from nothing.
    clock() {
      if (!ctx) return 0;
      return ctx.currentTime - (ctx.outputLatency || 0);
    },

    // Steps that have sounded since the last call, oldest first.
    drain() {
      const now = this.clock();
      let n = 0;
      while (n < events.length && events[n].time <= now) n += 1;
      return events.splice(0, n);
    },
  };
}
