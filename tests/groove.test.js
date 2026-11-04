import test from 'node:test';
import assert from 'node:assert/strict';
import { signature } from '../src/meter.js';
import {
  PRESETS, decodeGroove, defaultGroove, encodeGroove, presetBars, presetGroove, presetsFor, resize, slotAt, slotsPerBar,
} from '../src/groove.js';

const [K, S, H, C] = [1, 2, 4, 8];

test('the default is what the kit plays on its own', () => {
  assert.deepEqual(defaultGroove(signature('4/4'), true, 1), [K | H, H, S | H, H, S | H, H, S | H, H]);
  assert.deepEqual(defaultGroove(signature('4/4'), false, 1), [K, 0, S, 0, S, 0, S, 0]);
  assert.deepEqual(defaultGroove(signature('6/8'), false, 1), [K | H, H, H, S | H, H, H]);
  assert.equal(defaultGroove(signature('3/4'), true, 4).length, 4 * 6);
});

test('a slot counts eighths through the phrase', () => {
  const sig = signature('4/4');
  assert.equal(slotAt({ bar: 0, beat: 0, sub: 0 }, sig), 0);
  assert.equal(slotAt({ bar: 1, beat: 2, sub: 1 }, sig), 8 + 5);
  assert.equal(slotAt({ bar: 1, beat: 2, sub: 0 }, signature('6/8')), 6 + 2);
});

test('a link holds the shortest repeating run of bars', () => {
  const sig = signature('4/4');
  const groove = defaultGroove(sig, true, 4);
  assert.equal(encodeGroove(groove, sig), '1.80.2a.ff.00');
  assert.deepEqual(decodeGroove('1.80.2a.ff.00', sig, 4), groove);

  // a fill in the last bar keeps all four
  const fill = [...groove];
  fill[31] |= C;
  const text = encodeGroove(fill, sig);
  assert.ok(text.startsWith('4.'));
  assert.deepEqual(decodeGroove(text, sig, 4), fill);
});

test('odd bar lengths round-trip through the hex padding', () => {
  for (const id of ['3/8', '5/8', '7/8', '7/4', '12/8']) {
    const sig = signature(id);
    const cells = Array.from({ length: 3 * slotsPerBar(sig) }, (_, i) => (i * 7 + 3) % 16);
    assert.deepEqual(decodeGroove(encodeGroove(cells, sig), sig, 3), cells, id);
  }
});

test('a rhythm of the wrong length, or garbage, does not decode', () => {
  const sig = signature('4/4');
  assert.equal(decodeGroove('1.80.2a.ff.00', signature('7/4'), 4), null);
  assert.equal(decodeGroove('1.80.2a.ff', sig, 4), null);
  assert.equal(decodeGroove('x.80.2a.ff.00', sig, 4), null);
  assert.equal(decodeGroove('1.8g.2a.ff.00', sig, 4), null);
  assert.equal(decodeGroove(null, sig, 4), null);
});

test('a longer phrase repeats the rhythm, a shorter one cuts it', () => {
  assert.deepEqual(resize([1, 2, 3], 7), [1, 2, 3, 1, 2, 3, 1]);
  assert.deepEqual(resize([1, 2, 3], 2), [1, 2]);
});

test('every preset fills whole bars of its meter on every row', () => {
  for (const p of PRESETS) {
    const per = slotsPerBar(signature(p.sig));
    for (const id of ['kick', 'snare', 'hat', 'clave']) {
      if (!p[id]) continue;
      const bars = p[id].split('|');
      assert.equal(bars.length, presetBars(p), `${p.id} ${id}`);
      assert.ok(bars.every((bar) => bar.length === per && /^[x-]+$/.test(bar)), `${p.id} ${id}`);
    }
  }
});

test('a preset repeats through the phrase', () => {
  const sig = signature('4/4');
  const son = PRESETS.find((p) => p.id === 'son32');
  const cells = presetGroove(son, sig, 4);
  assert.equal(cells.length, 32);
  assert.deepEqual(cells.slice(16), cells.slice(0, 16));
  assert.equal(cells[3] & C, C);    // the clave's second hit, on 2-and
  assert.equal(cells[1] & C, 0);
  assert.equal(presetsFor(sig).length > 0, true);
  assert.deepEqual(presetsFor(signature('5/8')), []);
});
