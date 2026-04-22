// MusicXML → Chromavox song JSON converter.
//
// Handles the audio-relevant subset of partwise MusicXML: notes with
// pitches (step + alter + octave), rests, ties, chords (<chord/>),
// backup/forward cursor moves for multi-voice, tempo (first occurrence
// via <sound tempo> or <metronome>), per-measure <divisions> changes,
// and multi-part merging (voice + piano + anything else are unioned
// into one event stream).
//
// Deliberately NOT handled (MVP scope):
//   - Repeats / alternate endings / D.S. al Coda — timeline is whatever
//     appears left-to-right in the measures.
//   - Tempo changes mid-piece (first tempo only).
//   - Ornaments, grace notes, triplet <time-modification> (grace
//     notes are skipped; triplets just play at their written duration,
//     which is usually wrong but audible).
//
// Pitch mapping: emits a chromatic song. Base Hz is auto-picked so the
// lowest note sits one octave above the base, giving room for any
// lower ornamentation. Emitter count spans lowest-to-highest pitch,
// capped at 64 (the GPU tracer's wlPerSource texture width).
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

// Find the first tempo declaration anywhere in the document. MusicXML
// can put it either as `<sound tempo="…">` (direct measure child or
// inside `<direction>`) or as `<metronome><per-minute>…`.
function findTempo(doc) {
  for (const s of doc.querySelectorAll('sound[tempo]')) {
    const t = parseFloat(s.getAttribute('tempo'));
    if (Number.isFinite(t) && t > 0) return t;
  }
  const m = doc.querySelector('metronome per-minute');
  if (m) {
    const t = parseFloat(m.textContent);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return 120;
}

// Walk one <part>, appending notes to `rawNotes` (time + duration in
// seconds, pitch as MIDI). Divisions can change per measure; tempo is
// the document-wide value passed in.
function parsePart(part, tempo, rawNotes) {
  let divisions = 1;
  const activeTies = new Map();
  let measureStart = 0; // seconds

  for (const m of part.getElementsByTagName('measure')) {
    let cursor = measureStart;
    let prevStart = measureStart;
    let maxCursor = cursor;

    // Helper to convert current-measure ticks to seconds using the
    // divisions value active at this point.
    const toSec = (ticks) => ticks * 60 / (tempo * divisions);

    for (let i = 0; i < m.children.length; i++) {
      const el = m.children[i];
      const tag = el.tagName;

      if (tag === 'attributes') {
        const div = readInt(el, 'divisions', 0);
        if (div > 0) divisions = div;

      } else if (tag === 'note') {
        const isChord = !!el.querySelector(':scope > chord');
        const isGrace = !!el.querySelector(':scope > grace');
        if (isGrace) continue;
        const durSec = toSec(readInt(el, ':scope > duration', 0));
        const isRest = !!el.querySelector(':scope > rest');
        const pitchEl = el.querySelector(':scope > pitch');

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
              rawNotes[idx].duration += durSec;
              if (!tieStart) activeTies.delete(midi);
            } else {
              rawNotes.push({ time: noteStart, pitch: midi, duration: durSec });
              if (tieStart) activeTies.set(midi, rawNotes.length - 1);
            }
          }
        }

        if (!isChord) prevStart = noteStart;
        if (!isChord) cursor += durSec;
        if (cursor > maxCursor) maxCursor = cursor;

      } else if (tag === 'backup') {
        cursor -= toSec(readInt(el, ':scope > duration', 0));

      } else if (tag === 'forward') {
        cursor += toSec(readInt(el, ':scope > duration', 0));
        if (cursor > maxCursor) maxCursor = cursor;
      }
    }

    measureStart = maxCursor;
  }

  return measureStart; // time of the part's final barline, in seconds
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

  const parts = doc.querySelectorAll('part');
  if (!parts.length) throw new Error('MusicXML: no <part> found');

  // Carrier default: if anything in the score's metadata mentions
  // "piano" — title, part names, instrument names, score-instrument
  // names — pick the piano carrier. Covers "Piano Sonata", part-name
  // "Piano", and similar. Otherwise fall back to sine.
  const metaTexts = [title];
  for (const sel of ['score-part part-name', 'score-part instrument-name',
                     'score-part part-abbreviation', 'score-part score-instrument']) {
    for (const el of doc.querySelectorAll(sel)) {
      if (el.textContent) metaTexts.push(el.textContent);
    }
  }
  const isPianoScore = metaTexts.some(t => /\bpiano\b/i.test(t));
  const defaultCarrier = isPianoScore ? 'piano' : 'sine';

  const tempo = findTempo(doc);

  // Union notes from every part. Each part is parsed independently
  // with its own measure cursor / divisions / tie state, so voice +
  // piano + whatever else stream into one note list.
  const rawNotes = [];
  let endTime = 0;
  for (const part of parts) {
    const partEnd = parsePart(part, tempo, rawNotes);
    if (partEnd > endTime) endTime = partEnd;
  }

  if (rawNotes.length === 0) throw new Error('MusicXML: no audible notes found');

  // Pitch range → emitter count + base.
  let minMidi = Infinity, maxMidi = -Infinity;
  for (const n of rawNotes) {
    if (n.pitch < minMidi) minMidi = n.pitch;
    if (n.pitch > maxMidi) maxMidi = n.pitch;
  }
  // Base = one octave below the lowest note, aligned to an octave
  // boundary. Emitter count spans lowest→highest, capped at 64 (the
  // GPU tracer's wlPerSource texture width). When clipped, the notes
  // above the cap are dropped — we raise the base too so we don't
  // waste emitters on sub-bass registers.
  let baseMidi = Math.floor(minMidi / 12) * 12 - 12;
  let emitterCount = (maxMidi - baseMidi) + 1;
  if (emitterCount > 64) {
    // Prefer to drop low-octave headroom first, then high notes if
    // the piece's span is still wider than 64 semitones.
    const overflow = emitterCount - 64;
    baseMidi += overflow;
    if (baseMidi > minMidi) baseMidi = minMidi; // never start above the lowest note
    emitterCount = Math.min(64, (maxMidi - baseMidi) + 1);
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
      vel: 0.7,
      dur: Math.max(0.05, Number(n.duration.toFixed(4))),
    });
  }
  notes.sort((a, b) => a.time - b.time);

  const durationSec = endTime + 0.5;

  const welcome = outOfRange > 0
    ? title + `\n(imported from MusicXML; ${outOfRange} of ${rawNotes.length} notes out of range)\nPress ▶ to play`
    : title + '\n(imported from MusicXML)\nPress ▶ to play';

  return {
    version: 1,
    title,
    welcome,
    bpm: Math.round(tempo),
    duration: Number(durationSec.toFixed(3)),
    loop: false,
    global: {
      emitter: { count: emitterCount, wlMin: 400, wlMax: 700, raysPerSource: 320 },
      sensorCount: emitterCount,
      mode: 'chromatic',
      base: Number(baseHz.toFixed(2)),
      span: 1,
      carrier: defaultCarrier,
      volume: 0.25,
    },
    keyframes: [{ time: 0, elements: [] }],
    notes,
    automation: [],
  };
}
