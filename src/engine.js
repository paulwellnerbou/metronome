// The clockwork. Timers are far too loose to place a beat, so they only wake
// the scheduler: each tick queues every step that falls inside the next AHEAD
// seconds on the audio clock, which is sample-accurate. The same steps are kept
// as events so the display can light them up when they sound, not when they
// were queued.

import { beatRoles, firstPos, nextPos, phraseSpan, resubdivide, stepSeconds } from './meter.js';
import { decodeSamples, fetchSamples, playStep } from './sounds.js';
import { slotAt } from './groove.js';

const TICK_MS = 25;
// How long the main thread may stall before a beat goes missing. Phones stall
// for a tenth of a second now and then; a longer queue only delays what a
// setting change is heard on, not the display.
const AHEAD = 0.3;
// A stall shorter than this is a hiccup, and the beat goes on where it would
// have been. Anything longer is a break: a frozen tab, a locked phone.
const BREAK = 2;
const LEAD_IN = 0.1;      // a fresh context needs a moment before its clock is steady
const HEADROOM = 0.85;    // kick and hi-hat land together; keep their sum under full scale
const DUCK = 0.008;
const LAST_CALL = 0.03;   // how close the first beat may come before it plays whatever is ready
const EXTRAPOLATE = 0.1;  // how far clock() may run on past the audio's last report

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
  let decoding = false;
  let fresh = false;      // nothing queued yet since the start
  let shown = 0;

  // What went wrong and when, for the diagnostics overlay: a phone can't be
  // watched from a desk, and a missing beat has three quite different causes.
  let stats = null;
  let base = null;        // the audio and wall clocks at the start
  let lastWall = 0;
  function note(what) {
    stats.incidents.unshift({ at: performance.now() - base.wall, what });
    stats.incidents.length = Math.min(stats.incidents.length, 12);
  }
  const recorded = () => cfg.sound === 'drums' && !cfg.electronic;

  function audio() {
    if (ctx) return ctx;
    // Android's default low-latency stream runs out of sound under load, which
    // drops beats. The larger buffer delays everything alike, and clock()
    // takes the delay back out for the display.
    const android = /Android/i.test(navigator.userAgent);
    ctx = new (window.AudioContext || window.webkitAudioContext)(android ? { latencyHint: 'playback' } : undefined);
    // iOS plays Web Audio in the "ambient" session, which the ring/silent
    // switch mutes. "playback" is what music apps use, and is exempt.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) { /* an unsettable session must not cost us the sound */ }
    master = output();
    return ctx;
  }

  function output() {
    const gain = ctx.createGain();
    gain.gain.value = volume * HEADROOM;
    gain.connect(ctx.destination);
    return gain;
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
    const wall = performance.now();
    const gap = wall - lastWall;
    lastWall = wall;
    stats.ticks += 1;
    stats.maxGap = Math.max(stats.maxGap, gap);
    if (gap > 150) note(`timer late: ${Math.round(gap)} ms between ticks`);
    // The audio clock jumping behind the wall clock: sound the device asked
    // for and didn't get, or a suspended context. The two clocks also drift
    // apart slowly, which is harmless, so only a jump between ticks counts.
    const stamp = ctx.getOutputTimestamp && ctx.getOutputTimestamp();
    const lag = stamp && stamp.performanceTime > 0
      ? (stamp.performanceTime - base.wall) / 1000 - (stamp.contextTime - base.ctx)
      : (wall - base.wall) / 1000 - (now - base.ctx);
    if (stats.ticks > 40 && lag - stats.lag > 0.025) {
      stats.glitches += 1;
      note(`audio clock jumped behind: ${Math.round((lag - stats.lag) * 1000)} ms`);
    }
    stats.lag = lag;
    if (ctx.state !== stats.state) { note(`audio ${ctx.state}`); stats.state = ctx.state; }
    if (nextTime < now) {
      if (fresh || now - nextTime > BREAK) {
        // Before the first beat there is no time to keep, and after a break
        // the player has stopped too: pick the beat up from here.
        if (!fresh) { stats.breaks += 1; note(`break: ${Math.round((now - nextTime) * 1000)} ms, restarted the beat`); }
        nextTime = now + LEAD_IN;
      } else {
        // Beats due during the stall can't sound on time any more, and played
        // late they'd come out as a burst. Drop them and stay on the grid, so
        // the beat still meets the player's own.
        let dropped = 0;
        while (nextTime < now) {
          nextTime += stepSeconds(pos, cfg);
          pos = nextPos(pos, cfg);
          dropped += 1;
        }
        stats.dropped += dropped;
        note(`dropped ${dropped} ${dropped === 1 ? 'beat' : 'beats'} that fell due in a stall`);
      }
    }
    // The recorded drums decode only once there is a context, i.e. on the first
    // start; the lead-in leaves time for that before the first beat.
    if (decoding && now < nextTime - LAST_CALL) return;
    while (nextTime < now + AHEAD) {
      const role = roles[pos.beat];
      playStep(ctx, master, nextTime, {
        sound: cfg.sound,
        electronic: cfg.electronic,
        role: role.role,
        group: role.group,
        offbeat: pos.sub > 0,
        unit: cfg.sig.unit,
        eighths: cfg.subs > 1,
        hits: cfg.groove ? cfg.groove[slotAt(pos, cfg.sig)] : undefined,
      });
      const dur = stepSeconds(pos, cfg);
      events.push({ ...pos, time: nextTime, dur, ...phraseSpan(pos, cfg) });
      nextTime += dur;
      pos = nextPos(pos, cfg);
      fresh = false;
    }
  }

  return {
    get running() { return running; },

    // `restart` puts a running metronome back on the first beat of the phrase:
    // a position counted in the old meter means nothing in the new one.
    configure(next, restart = false) {
      const prev = cfg;
      cfg = next;
      roles = beatRoles(cfg.sig);
      if (recorded()) {
        fetchSamples();
        if (ctx) decodeSamples(ctx);
      }
      if (!running) return;
      if (restart) {
        pos = { ...firstPos(pos.tempo), pass: pos.pass };
      } else if (prev.subs !== cfg.subs || prev.swing !== cfg.swing) {
        const moved = resubdivide(pos, prev, cfg);
        pos = moved.pos;
        nextTime += moved.shift;
      }
    },

    // Back to the first beat of the first pass. What is already queued still
    // sounds: it is under AHEAD away, and cutting it would leave a hole in the
    // beat. Its display events go, so the old pass can't report back.
    restart(tempo) {
      if (!running) return;
      pos = firstPos(tempo);
      events = [];
    },

    setTempo(tempo) {
      if (!pos) return;
      pos = { ...pos, tempo };
      // Steps already queued were timed at the old tempo, but the display must
      // not report it back: under a dragged slider it would fight the thumb.
      events.forEach((ev) => { ev.tempo = tempo; });
    },

    // One instrument of the kit, now: what a rhythm cell sounds like as it is
    // switched on. A running metronome is heard playing it anyway.
    audition(hits) {
      if (running) return;
      audio();
      wake();
      if (recorded()) decodeSamples(ctx);
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(volume * HEADROOM, ctx.currentTime);
      playStep(ctx, master, ctx.currentTime + 0.01,
        { sound: 'drums', role: '.', offbeat: false, unit: 4, electronic: cfg.electronic, hits });
    },

    setVolume(v) {
      volume = v;
      if (master) master.gain.setTargetAtTime(v * HEADROOM, ctx.currentTime, 0.01);
    },

    start(tempo) {
      audio();
      wake();
      if (recorded()) {
        decoding = true;
        decodeSamples(ctx).finally(() => { decoding = false; });
      }
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(volume * HEADROOM, ctx.currentTime);
      pos = firstPos(tempo);
      nextTime = ctx.currentTime + LEAD_IN;
      events = [];
      fresh = true;
      base = { ctx: ctx.currentTime, wall: performance.now() };
      lastWall = base.wall;
      stats = { ticks: 0, maxGap: 0, lag: 0, glitches: 0, dropped: 0, breaks: 0, state: ctx.state, incidents: [] };
      running = true;
      setTimer(true);
      tick();
    },

    stop() {
      if (!running) return;
      running = false;
      setTimer(false);
      events = [];
      // Whatever is queued inside the look-ahead would still sound, and a
      // quick restart would bring it back up. It fades out on an output of
      // its own, which is then let go.
      const queued = master;
      queued.gain.setTargetAtTime(0, ctx.currentTime, DUCK);
      setTimeout(() => queued.disconnect(), 200);
      master = output();
    },

    wake,

    // Diagnostics: the counters since the last start, and the context's own
    // figures.
    stats() {
      if (!ctx || !stats) return null;
      return {
        ...stats,
        since: (performance.now() - base.wall) / 1000,
        sampleRate: ctx.sampleRate,
        baseLatency: ctx.baseLatency,
        outputLatency: ctx.outputLatency,
      };
    },

    // The audio clock as it is heard: what was scheduled for `t` leaves the
    // speaker outputLatency later, which on Bluetooth is far from nothing.
    clock() {
      if (!ctx) return 0;
      // currentTime moves a whole audio buffer at a time, which on a phone is
      // several frames: a ring drawn from it would jerk. The output timestamp
      // pins the audio clock to the frame clock, which runs smoothly in between.
      const stamp = ctx.getOutputTimestamp && ctx.getOutputTimestamp();
      if (stamp && stamp.performanceTime > 0) {
        // Capped, so a suspended context can't be extrapolated on and on; never
        // backwards, as the next stamp can land a hair before the guess.
        const since = Math.min(EXTRAPOLATE, (performance.now() - stamp.performanceTime) / 1000);
        shown = Math.max(shown, stamp.contextTime + since);
        return shown;
      }
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
