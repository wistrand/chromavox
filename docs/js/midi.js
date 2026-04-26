// MIDI (Standard MIDI File) → Chromavox song JSON.
//
// Zero deps. Parses Format 0 and Format 1 files; no Format 2 (rare).
// Only TPQ-based timing (division > 0); no SMPTE timing.
//
// The parser produces a `ParsedMidi` object that can be converted to a
// song JSON multiple times with different track selections — so the
// UI can let the user toggle tracks and re-import without re-parsing.
//
// Scope (MVP):
//   - note on/off, multi-track merging, tempo map with mid-piece changes
//   - drum channel (MIDI 10, zero-indexed 9) surfaced but default-off
//   - per-track metadata: name, channel, program, note counts, range
// Not handled:
//   - Pitch bend (skipped)
//   - Control change (CC7 volume, CC64 sustain, CC11 expression — skipped)
//   - Program-change-based carrier selection (user picks carrier)
//   - Format 2
//   - SysEx (skipped)

// ---------- PARSER ----------

// Read big-endian multibyte values from a Uint8Array via shared cursor.
function makeReader(bytes) {
  let p = 0;
  return {
    get pos() { return p; },
    set pos(v) { p = v; },
    eof() { return p >= bytes.length; },
    u8() { return bytes[p++]; },
    u16() { return (bytes[p++] << 8) | bytes[p++]; },
    u32() {
      const v = ((bytes[p] << 24) | (bytes[p + 1] << 16) |
                 (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      p += 4; return v;
    },
    str(n) {
      const s = String.fromCharCode.apply(null, bytes.subarray(p, p + n));
      p += n; return s;
    },
    vlq() {
      let v = 0, b;
      do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80);
      return v >>> 0;
    },
    bytes(n) {
      const s = bytes.subarray(p, p + n);
      p += n; return s;
    },
  };
}

export function parseMidi(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const r = makeReader(bytes);

  // Header ---
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file (no MThd)');
  const hlen = r.u32();
  if (hlen < 6) throw new Error('Bad MIDI header length');
  const format = r.u16();
  const numTracks = r.u16();
  const division = r.u16();
  r.pos = r.pos + (hlen - 6); // skip any extra header bytes
  if (format === 2) throw new Error('MIDI format 2 is not supported');
  if (division & 0x8000) throw new Error('SMPTE-based timing is not supported');
  const ticksPerQuarter = division;

  // Parse track chunks ---
  const rawTracks = [];
  for (let ti = 0; ti < numTracks; ti++) {
    if (r.str(4) !== 'MTrk') throw new Error('Bad track header (no MTrk)');
    const tlen = r.u32();
    const end = r.pos + tlen;
    const events = [];
    let tick = 0;
    let runningStatus = 0;
    while (r.pos < end) {
      tick += r.vlq();
      let s = bytes[r.pos];
      if (s < 0x80) { s = runningStatus; } else { runningStatus = s; r.pos = r.pos + 1; }
      if (s === 0xff) {
        const metaType = r.u8();
        const mlen = r.vlq();
        const data = r.bytes(mlen);
        events.push({ tick, type: 'meta', metaType, data });
        runningStatus = 0; // meta events clear running status
      } else if (s === 0xf0 || s === 0xf7) {
        const mlen = r.vlq();
        r.pos = r.pos + mlen;
        runningStatus = 0;
      } else {
        const st = s & 0xf0;
        const ch = s & 0x0f;
        if (st === 0xc0 || st === 0xd0) {
          const d0 = r.u8();
          events.push({ tick, type: 'msg', st, ch, d0, d1: 0 });
        } else {
          const d0 = r.u8(), d1 = r.u8();
          events.push({ tick, type: 'msg', st, ch, d0, d1 });
        }
      }
    }
    r.pos = end; // defensive: align to chunk end even if parser over-/under-read
    rawTracks.push(events);
  }

  // Tempo map: sorted list of (tick, microsPerQuarter).
  const tempoMap = [{ tick: 0, tempoUs: 500000 }]; // default 120 BPM
  for (const events of rawTracks) {
    for (const ev of events) {
      if (ev.type === 'meta' && ev.metaType === 0x51 && ev.data.length >= 3) {
        const tempoUs = (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2];
        tempoMap.push({ tick: ev.tick, tempoUs });
      }
    }
  }
  tempoMap.sort((a, b) => a.tick - b.tick || 0);

  // Split Format 0 into virtual per-channel "tracks" so the UI has
  // something meaningful to toggle. Meta events (name, tempo) stay
  // attached to a synthetic track-header bucket.
  let trackEventLists;
  let sharedName = '';
  {
    const td = new TextDecoder('utf-8');
    if (format === 0) {
      const byCh = new Map();
      for (const ev of rawTracks[0]) {
        if (ev.type === 'msg') {
          if (!byCh.has(ev.ch)) byCh.set(ev.ch, []);
          byCh.get(ev.ch).push(ev);
        } else if (ev.type === 'meta' && ev.metaType === 0x03) {
          sharedName = td.decode(ev.data).trim();
        }
      }
      trackEventLists = [...byCh.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ch, events]) => ({ events, virtualChannel: ch }));
    } else {
      trackEventLists = rawTracks.map(events => ({ events, virtualChannel: null }));
      // Format 1 title: first non-empty track-name meta (usually track 0).
      for (const events of rawTracks) {
        for (const ev of events) {
          if (ev.type === 'meta' && ev.metaType === 0x03 && ev.data.length) {
            sharedName = td.decode(ev.data).trim();
            if (sharedName) break;
          }
        }
        if (sharedName) break;
      }
    }
  }

  // Analyze each (virtual) track into note pairs + metadata.
  const tracks = [];
  const td = new TextDecoder('utf-8');
  for (let ti = 0; ti < trackEventLists.length; ti++) {
    const { events, virtualChannel } = trackEventLists[ti];
    let name = '';
    let program = null;
    let channel = virtualChannel;
    let ccCount = 0;
    const pending = new Map(); // key: `${ch}_${pitch}` → [{tick, vel}, …]
    const notes = [];
    // Per-channel sustain-pedal events: list of {tick, on}.
    // Captured here so the converter can extend a note's duration
    // until the matching CC 64 release event.
    const sustainByCh = new Map(); // ch → [{tick, on}]
    // Mid-track program-change events. Some files reuse a single
    // track for multiple instruments via 0xC0 events at different
    // ticks; the converter resolves a per-note carrier from this
    // list when present.
    const programChanges = []; // [{tick, program, ch}]
    let minPitch = 128, maxPitch = -1;
    const pitchSet = new Set();
    let firstTick = Infinity, lastTick = 0;

    for (const ev of events) {
      if (ev.type === 'meta') {
        if (ev.metaType === 0x03 && ev.data.length && !name) {
          name = td.decode(ev.data).trim();
        }
        continue;
      }
      if (channel === null) channel = ev.ch;
      const st = ev.st;
      if (st === 0x90 && ev.d1 > 0) {
        const key = ev.ch * 128 + ev.d0;
        let stk = pending.get(key);
        if (!stk) { stk = []; pending.set(key, stk); }
        stk.push({ tick: ev.tick, vel: ev.d1 });
        if (ev.d0 < minPitch) minPitch = ev.d0;
        if (ev.d0 > maxPitch) maxPitch = ev.d0;
        pitchSet.add(ev.d0);
        if (ev.tick < firstTick) firstTick = ev.tick;
      } else if ((st === 0x90 && ev.d1 === 0) || st === 0x80) {
        const key = ev.ch * 128 + ev.d0;
        const stk = pending.get(key);
        if (stk && stk.length) {
          const start = stk.shift();
          notes.push({
            startTick: start.tick,
            endTick: ev.tick,
            pitch: ev.d0,
            vel: start.vel / 127,
            ch: ev.ch,
          });
          if (ev.tick > lastTick) lastTick = ev.tick;
        }
      } else if (st === 0xb0) {
        ccCount++;
        // CC 64 = sustain pedal. Standard convention: ≥ 64 = on,
        // < 64 = off. Stored per channel; the converter walks this
        // alongside notes to extend their duration when sustain is
        // active at note-end.
        if (ev.d0 === 64) {
          let evList = sustainByCh.get(ev.ch);
          if (!evList) { evList = []; sustainByCh.set(ev.ch, evList); }
          evList.push({ tick: ev.tick, on: ev.d1 >= 64 });
        }
      } else if (st === 0xc0) {
        // First-program-wins for the track-level `program` field
        // (used by track-name + UI summaries). The full timeline of
        // changes is captured in `programChanges` below so the
        // converter can resolve a per-note carrier when a track
        // switches instruments mid-song.
        if (program === null) program = ev.d0;
        programChanges.push({ tick: ev.tick, program: ev.d0, ch: ev.ch });
      }
    }
    // Close any still-open notes at the last event tick.
    for (const stk of pending.values()) {
      for (const start of stk) {
        notes.push({
          startTick: start.tick,
          endTick: Math.max(start.tick + ticksPerQuarter, lastTick),
          pitch: 0,
          vel: 0,
          ch: 0,
        });
      }
    }
    notes.sort((a, b) => a.startTick - b.startTick);

    // Sort each channel's sustain events by tick — they were appended
    // in stream order, but for SMF format-1 multi-track files we
    // collapse multiple physical tracks into one virtual track per
    // channel, and order may shuffle.
    for (const evList of sustainByCh.values()) evList.sort((a, b) => a.tick - b.tick);
    programChanges.sort((a, b) => a.tick - b.tick);
    tracks.push({
      index: ti,
      name: name || (channel !== null ? `Channel ${channel + 1}` : `Track ${ti}`),
      channel: channel === null ? 0 : channel,
      program,
      programChanges,
      noteCount: notes.length,
      ccCount,
      notes,
      sustainByCh,
      lowestPitch: minPitch <= maxPitch ? minPitch : 0,
      highestPitch: minPitch <= maxPitch ? maxPitch : 0,
      uniquePitches: pitchSet.size,
      firstTick: firstTick === Infinity ? 0 : firstTick,
      lastTick,
    });
  }

  return {
    format,
    ticksPerQuarter,
    tempoMap,
    tracks,
    title: sharedName || 'MIDI import',
  };
}

