import { test, assert, assertClose } from './run.js';
import { parseMidi, midiToSong, defaultEnabled } from '../docs/js/midi.js';

// --- Helpers ---

// Tiny big-endian byte-packer for handwritten MIDI fixtures.
class Builder {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); return this; }
  u16(v) { this.u8(v >> 8); this.u8(v); return this; }
  u32(v) { this.u8(v >> 24); this.u8(v >> 16); this.u8(v >> 8); this.u8(v); return this; }
  str(s) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  raw(a) { for (const v of a) this.u8(v); return this; }
  // Variable-length quantity per SMF.
  vlq(v) {
    const buf = [v & 0x7f];
    v >>>= 7;
    while (v > 0) { buf.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    this.raw(buf);
    return this;
  }
  buf() {
    const ab = new ArrayBuffer(this.bytes.length);
    const u = new Uint8Array(ab);
    for (let i = 0; i < this.bytes.length; i++) u[i] = this.bytes[i];
    return ab;
  }
}

// Build a minimal Format-1 MIDI with a conductor track (tempo + time-sig)
// and one musical track containing the given notes. Each `note` is
// `{ tick, dur, pitch, vel, ch }`.
function buildSmf({ tempoUs = 500000, tpq = 480, trackName = 'Test', notes = [] }) {
  const b = new Builder();
  b.str('MThd').u32(6).u16(1).u16(2).u16(tpq);

  // Conductor track: time sig 4/4, tempo, end-of-track.
  const cond = new Builder();
  cond.vlq(0).raw([0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]); // time sig 4/4
  cond.vlq(0).raw([0xff, 0x51, 0x03,
    (tempoUs >> 16) & 0xff, (tempoUs >> 8) & 0xff, tempoUs & 0xff]);
  cond.vlq(0).raw([0xff, 0x2f, 0x00]); // end-of-track
  b.str('MTrk').u32(cond.bytes.length).raw(cond.bytes);

  // Music track.
  const tr = new Builder();
  tr.vlq(0).raw([0xff, 0x03, trackName.length]).str(trackName); // track name
  // Sort notes by start tick so delta-times are non-negative.
  const evts = [];
  for (const n of notes) {
    evts.push({ tick: n.tick, type: 'on', n });
    evts.push({ tick: n.tick + n.dur, type: 'off', n });
  }
  evts.sort((a, b) => a.tick - b.tick ||
    (a.type === 'on' ? 1 : -1) - (b.type === 'on' ? 1 : -1));
  let prevTick = 0;
  for (const e of evts) {
    tr.vlq(e.tick - prevTick);
    prevTick = e.tick;
    const ch = e.n.ch ?? 0;
    if (e.type === 'on') tr.u8(0x90 | ch).u8(e.n.pitch).u8(e.n.vel ?? 100);
    else tr.u8(0x80 | ch).u8(e.n.pitch).u8(0);
  }
  tr.vlq(0).raw([0xff, 0x2f, 0x00]);
  b.str('MTrk').u32(tr.bytes.length).raw(tr.bytes);

  return b.buf();
}

// --- Parser tests ---

test('midi: parses header, tempo, and track name', () => {
  const buf = buildSmf({ tempoUs: 500000, tpq: 480, trackName: 'HelloTrack',
    notes: [{ tick: 0, dur: 240, pitch: 60 }] });
  const m = parseMidi(buf);
  assert(m.format === 1, 'format 1');
  assert(m.ticksPerQuarter === 480, 'tpq');
  assert(m.tempoMap.length >= 1, 'tempo map populated');
  assertClose(m.tempoMap[m.tempoMap.length - 1].tempoUs, 500000, 0.5);
  assert(m.tracks.length === 2, '2 tracks total (conductor + music)');
  const music = m.tracks.find(t => t.name === 'HelloTrack');
  assert(music, 'track name preserved');
  assert(music.noteCount === 1, 'one note in music track');
  assert(music.notes[0].pitch === 60, 'correct pitch');
});

