// A drum-kit rhythm of the player's own: which instruments hit on which eighth,
// over the whole phrase. Pure; the engine reads it step by step, the app edits
// it, and links carry it as text.

import { BARS_MAX } from './meter.js';

// Bit i of a slot is INSTRUMENTS[i].
export const INSTRUMENTS = [
  { id: 'kick', label: 'Kick' },
  { id: 'snare', label: 'Snare' },
  { id: 'hat', label: 'Hi-hat' },
  { id: 'clave', label: 'Clave' },
  { id: 'shaker', label: 'Shaker' },
];
// Links from before the shaker carry four rows; a row left off is silent.
const ROWS_MIN = 4;
const bit = (id) => 1 << INSTRUMENTS.findIndex((inst) => inst.id === id);
const KICK = bit('kick');
const SNARE = bit('snare');
const HAT = bit('hat');
const SHAKER = bit('shaker');

// The grid is in eighths: two per quarter-note beat, one per eighth-note beat.
export const slotsPerBeat = (sig) => (sig.unit === 4 ? 2 : 1);
export const slotsPerBar = (sig) => sig.beats * slotsPerBeat(sig);

// Which slot of the phrase a step plays; the engine runs with
// subs === slotsPerBeat(sig) while a rhythm is on.
export function slotAt(pos, sig) {
  return (pos.bar * sig.beats + pos.beat) * slotsPerBeat(sig) + pos.sub;
}

// What the kit plays on its own, so switching to a rhythm of one's own starts
// from what was just heard.
export function defaultGroove(sig, eighths, bars, shaker = false) {
  const bar = [];
  const fill = shaker && eighths ? SHAKER : HAT;
  [...sig.pattern].forEach((role) => {
    if (sig.unit === 8) {
      bar.push(fill | (role === 'A' ? KICK : role === 'a' ? SNARE : 0));
      return;
    }
    const hat = eighths ? fill : 0;
    bar.push((role === 'A' ? KICK : SNARE) | hat, hat);
  });
  return resize(bar, bars * bar.length);
}

// A longer phrase repeats the rhythm from its start; a shorter one cuts it.
export function resize(cells, length) {
  return Array.from({ length }, (_, i) => cells[i % cells.length] || 0);
}

// "P.k.s.h.c[.sh]": the shortest run of P bars the rhythm repeats, then one hex
// row per instrument over those bars, first slot in the highest bit. A one-bar
// groove stays a short link however long the phrase is, and empty rows past the
// first four are left off.
export function encodeGroove(cells, sig) {
  const per = slotsPerBar(sig);
  const bars = cells.length / per;
  let period = 1;
  while (period < bars && !cells.every((v, i) => v === cells[i % (period * per)])) period += 1;
  const n = period * per;
  const digits = Math.ceil(n / 4);
  const rows = INSTRUMENTS.map((_, b) => {
    let hex = '';
    for (let d = 0; d < digits; d++) {
      let nibble = 0;
      for (let k = 0; k < 4; k++) {
        const i = d * 4 + k;
        nibble = nibble * 2 + (i < n && cells[i] & (1 << b) ? 1 : 0);
      }
      hex += nibble.toString(16);
    }
    return hex;
  });
  while (rows.length > ROWS_MIN && /^0+$/.test(rows[rows.length - 1])) rows.pop();
  return [period, ...rows].join('.');
}

// null for anything that isn't a rhythm in this meter.
export function decodeGroove(text, sig, bars) {
  if (typeof text !== 'string') return null;
  const [head, ...rows] = text.split('.');
  const period = Number(head);
  if (!/^\d+$/.test(head) || period < 1 || period > BARS_MAX || rows.length < ROWS_MIN || rows.length > INSTRUMENTS.length) return null;
  const n = period * slotsPerBar(sig);
  const digits = Math.ceil(n / 4);
  if (!rows.every((row) => row.length === digits && /^[0-9a-f]+$/i.test(row))) return null;
  const cells = Array.from({ length: n }, (_, i) => rows.reduce((v, row, b) =>
    v | ((parseInt(row[i >> 2], 16) >> (3 - (i & 3))) & 1) << b, 0));
  return resize(cells, bars * slotsPerBar(sig));
}

