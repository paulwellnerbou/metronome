import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNATURES, beatRoles, clampTempo, firstPos, nextPos, phraseSpan, resubdivide, signature,
  stepSeconds, subsFor, tempoMarking, trainerPlan, trainerTempo,
} from '../src/meter.js';

const cfg = (over = {}) => ({
  sig: signature('4/4'), subs: 1, bars: 2,
  trainer: { on: false, step: 5, target: 120 },
  ...over,
});

function walk(pos, c, steps) {
  const seen = [];
  for (let i = 0; i < steps; i++) { seen.push(pos); pos = nextPos(pos, c); }
  return { seen, pos };
}

test('every signature has one role per beat and starts on the downbeat', () => {
  for (const sig of SIGNATURES) {
    assert.equal(sig.pattern.length, sig.beats, sig.id);
    assert.equal(sig.pattern[0], 'A', sig.id);
    assert.equal([...sig.pattern].filter((r) => r === 'A').length, 1, sig.id);
  }
});

test('an unknown signature falls back to 4/4', () => {
  assert.equal(signature('13/16').id, '4/4');
  assert.equal(signature(undefined).id, '4/4');
});

test('beat roles number the groups', () => {
  assert.deepEqual(beatRoles(signature('7/8')).map((r) => r.group), [0, 0, 1, 1, 2, 2, 2]);
  assert.deepEqual(beatRoles(signature('12/8')).filter((r) => r.role !== '.').map((r) => r.group), [0, 1, 2, 3]);
});

test('eighth subdivisions exist only over a quarter-note beat', () => {
  assert.equal(subsFor(signature('4/4'), true), 2);
  assert.equal(subsFor(signature('4/4'), false), 1);
  assert.equal(subsFor(signature('6/8'), true), 1);
});

test('a phrase walks beats, then bars, then wraps into the next pass', () => {
  const c = cfg();
  const { seen, pos } = walk(firstPos(100), c, 8);
  assert.deepEqual(seen.map((p) => `${p.bar}.${p.beat}`), ['0.0', '0.1', '0.2', '0.3', '1.0', '1.1', '1.2', '1.3']);
  assert.deepEqual(seen.map((p) => phraseSpan(p, c).at * 8), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pos, { beat: 0, sub: 0, bar: 0, pass: 1, tempo: 100 });
});

test('subdivisions halve the step and double the steps', () => {
  const c = cfg({ subs: 2, bars: 1 });
  assert.equal(phraseSpan(firstPos(120), c).span, 1 / 8);
  assert.equal(stepSeconds(firstPos(120), c), 0.25);
  const { seen } = walk(firstPos(120), c, 4);
  assert.deepEqual(seen.map((p) => `${p.beat}+${p.sub}`), ['0+0', '0+1', '1+0', '1+1']);
});

test('swing splits the beat 2:1 and keeps its length', () => {
  const c = cfg({ subs: 2, swing: true, bars: 1 });
  const on = firstPos(120);
  const off = { ...on, sub: 1 };
  assert.equal(stepSeconds(on, c) + stepSeconds(off, c), 0.5);
  assert.ok(Math.abs(stepSeconds(on, c) - 1 / 3) < 1e-12);
  assert.ok(Math.abs(phraseSpan(off, c).at - 2 / 3 / 4) < 1e-12);
  // without eighths there is nothing to swing
  assert.equal(stepSeconds(on, cfg({ subs: 1, swing: true })), 0.5);
});

test('switching eighths mid-run keeps the beat, skipping a vanished off-beat', () => {
  const eighths = cfg({ subs: 2 });
  const quarters = cfg({ subs: 1 });
  const onBeat = { beat: 2, sub: 0, bar: 0, pass: 0, tempo: 120 };
  assert.deepEqual(resubdivide(onBeat, eighths, quarters), { pos: onBeat, shift: 0 });
  assert.deepEqual(resubdivide(onBeat, quarters, eighths), { pos: onBeat, shift: 0 });

  const offBeat = { beat: 2, sub: 1, bar: 0, pass: 0, tempo: 120 };
  assert.deepEqual(resubdivide(offBeat, eighths, quarters),
    { pos: { beat: 3, sub: 0, bar: 0, pass: 0, tempo: 120 }, shift: 0.25 });

  // the phrase's last off-beat rolls into the next pass, trainer step included
  const climbing = (subs) => cfg({ subs, bars: 1, trainer: { on: true, step: 5, target: 140 } });
  const lastOff = { beat: 3, sub: 1, bar: 0, pass: 0, tempo: 120 };
  assert.deepEqual(resubdivide(lastOff, climbing(2), climbing(1)).pos,
    { beat: 0, sub: 0, bar: 0, pass: 1, tempo: 125 });
});

test('switching swing mid-run moves a pending off-beat, never earlier', () => {
  const straight = cfg({ subs: 2 });
  const swung = cfg({ subs: 2, swing: true });
  const offBeat = { beat: 1, sub: 1, bar: 0, pass: 0, tempo: 120 };
  const later = resubdivide(offBeat, straight, swung);
  assert.equal(later.pos, offBeat);
  assert.ok(Math.abs(later.shift - (2 / 3 - 1 / 2) * 0.5) < 1e-12);
  // back to straight it would land before the planned time: on to the next beat
  const earlier = resubdivide(offBeat, swung, straight);
  assert.deepEqual(earlier.pos, { beat: 2, sub: 0, bar: 0, pass: 0, tempo: 120 });
  assert.ok(Math.abs(earlier.shift - 0.5 / 3) < 1e-12);
});

test('the trainer raises the tempo only at the phrase boundary', () => {
  const c = cfg({ trainer: { on: true, step: 5, target: 120 } });
  const { seen, pos } = walk(firstPos(100), c, 8);
  assert.ok(seen.every((p) => p.tempo === 100));
  assert.equal(pos.tempo, 105);
});

test('the trainer lands on the target and holds there', () => {
  const trainer = { on: true, step: 7, target: 120 };
  assert.equal(trainerTempo(116, trainer), 120);
  assert.equal(trainerTempo(120, trainer), 120);
  assert.equal(trainerTempo(150, trainer), 150);
  assert.equal(trainerTempo(100, { ...trainer, on: false }), 100);
});

test('the trainer plan counts the phrases below the target', () => {
  const c = cfg({ bars: 4, trainer: { on: true, step: 10, target: 120 } });
  const plan = trainerPlan(100, c);
  assert.equal(plan.passes, 2);   // one at 100, one at 110
  assert.ok(Math.abs(plan.seconds - (16 * 60 / 100 + 16 * 60 / 110)) < 1e-9);
  assert.deepEqual(trainerPlan(120, c), { passes: 0, seconds: 0 });
  assert.deepEqual(trainerPlan(100, cfg({ trainer: { on: true, step: 0, target: 120 } })), { passes: 0, seconds: 0 });
});

test('tempo input is rounded, clamped, and rejected when it is not a number', () => {
  assert.equal(clampTempo('119.6'), 120);
  assert.equal(clampTempo(5), 30);
  assert.equal(clampTempo(999), 300);
  assert.equal(clampTempo('fast'), null);
});

test('tempo markings', () => {
  assert.equal(tempoMarking(50), 'Largo');
  assert.equal(tempoMarking(100), 'Andante');
  assert.equal(tempoMarking(120), 'Allegro');
  assert.equal(tempoMarking(240), 'Prestissimo');
});