// ---------- CONVERTER ----------

// Sustain (CC 64) extension: if the pedal is depressed at `endTick`,
// extend the note end to the next pedal-up event on the same channel
// (capped at `maxExtendTicks` to bound runaway sustain). When the
// pedal isn't down, returns `endTick` unchanged. `susEvents` is a
// tick-sorted [{tick, on}] list from the parser.
function sustainExtendEndTick(endTick, susEvents, maxExtendTicks) {
  if (!susEvents || !susEvents.length) return endTick;
  let on = false;
  for (let i = 0; i < susEvents.length; i++) {
    const e = susEvents[i];
    if (e.tick <= endTick) { on = e.on; continue; }
    // events past endTick: if pedal was on at endTick, the first
    // pedal-up event past endTick gives the new end.
    if (!on) return endTick;
    if (!e.on) return Math.min(e.tick, endTick + maxExtendTicks);
  }
  // Pedal still on past last event → cap at maxExtendTicks.
  return on ? endTick + maxExtendTicks : endTick;
}

// Walk the tempo map to convert a tick to seconds.
function tickToSec(tick, tempoMap, tpq) {
  if (tick <= 0) return 0;
  let time = 0;
  let prevTick = 0;
  let tempoUs = tempoMap[0].tempoUs;
  for (let i = 0; i < tempoMap.length; i++) {
    const tm = tempoMap[i];
    if (tm.tick > tick) break;
    time += (tm.tick - prevTick) * tempoUs / (tpq * 1e6);
    prevTick = tm.tick;
    tempoUs = tm.tempoUs;
  }
  time += (tick - prevTick) * tempoUs / (tpq * 1e6);
  return time;
}

