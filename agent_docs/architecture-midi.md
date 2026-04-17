# Architecture: MIDI Input

MIDI input is a source type in `mic.js` (alongside microphone, sine,
harmonics, noise, keyboard). Selected via the Source dropdown as
"MIDI in".

## How it works

No AudioContext is created. `mic.enable('midi', deviceId)` calls
`navigator.requestMIDIAccess({ sysex: true })` (falls back to basic
if SysEx is denied), attaches an `onmidimessage` handler to the
selected input port, and sets `mic.active = true`.

The handler parses 3-byte MIDI messages:

- **Note On (0x90)** with velocity > 0: `_midiNotes.set(note, vel / 127)`
- **Note Off (0x80)** or Note On with velocity 0: `_midiNotes.delete(note)`
- **CC (0xB0)**: dispatched to `mic.onCC(cc, val)` callback (wired to
  `push.handleCC` in main.js)

All messages are logged to the `#midi-debug` textarea (visible when
MIDI source is selected). Max 40 lines, auto-scrolls.

## Emitter mapping

`mic.directLevels(n, mode, base, step)` handles MIDI specially:
pad note → emitter index via `padNoteToEmitter(note)` from `push.js`.
This uses the Push in-key layout formula:

```
row = floor((note - 36) / 8)
col = (note - 36) % 8
degree = row * rowOffset + col
emitter = degree
```

Where `rowOffset` is the number of scale degrees per fourth
(chromatic=5, major/minor=3, pentatonic=2), computed from the
scale's semitone array by `fourthOffset()` in push.js.

This bypasses the FFT entirely — no spectral leakage, no bucket
bleed, exact 1:1 pad-to-emitter mapping.

## `sample()` for MIDI

Returns `true` with no analyser work. `mic.ctx` is null (no
AudioContext), so `micBands` must never be called — `directLevels`
returns an all-zeros Float32Array even when no notes are held
(not null), preventing the FFT fallback.

## Device selection

- **Auto-select**: prefers any port whose name matches "Live Port"
  (case-insensitive) for Push 3 compatibility (User Port is broken
  at the ALSA sequencer level on Linux — see `notes/push3-midi.md`).
  Falls back to the first available input.
- **Manual**: MIDI device dropdown (`#midi-device`) populated by
  `populateMidiDevices()` via `requestMIDIAccess().inputs`. Saved
  to / restored from localStorage (`chromavox-ui` key).
- **Hot-plug**: `access.onstatechange` re-attaches to the next
  available input if the current device disconnects.

## Device rows

The Audio in dropdown shows/hides rows based on source:

- `mic` → mic device row visible
- `midi` → MIDI device row + MIDI debug textarea visible
- all others → both hidden

## SysEx

SysEx access is requested for Push LED palette setup (`push.js`).
If the browser denies it, MIDI input still works — only LED colors
fall back to the Push's default palette. The SysEx request triggers
a browser permission prompt on first use.

## Lifecycle

- `mic.enable('midi')`: request MIDI access, attach handler, set active.
  main.js then calls `attachPush()` which creates the Push output
  connection.
- `mic.disable()`: detach handler, clear notes, set inactive.
  main.js calls `detachPush()` first to clear LEDs.
- Source change: `detachPush()` → `mic.disable()` → `mic.enable(newSrc)` →
  `attachPush()` (if new source is MIDI).

## What MIDI input does NOT do

- No AudioContext, no AnalyserNode, no FFT.
- No audio monitoring of MIDI notes (unlike the keyboard source which
  plays sine oscillators through the analyser).
- No MIDI output — that's `push.js`'s job.
- No CC-to-element mapping — that's wired in main.js via
  `push.onCC`.
