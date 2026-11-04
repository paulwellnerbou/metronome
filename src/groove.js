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
];
const bit = (id) => 1 << INSTRUMENTS.findIndex((inst) => inst.id === id);
const KICK = bit('kick');
const SNARE = bit('snare');
const HAT = bit('hat');

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
export function defaultGroove(sig, eighths, bars) {
  const bar = [];
  [...sig.pattern].forEach((role) => {
    if (sig.unit === 8) {
      bar.push(HAT | (role === 'A' ? KICK : role === 'a' ? SNARE : 0));
      return;
    }
    const hat = eighths ? HAT : 0;
    bar.push((role === 'A' ? KICK : SNARE) | hat, hat);
  });
  return resize(bar, bars * bar.length);
}

// A longer phrase repeats the rhythm from its start; a shorter one cuts it.
export function resize(cells, length) {
  return Array.from({ length }, (_, i) => cells[i % cells.length] || 0);
}

// "P.k.s.h.c": the shortest run of P bars the rhythm repeats, then one hex row
// per instrument over those bars, first slot in the highest bit. A one-bar
// groove stays a short link however long the phrase is.
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
  return [period, ...rows].join('.');
}

// null for anything that isn't a rhythm in this meter.
export function decodeGroove(text, sig, bars) {
  if (typeof text !== 'string') return null;
  const [head, ...rows] = text.split('.');
  const period = Number(head);
  if (!/^\d+$/.test(head) || period < 1 || period > BARS_MAX || rows.length !== INSTRUMENTS.length) return null;
  const n = period * slotsPerBar(sig);
  const digits = Math.ceil(n / 4);
  if (!rows.every((row) => row.length === digits && /^[0-9a-f]+$/i.test(row))) return null;
  const cells = Array.from({ length: n }, (_, i) => rows.reduce((v, row, b) =>
    v | ((parseInt(row[i >> 2], 16) >> (3 - (i & 3))) & 1) << b, 0));
  return resize(cells, bars * slotsPerBar(sig));
}
