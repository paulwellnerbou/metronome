import test from 'node:test';
import assert from 'node:assert/strict';
import { readLink, writeLink } from '../src/link.js';

const setup = {
  tempo: 94, sig: '6/8', sound: 'drums', eighths: true, swing: false,
  bars: 4, trainer: true, step: 5, target: 140, rhythm: false, volume: 30, view: 'bar',
};

test('a link round-trips the exercise and nothing personal', () => {
  const link = writeLink(setup);
  assert.equal(link, '?bpm=94&sig=6/8&sound=drums&eighths=1&swing=0&bars=4&trainer=1&rhythm=0&step=5&target=140');
  const { volume, view, ...exercise } = setup;
  assert.deepEqual(readLink(link), exercise);
});

test('an idle trainer leaves its step and target out', () => {
  const link = writeLink({ ...setup, trainer: false });
  assert.ok(!link.includes('step=') && !link.includes('target='));
  assert.equal(readLink(link).trainer, false);
});

test('a hand-written link sets only what it names', () => {
  assert.deepEqual(readLink('?bpm=120'), { tempo: 120 });
  assert.deepEqual(readLink('?sig=7-8&swing=true'), { sig: '7/8', swing: true });
  assert.deepEqual(readLink(''), {});
  // a slash escaped by some other tool still reads
  assert.equal(readLink('?sig=3%2F4').sig, '3/4');
});

test('empty or non-numeric values are dropped, not passed on as a reset', () => {
  assert.deepEqual(readLink('?bpm=&bars= &step=fast'), {});
});

test('a custom rhythm travels with the drum kit only', () => {
  const groove = '1.80.2a.ff.00';
  const link = writeLink({ ...setup, sig: '4/4', rhythm: true, groove });
  assert.ok(link.includes(`rhythm=${groove}`));
  assert.deepEqual(readLink(link).groove, groove);
  assert.equal(readLink(link).rhythm, true);
  // another sound plays no rhythm, so none goes out, and the visitor's stays theirs
  const click = readLink(writeLink({ ...setup, sound: 'click', rhythm: true, groove }));
  assert.equal(click.rhythm, false);
  assert.ok(!('groove' in click));
});