// Default enabled set based on per-track heuristics. Returns Set of
// track indices to enable. Skips:
//   - drum channel (MIDI ch 10 → zero-indexed 9)
//   - tracks with < 5 notes
//   - tracks with < 2 unique pitches (one-note drones / FX)
//   - tracks whose name matches common effect words
const _FX_NAMES = /fx|noise|applause|cymbal|wind|sea|shore|clap|sfx|perc\b/i;
export function defaultEnabled(parsed) {
  const out = new Set();
  for (const t of parsed.tracks) {
    if (t.channel === 9) continue;
    if (t.noteCount < 5) continue;
    if (t.uniquePitches < 2) continue;
    if (_FX_NAMES.test(t.name)) continue;
    out.add(t.index);
  }
  return out;
}

// Guess a carrier from enabled-track names. Piano-forward when any
// enabled track mentions piano/kalimba/harpsichord; string-forward
// when any mentions strings/ensemble/pad/brass/choir; otherwise sine.
// Track-name → carrier hints. Name match wins over GM program when a
// file's track has an expressive name but a generic program (common
// in DAW exports, ABC-source MusicXML→MIDI, MuseScore defaults).
//
// Order of evaluation in `trackCarrier`: piano → karplus → bass →
// drums → noise → strings/pad. Most-specific timbres first.
const _PIANO_RE   = /\b(piano|pno|epiano|e\.piano|harpsichord|clav|harpsi)\b/i;
// Mallet/struck-resonant family. Pulled out of karplus so glockenspiel,
// vibraphone, marimba, etc. get the bell carrier (inharmonic partials)
// instead of plucked-string-decay.
const _BELL_RE    = /\b(bell|chime|glock|vibe|vibraphone|xyl|xylophone|marimba|mallet|celesta)\b/i;
// Plucked strings only (kalimba is also struck, but karplus is the
// closest carrier we have for it).
const _KARPLUS_RE = /\b(guitar|gtr|harp|kalimba|sitar|banjo|koto|mando|pluck|dulcimer)\b/i;
const _BASS_RE    = /\b(bass|bs|sub)\b/i;
// Bowed strings (separate from saw-pad supersaw) and brass.
const _BOWED_RE   = /\b(violin|viola|cello|contrabass|fiddle|strings?|str|ensemble|choir|chorus|vox|voice|orchestra)\b/i;
const _BRASS_RE   = /\b(brass|trumpet|trombone|tuba|horn)\b/i;
const _NOISE_RE   = /\b(perc|fx|noise|tinkle|cymbal|wind|sea|shore|clap|sfx)\b/i;
// Synth pad / lead / generic synth — supersaw default.
const _STRING_RE  = /\b(pad|sax|lead|ld|synth|arp|seq|sequence)\b/i;
export function guessCarrier(parsed, enabled) {
  let sawString = false;
  for (const t of parsed.tracks) {
    if (!enabled.has(t.index)) continue;
    if (_PIANO_RE.test(t.name)) return 'piano';
    if (_STRING_RE.test(t.name)) sawString = true;
  }
  return sawString ? 'supersaw' : 'sine';
}