test('midi: pairs note-on/off across running status', () => {
  const buf = buildSmf({ notes: [
    { tick: 0,   dur: 240, pitch: 60, vel: 100 },
    { tick: 240, dur: 240, pitch: 62, vel: 110 },
    { tick: 480, dur: 120, pitch: 64, vel: 120 },
  ] });
  const m = parseMidi(buf);
  const music = m.tracks.find(t => t.noteCount >= 3);
  assert(music, 'music track found');
  const pitches = music.notes.map(n => n.pitch);
  assert(JSON.stringify(pitches) === JSON.stringify([60, 62, 64]), 'ordered pitches');
  assert(music.notes[0].endTick === 240, 'first note off at 240');
  assert(music.notes[2].endTick === 600, 'third note off at 600');
});

test('midi: tempo map converts ticks → seconds', () => {
  // 500000 µs/quarter at 480 tpq → 1 quarter = 0.5s.
  const buf = buildSmf({ tempoUs: 500000, tpq: 480, notes: [
    { tick: 0,   dur: 480, pitch: 60 }, // 1 quarter → 0.5s
    { tick: 960, dur: 480, pitch: 64 }, // starts at 2 quarters = 1.0s
  ] });
  const m = parseMidi(buf);
  const song = midiToSong(m, { enabledTracks: new Set([1]) });
  const notes = song.notes;
  assert(notes.length === 2, '2 notes');
  assertClose(notes[0].time, 0, 1e-3);
  assertClose(notes[0].dur, 0.5, 1e-3);
  assertClose(notes[1].time, 1.0, 1e-3);
  assertClose(notes[1].dur, 0.5, 1e-3);
});

test('midi: drum channel (10, zero-indexed 9) is off by default', () => {
  // Build a Format-0 file with events on ch0 and ch9 so splitting
  // produces two virtual tracks.
  const b = new Builder();
  b.str('MThd').u32(6).u16(0).u16(1).u16(480);
  const tr = new Builder();
  // Note on/off on ch0 (pitched) and ch9 (drums).
  tr.vlq(0).u8(0x90).u8(60).u8(100);
  tr.vlq(240).u8(0x80).u8(60).u8(0);
  tr.vlq(0).u8(0x99).u8(42).u8(100);
  tr.vlq(240).u8(0x89).u8(42).u8(0);
  tr.vlq(0).raw([0xff, 0x2f, 0x00]);
  b.str('MTrk').u32(tr.bytes.length).raw(tr.bytes);
  const m = parseMidi(b.buf());
  const enabled = defaultEnabled(m);
  const drumTrack = m.tracks.find(t => t.channel === 9);
  assert(drumTrack, 'drum virtual track exists');
  assert(!enabled.has(drumTrack.index), 'drum track disabled by default');
});

test('midi: converts to Chromavox song JSON', () => {
  const buf = buildSmf({ notes: [
    { tick: 0,   dur: 240, pitch: 60, vel: 100 }, // C4
    { tick: 240, dur: 240, pitch: 64, vel: 100 }, // E4
    { tick: 480, dur: 240, pitch: 67, vel: 100 }, // G4
  ] });
  const m = parseMidi(buf);
  const song = midiToSong(m, { enabledTracks: new Set([1]) });
  assert(song.version === 1, 'song version 1');
  assert(song.notes.length === 3, '3 notes');
  assert(song.global.mode === 'chromatic', 'chromatic mode');
  // baseMidi = floor(60/12)*12 - 12 = 48. emitters: 60-48=12, 64-48=16, 67-48=19.
  assert(song.notes[0].emitter === 12, 'C4 → emitter 12');
  assert(song.notes[1].emitter === 16, 'E4 → emitter 16');
  assert(song.notes[2].emitter === 19, 'G4 → emitter 19');
});