// Grooves to start from, one row of eighths per instrument, bars split by '|'.
// Clave patterns run over two bars of eighths, the way they are counted in 2/2.
export const PRESETS = [
  { id: 'rock', label: 'Rock', sig: '4/4',
    kick: 'x---x---', snare: '--x---x-', hat: 'xxxxxxxx' },
  { id: 'pop', label: 'Pop', sig: '4/4',
    kick: 'x--xx---', snare: '--x---x-', hat: 'xxxxxxxx' },
  { id: 'four', label: 'Four on the floor', sig: '4/4',
    kick: 'x-x-x-x-', snare: '--x---x-', hat: '-x-x-x-x' },
  { id: 'half', label: 'Half-time', sig: '4/4',
    kick: 'x-----x-', snare: '----x---', hat: 'xxxxxxxx' },
  // 3+3+2 on the kit: kick, kick, snare. A kick on 3 would land in its gap.
  { id: 'tresillo', label: 'Tresillo', sig: '4/4',
    kick: 'x--x----', snare: '------x-', hat: 'x-x-x-x-' },
  { id: 'son32', label: 'Son clave 3-2', sig: '4/4',
    kick: 'x-------|x-------', shaker: 'x-x-x-x-|x-x-x-x-', clave: 'x--x--x-|--x-x---' },
  { id: 'son23', label: 'Son clave 2-3', sig: '4/4',
    kick: 'x-------|x-------', shaker: 'x-x-x-x-|x-x-x-x-', clave: '--x-x---|x--x--x-' },
  { id: 'rumba', label: 'Rumba clave', sig: '4/4',
    kick: 'x-------|x-------', shaker: 'x-x-x-x-|x-x-x-x-', clave: 'x--x---x|--x-x---' },
  { id: 'bossa', label: 'Bossa nova', sig: '4/4',
    kick: 'x--xx--x|x--xx--x', shaker: 'xxxxxxxx|xxxxxxxx', clave: 'x--x--x-|--x--x--' },
  // The bass of son plays the tumbao, anticipating the chord on 2-and and 4;
  // the hi-hat stands in for the maracas.
  { id: 'son', label: 'Son tumbao (Chan Chan)', sig: '4/4',
    kick: '---x--x-|---x--x-', shaker: 'xxxxxxxx|xxxxxxxx', clave: 'x--x--x-|--x-x---' },
  { id: 'onedrop', label: 'Reggae one drop', sig: '4/4',
    kick: '----x---', snare: '----x---', hat: 'xxxxxxxx' },
  // the snare on all four beats, as on many Motown records
  { id: 'motown', label: 'Motown backbeat', sig: '4/4',
    kick: 'x---x---', snare: 'x-x-x-x-', hat: 'xxxxxxxx' },
  { id: 'stomp', label: 'We Will Rock You', sig: '4/4',
    kick: 'xx--xx--', snare: '--x---x-' },
  // Kick on every beat, snare on 2-and and 4: with the one, the accents fall
  // as a tresillo.
  { id: 'setfire', label: 'Set Fire to the Rain', sig: '4/4',
    kick: 'x-x-x-x-', snare: '---x--x-', hat: 'xxxxxxxx' },
  // 3+3+2+2 eighths: two long notes, two short ones.
  { id: 'mission', label: 'Mission: Impossible', sig: '5/4',
    kick: 'x--x------', snare: '------x-x-', hat: 'x-x-x-x-x-' },
  { id: 'waltz', label: 'Waltz', sig: '3/4',
    kick: 'x-----', snare: '--x-x-', hat: 'x-x-x-' },
  { id: 'ballad68', label: '6/8 groove', sig: '6/8',
    kick: 'x-----', snare: '---x--', hat: 'xxxxxx' },
  { id: 'bembe', label: 'Bembé bell', sig: '12/8',
    kick: 'x--x--x--x--', clave: 'x-x-xx-x-x-x' },
  { id: 'blues128', label: 'Slow blues', sig: '12/8',
    kick: 'x-----x-----', snare: '---x-----x--', hat: 'xxxxxxxxxxxx' },
];

export const presetsFor = (sig) => PRESETS.filter((p) => p.sig === sig.id);
export const presetBars = (preset) => preset.kick.split('|').length;

export function presetGroove(preset, sig, bars) {
  const per = slotsPerBar(sig);
  const cells = new Array(presetBars(preset) * per).fill(0);
  INSTRUMENTS.forEach(({ id }, b) => {
    [...(preset[id] || '').replace(/\|/g, '')].forEach((c, i) => { if (c === 'x') cells[i] |= 1 << b; });
  });
  return resize(cells, bars * per);
}
