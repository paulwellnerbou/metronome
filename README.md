# Metronome & speed trainer

A single-page metronome that runs in the browser and installs as an app: click, drum kit, claves or beep in twelve time signatures, a display that counts the bars of a phrase, and a speed trainer that raises the tempo phrase by phrase.

Live at [metronome.wbou.dev](https://metronome.wbou.dev/).

## Features

- **Tempo** from 30 to 300 BPM: slider, ±1 buttons (hold to run), type it into the dial, or tap it.
- **Time signatures**: 2/4 to 7/4 and 3/8 to 12/8. The tempo counts the signature's own beat, so 6/8 at 180 ticks six eighths at 180. The odd meters are grouped the usual way (5 = 3+2, 7 = 2+2+3), and the beat display shows the groups.
- **Sounds**, all with a different first beat:
  - *Click* — a woodblock pair, toc-tic-tic-tic.
  - *Drum kit* — kick on the one, snare on the backbeat; hi-hats on the eighths are optional. In the eighth-note meters the hi-hat carries every eighth and the snare answers from the second group, so 6/8 and 12/8 come out as the shuffle they are.
  - *Claves* — a high clave on the one, a lower one after it.
  - *Beep* — the electronic metronome's two pips.
- **Phrase display**: a ring (or, switchable, a horizontal strip with large beat lamps) with one segment per bar. It fills as the bars pass and flashes when the phrase comes round. Bars per phrase is configurable from 1 to 32.
- **Speed trainer**: after every phrase the tempo goes up by a set amount until it reaches a target, then holds. The panel says how many phrases and how long that takes. Stopping returns to the tempo you started from.
- **Installable, offline**: a web app manifest and a service worker — add it to the home screen and it works without a connection. The screen stays awake while it plays.
- Three themes, settings remembered in the browser, keyboard control (<kbd>Space</kbd>, arrows, <kbd>T</kbd>).

## Sound

Nothing is sampled. Every hit is synthesised with Web Audio at the moment it is scheduled — a few decaying oscillators and bursts of filtered noise — so there are no audio files to load or to cache.

Timing does not depend on JavaScript timers. A worker wakes the scheduler every 25 ms, and the scheduler places each step that falls inside the next 120 ms on the audio clock, which is sample-accurate. The display is driven from the same steps, shifted by the output latency, so the lamp lights when the click is heard rather than when it was queued.

## Run locally

Static files, no build step — but ES modules and the service worker need a server (`file://` won't work):

    python3 -m http.server

then open `http://localhost:8000`. Tests for the timing model:

    npm test

## Code layout

- `index.html` — markup only
- `styles.css` — styles
- `src/meter.js` — time signatures, the order steps are played in, the trainer's tempo curve (pure, tested)
- `src/sounds.js` — the synthesised voices
- `src/engine.js` — the look-ahead scheduler on the audio clock
- `src/tick-worker.js` — the scheduler's heartbeat, in a worker so background tabs don't throttle it
- `src/app.js` — state, DOM wiring, the display
- `sw.js`, `manifest.webmanifest`, `icons/` — the installable shell

## Hosting

Plain static files with no build step — serve the repo root over HTTPS (a service worker needs it) with any web server. Every path is relative, so a subdirectory works too.