// GM (General MIDI) program number → Chromavox carrier name.
// 128-entry table — within each GM group the individual programs have
// real timbral differences that a group-average mapping flattens
// (harpsichord vs grand piano, distortion vs nylon guitar, etc.).
//
// fm and vocoder are intentionally not used as default targets — they
// read as too weird/specific for generic GM mapping. Users can pick
// them via the Synth carrier dropdown.
const _GM_PROGRAM_TO_CARRIER = [
  // 0-7 Piano
  'piano',    // 0  Acoustic Grand
  'piano',    // 1  Bright Acoustic
  'piano',    // 2  Electric Grand
  'piano',    // 3  Honky-tonk
  'piano',    // 4  Electric Piano 1 (Rhodes)
  'piano',    // 5  Electric Piano 2 (DX-style)
  'karplus',  // 6  Harpsichord (plucked)
  'acid',     // 7  Clavinet (filtered, percussive)
  // 8-15 Chromatic Percussion — bell carrier (inharmonic struck
  // partials with per-partial decay). Karplus was a plucked-string
  // approximation; bells/mallets are struck-resonant and need the
  // metallic shimmer the bell carrier provides.
  'bell',     // 8  Celesta
  'bell',     // 9  Glockenspiel
  'bell',     // 10 Music Box
  'bell',     // 11 Vibraphone
  'bell',     // 12 Marimba
  'bell',     // 13 Xylophone
  'bell',     // 14 Tubular Bells
  'karplus',  // 15 Dulcimer (still plucked)
  // 16-23 Organ — sine + partials (additive) reads as an organ rank
  // stack at much lower per-voice level than pulse. Pulse at full ±1
  // amplitude was correct timbre but stacked into the limiter when
  // many notes sustained simultaneously (typical for organ chords).
  'sine',     // 16 Drawbar Organ
  'sine',     // 17 Percussive Organ
  'sine',     // 18 Rock Organ
  'sine',     // 19 Church Organ
  'sine',     // 20 Reed Organ
  'sine',     // 21 Accordion
  'sine',     // 22 Harmonica
  'sine',     // 23 Tango Accordion
  // 24-31 Guitar
  'karplus',  // 24 Acoustic Nylon
  'karplus',  // 25 Acoustic Steel
  'karplus',  // 26 Electric Jazz
  'karplus',  // 27 Electric Clean
  'pulse',    // 28 Electric Muted
  'acid',     // 29 Overdriven
  'acid',     // 30 Distortion
  'sine',     // 31 Harmonics
  // 32-39 Bass
  'karplus',  // 32 Acoustic Bass
  'acid',     // 33 Electric Bass (finger)
  'acid',     // 34 Electric Bass (pick)
  'acid',     // 35 Fretless Bass — smooth tone, not square
  'acid',     // 36 Slap Bass 1
  'acid',     // 37 Slap Bass 2
  'acid',     // 38 Synth Bass 1 — Moog-style filtered saw, not square
  'acid',     // 39 Synth Bass 2
  // 40-47 Strings — bowed carrier (saw + soft LP + slow attack +
  // light vibrato). Pizz / harp stay plucked; timpani stays as a
  // karplus thump (close enough to a struck-tom character to follow
  // the chromatic ladder).
  'bowed',    // 40 Violin
  'bowed',    // 41 Viola
  'bowed',    // 42 Cello
  'bowed',    // 43 Contrabass
  'bowed',    // 44 Tremolo Strings
  'karplus',  // 45 Pizzicato Strings (plucked)
  'karplus',  // 46 Orchestral Harp (plucked)
  'karplus',  // 47 Timpani (struck)
  // 48-55 Ensemble — bowed for orchestral/synth string ensembles +
  // choir (sustained, vowel-y). Synth Voice / Orchestra Hit stay on
  // the saw-stack-y carriers since they're synthetic by nature.
  'bowed',    // 48 String Ensemble 1
  'bowed',    // 49 String Ensemble 2
  'bowed',    // 50 Synth Strings 1
  'bowed',    // 51 Synth Strings 2
  'bowed',    // 52 Choir Aahs
  'bowed',    // 53 Voice Oohs
  'supersaw', // 54 Synth Voice
  'pulse',    // 55 Orchestra Hit
  // 56-63 Brass — dedicated brass carrier (saw + formant bandpass
  // + vibrato). Distinguishes brass-section presence from the
  // string-section pad-y supersaw character that previously shared
  // the same carrier.
  'brass',    // 56 Trumpet
  'brass',    // 57 Trombone
  'brass',    // 58 Tuba
  'brass',    // 59 Muted Trumpet
  'brass',    // 60 French Horn
  'brass',    // 61 Brass Section
  'brass',    // 62 Synth Brass 1
  'brass',    // 63 Synth Brass 2
  // 64-71 Reed
  'pulse',    // 64 Soprano Sax
  'pulse',    // 65 Alto Sax
  'pulse',    // 66 Tenor Sax
  'pulse',    // 67 Baritone Sax
  'pulse',    // 68 Oboe
  'pulse',    // 69 English Horn
  'pulse',    // 70 Bassoon
  'pulse',    // 71 Clarinet
  // 72-79 Pipe — pulse (square) instead of sine. Sine is too thin
  // for the iconic synth-lead "Flute" usage common in synth-pop MIDI
  // (e.g. Sweet Dreams MELODY = prog 73 but really a synth lead).
  // Pulse has hollow flute-like resonance and reads as a melody voice.
  'pulse',    // 72 Piccolo
  'pulse',    // 73 Flute
  'pulse',    // 74 Recorder
  'pulse',    // 75 Pan Flute
  'pulse',    // 76 Blown Bottle
  'pulse',    // 77 Shakuhachi
  'pulse',    // 78 Whistle
  'pulse',    // 79 Ocarina
  // 80-87 Synth Lead
  'supersaw', // 80 Square Lead
  'supersaw', // 81 Saw Lead
  'pulse',    // 82 Calliope Lead
  'pulse',    // 83 Chiff Lead
  'supersaw', // 84 Charang Lead
  'supersaw', // 85 Voice Lead
  'supersaw', // 86 Fifths Lead
  'acid',     // 87 Bass + Lead
  // 88-95 Synth Pad
  'supersaw', // 88 New Age Pad
  'supersaw', // 89 Warm Pad
  'supersaw', // 90 Polysynth Pad
  'supersaw', // 91 Choir Pad
  'supersaw', // 92 Bowed Pad
  'supersaw', // 93 Metallic Pad
  'supersaw', // 94 Halo Pad
  'supersaw', // 95 Sweep Pad
  // 96-103 Synth FX
  'noise',    // 96 Rain
  'noise',    // 97 Soundtrack
  'sine',     // 98 Crystal
  'karplus',  // 99 Atmosphere
  'noise',    // 100 Brightness
  'noise',    // 101 Goblins
  'noise',    // 102 Echoes
  'noise',    // 103 Sci-Fi
  // 104-111 Ethnic
  'karplus',  // 104 Sitar
  'karplus',  // 105 Banjo
  'karplus',  // 106 Shamisen
  'karplus',  // 107 Koto
  'karplus',  // 108 Kalimba
  'pulse',    // 109 Bagpipe
  'supersaw', // 110 Fiddle
  'pulse',    // 111 Shanai
  // 112-119 Percussive
  'noise',    // 112 Tinkle Bell
  'noise',    // 113 Agogo
  'noise',    // 114 Steel Drums
  'noise',    // 115 Woodblock
  'noise',    // 116 Taiko Drum
  'noise',    // 117 Melodic Tom
  'noise',    // 118 Synth Drum
  'noise',    // 119 Reverse Cymbal
  // 120-127 Sound FX
  'noise',    // 120 Guitar Fret Noise
  'noise',    // 121 Breath Noise
  'noise',    // 122 Seashore
  'noise',    // 123 Bird Tweet
  'noise',    // 124 Telephone
  'noise',    // 125 Helicopter
  'noise',    // 126 Applause
  'noise',    // 127 Gunshot
];
export function programToCarrier(program) {
  if (typeof program !== 'number' || program < 0 || program > 127) return null;
  return _GM_PROGRAM_TO_CARRIER[program];
}

