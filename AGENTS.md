# AGENTS.md

- Static ES-module app, no build step and no runtime dependencies: `index.html` (markup) + `styles.css` + `src/` modules. `package.json` exists only to mark ESM and hold the test script. Don't add dependencies or a bundler.
- Module boundaries: `src/meter.js` (signatures, step order, trainer curve) is pure and covered by `tests/` — keep it free of DOM and audio, and extend the tests when changing it. `src/sounds.js` synthesises the voices, `src/engine.js` schedules them, `src/app.js` is state and DOM wiring.
- Never place a beat with `setTimeout`/`setInterval`. Timers only wake the scheduler in `engine.js`; every sound is started at a time on the audio clock, and the display reads the same step events back (`drain()`), offset by `outputLatency`. Anything that must happen "on the beat" goes through those events.
- The tempo counts the signature's own unit. Eighth-note subdivisions therefore exist only over a quarter-note beat (`subsFor`); in x/8 the beats already are the eighths.
- No audio files: the app must work offline from its first visit, and a sample would have to be fetched, decoded and cached first. New sounds are synthesised in `sounds.js`. Keep simultaneous voices under full scale — kick and hi-hat land together.
- `sw.js` is network-first on purpose: with no build step nothing stamps a version into it, so a cache-first worker would pin a release until someone bumped a constant by hand. When adding a file the app needs to start, add it to `SHELL` there so a first visit is already offline-capable.
- `icons/*.png` are renders of `favicon.svg` (`rsvg-convert`); the maskable and apple-touch variants are the same drawing, smaller, on a full-bleed ground without rounded corners — the platform applies its own mask.
- Three themes (`warm`, `cool`, `dark`) on `data-theme`, tokens shared with the sibling apps (harmonica, chord charts). Raised surfaces are built once from five colour tokens (`--lamp`, `--lift`, `--sink`, `--cast`, `--edge-hi`); themes override only those colours. Anything painting `--stage-bg`/`--panel-bg` must also set `background-origin: border-box`.
- Phone first: every control is at least 44px, the dial and the start button must stay above the fold at 375×667, and nothing may scroll sideways.
- Verify in a served browser (`python3 -m http.server`). Web Audio only starts from a real user gesture — a scripted `.click()` leaves the context suspended and the display frozen on beat one.
- Match existing style: 2-space indent, semicolons, minimal comments (only the non-obvious "why").
- This repo is public and holds only the app: plain static files that any web server can serve. Never document or add deployment specifics here — no deploy scripts, no server or infrastructure configuration, and nothing about where or how the app is hosted.
- Keep `index.html`'s absolute `og:`/`twitter:` URLs on `metronome.wbou.dev` — scrapers don't run the app, so those tags can't be relative.
