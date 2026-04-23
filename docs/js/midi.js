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
      } else if (st === 0xc0) {
        program = ev.d0;
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

    tracks.push({
      index: ti,
      name: name || (channel !== null ? `Channel ${channel + 1}` : `Track ${ti}`),
      channel: channel === null ? 0 : channel,
      program,
      noteCount: notes.length,
      ccCount,
      notes,
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
const _PIANO_RE = /\bpiano|harpsichord|clav|kalimba\b/i;
const _STRING_RE = /\bstrings?|ensemble|pad|brass|choir|organ\b/i;
export function guessCarrier(parsed, enabled) {
  let sawString = false;
  for (const t of parsed.tracks) {
    if (!enabled.has(t.index)) continue;
    if (_PIANO_RE.test(t.name)) return 'piano';
    if (_STRING_RE.test(t.name)) sawString = true;
  }
  return sawString ? 'supersaw' : 'sine';
}

export function midiToSong(parsed, options = {}) {
  const enabled = options.enabledTracks || defaultEnabled(parsed);
  const carrier = options.carrier || guessCarrier(parsed, enabled);
  const volume = options.volume ?? 0.5;

  // Collect notes from enabled tracks in absolute seconds.
  const rawNotes = [];
  let minPitch = Infinity, maxPitch = -Infinity;
  for (const t of parsed.tracks) {
    if (!enabled.has(t.index)) continue;
    for (const n of t.notes) {
      if (n.endTick <= n.startTick) continue;
      if (n.pitch < minPitch) minPitch = n.pitch;
      if (n.pitch > maxPitch) maxPitch = n.pitch;
      rawNotes.push({
        time: tickToSec(n.startTick, parsed.tempoMap, parsed.ticksPerQuarter),
        duration: tickToSec(n.endTick, parsed.tempoMap, parsed.ticksPerQuarter) -
                  tickToSec(n.startTick, parsed.tempoMap, parsed.ticksPerQuarter),
        pitch: n.pitch,
        vel: n.vel,
      });
    }
  }

  if (rawNotes.length === 0) {
    throw new Error('No notes in selected tracks');
  }

  // Octave-fold high pitches into the audible range, then pitch → emitter.
  // Base = one octave below the lowest note aligned to an octave boundary;
  // emitterCount capped at 64 (GPU tracer wlPerSource texture width).
  let baseMidi = Math.floor(minPitch / 12) * 12 - 12;
  let emitterCount = (maxPitch - baseMidi) + 1;
  if (emitterCount > 64) {
    const overflow = emitterCount - 64;
    baseMidi += overflow;
    if (baseMidi > minPitch) baseMidi = minPitch;
    emitterCount = Math.min(64, (maxPitch - baseMidi) + 1);
  }
  emitterCount = Math.max(1, emitterCount);
  const baseHz = 440 * Math.pow(2, (baseMidi - 69) / 12);

  const notes = [];
  let outOfRange = 0;
  for (const n of rawNotes) {
    const emitter = n.pitch - baseMidi;
    if (emitter < 0 || emitter >= emitterCount) { outOfRange++; continue; }
    notes.push({
      time: Number(n.time.toFixed(4)),
      emitter,
      vel: Number((n.vel * 0.9 + 0.1).toFixed(2)), // soft floor so tiny-velocity notes still register
      dur: Math.max(0.05, Number(n.duration.toFixed(4))),
    });
  }
  notes.sort((a, b) => a.time - b.time);

  const lastTick = parsed.tracks.reduce((m, t) => Math.max(m, t.lastTick), 0);
  const durationSec = tickToSec(lastTick, parsed.tempoMap, parsed.ticksPerQuarter) + 0.5;

  // Effective BPM: from the first tempo entry (informational only).
  const bpm = Math.round(60_000_000 / parsed.tempoMap[0].tempoUs);

  const title = parsed.title || 'MIDI import';
  const welcome = outOfRange > 0
    ? `${title}\n(MIDI import; ${outOfRange} of ${rawNotes.length} notes out of range)\nPress ▶ to play`
    : `${title}\n(MIDI import)\nPress ▶ to play`;

  return {
    version: 1,
    title,
    welcome,
    bpm,
    duration: Number(durationSec.toFixed(3)),
    loop: true,
    global: {
      emitter: { count: emitterCount, wlMin: 400, wlMax: 700, raysPerSource: 320 },
      sensorCount: emitterCount,
      mode: 'chromatic',
      base: Number(baseHz.toFixed(2)),
      span: 1,
      carrier,
      volume,
    },
    keyframes: [{ time: 0, elements: [] }],
    notes,
    automation: [],
  };
}