// Per-track carrier: name-based first (more reliable when present —
// some files set generic programs but expressive names), then program-
// based, then null (caller falls back to the global default).
export function trackCarrier(track) {
  if (!track) return null;
  const n = track.name || '';
  if (_PIANO_RE.test(n))   return 'piano';
  if (_BELL_RE.test(n))    return 'bell';
  if (_BRASS_RE.test(n))   return 'brass';
  if (_BOWED_RE.test(n))   return 'bowed';
  if (_KARPLUS_RE.test(n)) return 'karplus';
  if (_BASS_RE.test(n))    return 'acid';
  if (_NOISE_RE.test(n))   return 'noise';
  if (_STRING_RE.test(n))  return 'supersaw';
  return programToCarrier(track.program);
}

// Drum (channel 10 / GM-percussion) → (lane, carrier, duration).
// The converter routes drum notes to a small set of emitters at the
// bottom of the bench regardless of GM pitch — they're rhythm
// punctuation, not melodic content. Each lane gets a carrier picked
// for percussive character and a forced short duration so each hit
// reads as an impulse (MIDI drum-note durations are often a full beat
// or longer, which would render as a sustained drone otherwise).
//   0 = kick, 1 = snare, 2 = tom/perc, 3 = hat/cymbal/cowbell.
function drumLane(pitch) {
  if (pitch === 35 || pitch === 36) return 0;             // kick
  if (pitch === 38 || pitch === 40) return 1;             // snare
  if (pitch === 39 || pitch === 37 || pitch === 31) return 1; // clap, side stick, sticks → snare lane
  // Hi-hats (42 closed, 44 pedal, 46 open) live INSIDE the tom range
  // numerically; pull them out into the hat lane explicitly.
  if (pitch === 42 || pitch === 44 || pitch === 46) return 3;
  if (pitch >= 41 && pitch <= 50) return 2;               // toms (41/43/45/47/48/50)
  if (pitch === 60 || pitch === 61 || pitch === 62 || pitch === 63 || pitch === 64) return 2;
  return 3;                                                // cymbals / shakers / bells / etc.
}
const DRUM_LANE_COUNT = 4;
// Per-lane carrier choice. karplus gives a tuned plucked-string thump
// for kick + tom (decays naturally, reads as a body); noise gives
// broadband attack for snare + hat (sticks, rattles, shimmer).
const DRUM_LANE_CARRIER = ['karplus', 'noise', 'karplus', 'noise'];
// Per-lane forced max duration in seconds. Short so each hit reads as
// a punctuation, not a held tone. Slightly longer for kick/tom (body
// resonance), shorter for snare/hat (transient).
const DRUM_LANE_DUR = [0.18, 0.08, 0.14, 0.05];

