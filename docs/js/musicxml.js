// MusicXML → Chromavox song JSON converter.
//
// Handles the audio-relevant subset of partwise MusicXML: notes with
// pitches (step + alter + octave), rests, ties, chords (<chord/>),
// backup/forward cursor moves for multi-voice, tempo (first occurrence
// via <sound tempo> or <metronome>), and divisions-per-quarter.
//
// Deliberately NOT handled (MVP scope):
//   - Repeats / alternate endings / D.S. al Coda — timeline is whatever
//     appears left-to-right in the measures.
//   - Tempo changes mid-piece.
//   - Multiple <part>s (takes the first).
//   - Ornaments, grace notes, triplet <time-modification> (grace
//     notes are skipped; triplets just play at their written duration,
//     which is usually wrong but audible).
//
// Pitch mapping: emits a chromatic song. Base Hz is auto-picked so the
// lowest note sits one octave above the base, giving room for any
// lower ornamentation. Emitter count spans lowest-to-highest pitch.
//
// Scene: empty keyframes — rays go straight from emitters to sensors,
// so imported songs play the written pitches without modulation. The
// user can add elements after import.

const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Some MusicXML exporters — especially those originating from ABC or
// TeX source — encode non-ASCII letters as backslash escapes
// (`\"a` → ä, `\aa` → å, `\'e` → é, etc.) instead of proper UTF-8.
// Decode the common ones so titles aren't full of stray backslashes.
const ABC_DIACRITICS = {
  '"a': 'ä', '"e': 'ë', '"i': 'ï', '"o': 'ö', '"u': 'ü', '"y': 'ÿ',
  '"A': 'Ä', '"E': 'Ë', '"I': 'Ï', '"O': 'Ö', '"U': 'Ü',
  "'a": 'á', "'e": 'é', "'i": 'í', "'o": 'ó', "'u": 'ú', "'y": 'ý',
  "'A": 'Á', "'E": 'É', "'I": 'Í', "'O": 'Ó', "'U": 'Ú', "'Y": 'Ý',
  '`a': 'à', '`e': 'è', '`i': 'ì', '`o': 'ò', '`u': 'ù',
  '`A': 'À', '`E': 'È', '`I': 'Ì', '`O': 'Ò', '`U': 'Ù',
  '^a': 'â', '^e': 'ê', '^i': 'î', '^o': 'ô', '^u': 'û',
  '^A': 'Â', '^E': 'Ê', '^I': 'Î', '^O': 'Ô', '^U': 'Û',
  '~a': 'ã', '~n': 'ñ', '~o': 'õ',
  '~A': 'Ã', '~N': 'Ñ', '~O': 'Õ',
  aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', ss: 'ß',
};
const ABC_SLASHED = { o: 'ø', O: 'Ø', l: 'ł', L: 'Ł' };
function decodeAbcEscapes(s) {
  if (!s || s.indexOf('\\') < 0) return s;
  return s
    .replace(/\\(["'`^~][A-Za-z]|aa|AA|ae|AE|oe|OE|ss)/g, (m, k) => ABC_DIACRITICS[k] || m)
    .replace(/\\([oOlL])(?![A-Za-z])/g, (m, c) => ABC_SLASHED[c] || m)
    .replace(/\\c\s*([cC])/g, (_, c) => (c === 'c' ? 'ç' : 'Ç'));
}

function readText(parent, sel) {
  const el = parent.querySelector(sel);
  return el ? el.textContent.trim() : null;
}
function readInt(parent, sel, fallback = 0) {
  const t = readText(parent, sel);
  const n = t == null ? fallback : parseInt(t, 10);
  return Number.isFinite(n) ? n : fallback;
}
function readFloat(parent, sel, fallback = 0) {
  const t = readText(parent, sel);
  const n = t == null ? fallback : parseFloat(t);
  return Number.isFinite(n) ? n : fallback;
}

export function musicxmlToSong(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const perr = doc.getElementsByTagName('parsererror');
  if (perr.length) throw new Error('MusicXML parse error: ' + perr[0].textContent.trim());

  // Song title: prefer movement-title, then work-title. Some scores
  // embed subtitles or translations after a newline inside the same
  // element; take just the first line.
  const rawTitle = readText(doc.documentElement, 'movement-title')
                || readText(doc.documentElement, 'work-title')
                || 'Imported song';
  const title = decodeAbcEscapes(rawTitle.split(/[\r\n]/, 1)[0].trim()) || 'Imported song';

  const part = doc.querySelector('part');
  if (!part) throw new Error('MusicXML: no <part> found');

  // Parser state.
  let divisions = 1;   // ticks per quarter note
  let tempo = 120;     // BPM
  let tempoSet = false;

  const rawNotes = [];                 // { time: ticks, pitch: midi, duration: ticks }
  const activeTies = new Map();        // midi → index into rawNotes
  let absEnd = 0;                      // absolute end-of-piece in ticks

  const measures = part.getElementsByTagName('measure');
  let measureStart = 0;

  for (const m of measures) {
    let cursor = measureStart;
    let prevStart = measureStart;      // start of the most recent non-chord note (for <chord/>)
    let maxCursor = cursor;            // latest reached in this measure (for voices that overshoot)

    for (let i = 0; i < m.children.length; i++) {
      const el = m.children[i];
      const tag = el.tagName;

      if (tag === 'attributes') {
        const div = readInt(el, 'divisions', 0);
        if (div > 0) divisions = div;

      } else if (tag === 'sound') {
        const t = el.getAttribute('tempo');
        if (t && !tempoSet) { tempo = parseFloat(t); tempoSet = true; }

      } else if (tag === 'direction') {
        if (!tempoSet) {
          const perMin = readFloat(el, 'metronome per-minute', NaN);
          const sndT = el.querySelector('sound')?.getAttribute('tempo');
          if (Number.isFinite(perMin)) { tempo = perMin; tempoSet = true; }
          else if (sndT) { tempo = parseFloat(sndT); tempoSet = true; }
        }

      } else if (tag === 'note') {
        const isChord = !!el.querySelector(':scope > chord');
        const isGrace = !!el.querySelector(':scope > grace');
        const duration = readInt(el, ':scope > duration', 0);
        const isRest = !!el.querySelector(':scope > rest');
        const pitchEl = el.querySelector(':scope > pitch');

        if (isGrace) continue; // grace notes: ignore (zero duration, skipped)

        const noteStart = isChord ? prevStart : cursor;

        if (!isRest && pitchEl) {
          const step = readText(pitchEl, 'step');
          const alter = readInt(pitchEl, 'alter', 0);
          const octave = readInt(pitchEl, 'octave', 4);
          if (step && STEP_TO_SEMITONE[step] !== undefined) {
            const midi = (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter;

            // Tie handling: <tie type="stop"> extends the previous same-pitch note.
            const ties = el.querySelectorAll(':scope > tie');
            let tieStop = false, tieStart = false;
            for (const t of ties) {
              const ty = t.getAttribute('type');
              if (ty === 'stop') tieStop = true;
              if (ty === 'start') tieStart = true;
            }

            if (tieStop && activeTies.has(midi)) {
              const idx = activeTies.get(midi);
              rawNotes[idx].duration += duration;
              if (!tieStart) activeTies.delete(midi);
            } else {
              rawNotes.push({ time: noteStart, pitch: midi, duration });
              if (tieStart) activeTies.set(midi, rawNotes.length - 1);
            }
          }
        }

        if (!isChord) prevStart = noteStart;
        if (!isChord) cursor += duration;
        if (cursor > maxCursor) maxCursor = cursor;

      } else if (tag === 'backup') {
        const d = readInt(el, ':scope > duration', 0);
        cursor -= d;

      } else if (tag === 'forward') {
        const d = readInt(el, ':scope > duration', 0);
        cursor += d;
        if (cursor > maxCursor) maxCursor = cursor;
      }
    }

    measureStart = maxCursor;
    if (measureStart > absEnd) absEnd = measureStart;
  }

  if (rawNotes.length === 0) throw new Error('MusicXML: no audible notes found');

  // Pitch range → emitter count + base.
  let minMidi = Infinity, maxMidi = -Infinity;
  for (const n of rawNotes) {
    if (n.pitch < minMidi) minMidi = n.pitch;
    if (n.pitch > maxMidi) maxMidi = n.pitch;
  }
  // Base = one octave below the lowest note, aligned to the note's
  // octave boundary. Gives headroom and makes emitter 12 = "the
  // lowest note in the piece" which is a nice mental model.
  const baseMidi = Math.floor(minMidi / 12) * 12 - 12;
  const baseHz = 440 * Math.pow(2, (baseMidi - 69) / 12);
  // Emitter count: span of the piece + 1 for inclusive upper bound,
  // capped at 64 (the emitter-count slider max).
  const emitterCount = Math.max(1, Math.min(64, (maxMidi - baseMidi) + 1));

  // Ticks → seconds.
  const secPerTick = 60 / (tempo * divisions);

  const notes = [];
  for (const n of rawNotes) {
    const emitter = n.pitch - baseMidi;
    if (emitter < 0 || emitter >= emitterCount) continue;
    notes.push({
      time: Number((n.time * secPerTick).toFixed(4)),
      emitter,
      vel: 0.7,
      dur: Math.max(0.05, Number((n.duration * secPerTick).toFixed(4))),
    });
  }
  notes.sort((a, b) => a.time - b.time);

  const durationSec = (absEnd * secPerTick) + 0.5;

  return {
    version: 1,
    title,
    welcome: title + '\n(imported from MusicXML)\nPress ▶ to play',
    bpm: Math.round(tempo),
    duration: Number(durationSec.toFixed(3)),
    loop: false,
    global: {
      emitter: { count: emitterCount, wlMin: 400, wlMax: 700, raysPerSource: 320 },
      sensorCount: emitterCount,
      mode: 'chromatic',
      base: Number(baseHz.toFixed(2)),
      span: 1,
      carrier: 'sine',
      volume: 0.25,
    },
    keyframes: [{ time: 0, elements: [] }],
    notes,
    automation: [],
  };
}