// Sustain extend cap: 8 seconds. Long enough for natural piano
// pedaling, short enough that a stuck pedal can't hold notes forever.
const _SUSTAIN_MAX_SEC = 8;

export function midiToSong(parsed, options = {}) {
  const enabled = options.enabledTracks || defaultEnabled(parsed);
  // The global synth carrier is the user's dropdown selection (or a
  // best-guess from track names if absent). It drives any voice that
  // ends up at carrierIdx 0 — emitters with no active note (or all
  // tracks when `perTrackInstruments === false`).
  const carrier = options.carrier || guessCarrier(parsed, enabled);
  const volume = options.volume ?? 0.5;
  // perTrackInstruments: when true (default), each track's notes carry
  // its inferred carrier (GM program → carrier mapping). When false,
  // every note plays through the global synth carrier — same as
  // pre-Stage-3 behavior, single-instrument song.
  const perTrack = options.perTrackInstruments !== false;
  // includeDrums: when true, channel-10 notes route to a fixed set of
  // drum emitters at the bottom of the bench (kick / snare / tom /
  // hat lanes). Default off — drum tracks are silent unless asked.
  const includeDrums = !!options.includeDrums;

  // Collect notes from enabled tracks in absolute seconds. Each note
  // carries its track's carrier (per-track GM program mapping) so the
  // synth plays each note in its source instrument's voice. Drum
  // notes are collected separately — they don't share the melodic
  // emitter range.
  const rawNotes = [];
  const drumNotes = [];
  let minPitch = Infinity, maxPitch = -Infinity;
  // Tempo at start of song (only used for sustain max-extend ticks
  // approximation; tempo changes mid-song are handled by tickToSec).
  const tempoUs0 = parsed.tempoMap[0].tempoUs;
  const susMaxTicks = _SUSTAIN_MAX_SEC * 1e6 / tempoUs0 * parsed.ticksPerQuarter;
  for (const t of parsed.tracks) {
    if (!enabled.has(t.index)) continue;
    const isDrum = t.channel === 9;
    if (isDrum && !includeDrums) continue;
    if (isDrum) {
      // Channel-10: route to drum lanes; no sustain pedal for drums.
      // Force per-lane short duration regardless of MIDI note length —
      // a kick whose MIDI dur is 500ms should still read as an impulse.
      for (const n of t.notes) {
        if (n.endTick <= n.startTick) continue;
        const lane = drumLane(n.pitch);
        const startSec = tickToSec(n.startTick, parsed.tempoMap, parsed.ticksPerQuarter);
        const endSec = tickToSec(n.endTick, parsed.tempoMap, parsed.ticksPerQuarter);
        const naturalDur = endSec - startSec;
        drumNotes.push({
          time: startSec,
          duration: Math.min(naturalDur, DRUM_LANE_DUR[lane]),
          lane,
          vel: n.vel,
          carrier: DRUM_LANE_CARRIER[lane],
        });
      }
      continue;
    }
    // Track name overrides program-based mapping (when present).
    // For tracks without a recognizable name, fall through to the
    // per-note program lookup so mid-track program changes apply.
    const nameCarrier = trackCarrier({ name: t.name, program: undefined });
    const susByCh = t.sustainByCh; // Map<ch, [{tick, on}]>
    const pcs = t.programChanges; // [{tick, program, ch}]
    // Cursor into pcs — notes are sorted by startTick, pcs by tick,
    // so we can advance forward only.
    let pcCursor = 0;
    let activeProgram = pcs && pcs.length ? pcs[0].program : t.program;
    for (const n of t.notes) {
      if (n.endTick <= n.startTick) continue;
      // Advance program cursor to the latest change at-or-before
      // this note's start. Mid-track program changes let a single
      // track switch instruments — common in some MIDI exports.
      if (pcs && pcs.length) {
        while (pcCursor < pcs.length && pcs[pcCursor].tick <= n.startTick) {
          activeProgram = pcs[pcCursor].program;
          pcCursor++;
        }
      }
      // Resolve carrier: name override > active program > global default.
      let tCarrier = carrier;
      if (perTrack) {
        if (nameCarrier) tCarrier = nameCarrier;
        else {
          const c = programToCarrier(activeProgram);
          if (c) tCarrier = c;
        }
      }
      // CC 64 sustain pedal extension: if the pedal is held at the
      // note's natural endTick, push the end out to the next pedal
      // release (capped at SUSTAIN_MAX_SEC).
      let endTick = n.endTick;
      const susEvents = susByCh ? susByCh.get(n.ch) : null;
      if (susEvents) endTick = sustainExtendEndTick(endTick, susEvents, susMaxTicks);
      if (n.pitch < minPitch) minPitch = n.pitch;
      if (n.pitch > maxPitch) maxPitch = n.pitch;
      rawNotes.push({
        time: tickToSec(n.startTick, parsed.tempoMap, parsed.ticksPerQuarter),
        duration: tickToSec(endTick, parsed.tempoMap, parsed.ticksPerQuarter) -
                  tickToSec(n.startTick, parsed.tempoMap, parsed.ticksPerQuarter),
        pitch: n.pitch,
        vel: n.vel,
        carrier: tCarrier,
      });
    }
  }

  if (rawNotes.length === 0 && drumNotes.length === 0) {
    throw new Error('No notes in selected tracks');
  }

  // Octave-fold high pitches into the audible range, then pitch → emitter.
  // Base = one octave below the lowest note aligned to an octave boundary;
  // emitterCount capped at 64 (GPU tracer wlPerSource texture width).
  // When drums are included, the bottom DRUM_LANE_COUNT emitters are
  // reserved for drum lanes and all melodic emitter indices shift up.
  const drumOffset = drumNotes.length > 0 ? DRUM_LANE_COUNT : 0;
  // baseMidi is meaningful only when there are melodic notes. For
  // drum-only imports, fall back to a default (middle C) so baseHz
  // and the chromatic ladder still resolve.
  let baseMidi, emitterCount;
  if (rawNotes.length > 0) {
    baseMidi = Math.floor(minPitch / 12) * 12 - 12;
    emitterCount = (maxPitch - baseMidi) + 1 + drumOffset;
    if (emitterCount > 64) {
      const overflow = emitterCount - 64;
      baseMidi += overflow;
      if (baseMidi > minPitch) baseMidi = minPitch;
      emitterCount = Math.min(64, (maxPitch - baseMidi) + 1 + drumOffset);
    }
  } else {
    baseMidi = 60; // C4 fallback for drum-only songs
    emitterCount = drumOffset;
  }
  emitterCount = Math.max(1, emitterCount);
  const baseHz = 440 * Math.pow(2, (baseMidi - 69) / 12);

  const notes = [];
  let outOfRange = 0;
  // Perceptual velocity curve helper: pow(v, 1/2.4) lifts soft notes
  // toward audibility; the +0.15 floor keeps tiny-velocity notes
  // audible. Was linear `v * 0.9 + 0.1` — squashed dynamics on piano.
  const shapeVel = v => {
    const x = Math.pow(Math.max(0, Math.min(1, v)), 1 / 2.4);
    return Number((x * 0.85 + 0.15).toFixed(2));
  };
  for (const n of rawNotes) {
    const emitter = (n.pitch - baseMidi) + drumOffset;
    if (emitter < drumOffset || emitter >= emitterCount) { outOfRange++; continue; }
    const note = {
      time: Number(n.time.toFixed(4)),
      emitter,
      vel: shapeVel(n.vel),
      dur: Math.max(0.05, Number(n.duration.toFixed(4))),
    };
    // Only stamp the carrier when it differs from the song-wide
    // default. Saves bytes on single-instrument files; matches the
    // design-song-format default behaviour.
    if (n.carrier && n.carrier !== carrier) note.carrier = n.carrier;
    notes.push(note);
  }
  // Drum notes route to the lowest DRUM_LANE_COUNT emitters,
  // regardless of GM pitch. Per-lane carrier (karplus for kick/tom,
  // noise for snare/hat) was already chosen during note collection.
  for (const n of drumNotes) {
    notes.push({
      time: Number(n.time.toFixed(4)),
      emitter: n.lane,
      vel: shapeVel(n.vel),
      dur: Math.max(0.05, Number(n.duration.toFixed(4))),
      carrier: n.carrier,
    });
  }
  notes.sort((a, b) => a.time - b.time);

  const lastTick = parsed.tracks.reduce((m, t) => Math.max(m, t.lastTick), 0);
  const durationSec = tickToSec(lastTick, parsed.tempoMap, parsed.ticksPerQuarter) + 0.5;

  // Effective BPM: from the first tempo entry (informational only).
  const bpm = Math.round(60_000_000 / parsed.tempoMap[0].tempoUs);

  const title = parsed.title || 'MIDI import';
  // Per-emitter dominant carrier — vote across all notes weighted by
  // velocity*duration, pick the winner per emitter. Stamped into
  // `global.carriers` so per-emitter indicators show on the bench
  // immediately at song-load (otherwise they'd only appear once each
  // emitter's first note fires, then linger from the last-played
  // carrier — visually inconsistent at song start and after seeking).
  const voteByEmitter = new Map();
  for (const n of notes) {
    const c = n.carrier || carrier;
    let row = voteByEmitter.get(n.emitter);
    if (!row) { row = {}; voteByEmitter.set(n.emitter, row); }
    row[c] = (row[c] || 0) + n.vel * n.dur;
  }
  const carriers = {};
  for (const [emitterIdx, row] of voteByEmitter) {
    let best = null, bestVal = 0;
    for (const [name, v] of Object.entries(row)) {
      if (v > bestVal) { bestVal = v; best = name; }
    }
    if (best && best !== carrier) carriers[emitterIdx] = best;
  }
  // Multi-instrument banner: show the unique carriers detected across
  // notes when more than one is in play.
  const carrierSet = new Set();
  for (const n of notes) carrierSet.add(n.carrier || carrier);
  const multiInstr = carrierSet.size > 1
    ? `\nInstruments: ${[...carrierSet].sort().join(', ')}`
    : '';
  const welcome = outOfRange > 0
    ? `${title}\n(MIDI import; ${outOfRange} of ${rawNotes.length + drumNotes.length} notes out of range)${multiInstr}\nPress ▶ to play`
    : `${title}\n(MIDI import)${multiInstr}\nPress ▶ to play`;

  const global = {
    emitter: { count: emitterCount, wlMin: 400, wlMax: 700, raysPerSource: 320 },
    sensorCount: emitterCount,
    mode: 'chromatic',
    base: Number(baseHz.toFixed(2)),
    span: 1,
    carrier,
    volume,
  };
  // Only emit `carriers` when at least one emitter has a non-default
  // dominant carrier — keeps single-instrument MIDI imports tidy.
  if (Object.keys(carriers).length > 0) global.carriers = carriers;

  return {
    version: 1,
    title,
    welcome,
    bpm,
    duration: Number(durationSec.toFixed(3)),
    loop: true,
    global,
    keyframes: [{ time: 0, elements: [] }],
    notes,
    automation: [],
  };
}
