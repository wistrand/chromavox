# Architecture: MIDI Input

MIDI input is a source type in `input.js` (alongside microphone, sine,
harmonics, noise, keyboard). Selected via the Source dropdown as
"MIDI in".

For Standard MIDI File (`.mid` / `.midi`) **import** — a separate path
that converts a file into a Chromavox song JSON instead of feeding
live MIDI events — see "MIDI file importer" in
[design-song-format.md](design-song-format.md).

## How it works

No AudioContext is created. `inputs.enable('midi', deviceId)` calls
`navigator.requestMIDIAccess({ sysex: true })` (falls back to basic
if SysEx is denied), attaches an `onmidimessage` handler to the
selected input port, and sets `inputs.active = true`.

The handler parses MIDI messages by status byte:

- **Note On (0x90)** with velocity > 0: `_midiNotes.set(note, vel / 127)`
- **Note Off (0x80)** or Note On with velocity 0: `_midiNotes.delete(note)`
- **CC (0xB0)**: dispatched to `inputs.onCC(cc, val)` callback (wired to
  the active controller's `handleCC` in main.js)
- **Sustain pedal (CC 64)**: holds notes after key release. Pedal off
  clears all sustained notes.
- **Poly aftertouch (0xA0)**: per-note level update from key pressure.
- **Channel pressure (0xD0)**: mono aftertouch applied to all held notes.
- **MPE slide (CC 74)**: per-note Y-axis. Maps to per-emitter wavelength
  shift (0 = red-shifted, 1 = blue-shifted). Center (64) = default
  wavelength range. Not forwarded to the encoder handler.
- **MPE pitch bend (0xE0)**: 14-bit (`vel << 7 | note`, center 8192).
  Per-note frequency detune applied as wavelength scaling.
- **Page buttons (CC 62/63)**: shift keyboard octave (same as `,`
  and `.` keys).

**Global pitch bend** (from touch strip or the wl-bend slider):
shifts all emitter wavelengths by up to ±200 nm. The slider
(`#wl-bend`, range -100 to 100) maps to `_globalBend` (-1 to +1).
Synced bidirectionally with MIDI pitch bend.

All messages are logged to the `#midi-debug` textarea (visible when
MIDI source is selected). Max 40 lines, auto-scrolls. System realtime
messages (status >= 0xF0, e.g. Active Sensing) are filtered before
processing.

## Router and device mapping

Controller detection and dispatch live in `MidiRouter`
(`docs/js/midi-devices/router.js`). The router owns singleton instances
of each device class and picks the first that matches the input port's
name:

```
devices = [MPCController, APCController, PushController, KeyboardDevice]
```

Each device class exposes:

- `static matches(name)` — name test (MPC: `'MPC'`; APC: `'APC'`; Push:
  `/push/i`; `KeyboardDevice.matches` always returns true → fallback).
- `static label` — human-readable mapper name shown in the MIDI options
  panel (e.g. "Push in-key", "MPC 4x4", "keyboard (linear)").
- `padMapper` — function or `null`, copied to `inputs._padMapper` after
  attach. KeyboardDevice builds its mapper in `attach(_, _, inputs)` so
  it can close over the current `inputs._kbdMidiBase`.

`inputs.directLevels(n, mode, base, step)` uses `inputs._padMapper` to map
pad notes to emitter indices:

- **Push**: `padMapper === null` → falls back to the default
  `padNoteToEmitter` (in-key layout:
  `row = floor((note - 36) / 8)`, `col = (note - 36) % 8`,
  `degree = row * rowOffset + col`, `rowOffset` from `fourthOffset()`).
- **MPC**: `(note) => note - 36` for the 4x4 grid.
- **APC**: `apcPadNoteToEmitter` — same in-key layout as Push but with
  note offset 0.
- **Generic keyboard** (`KeyboardDevice`): linear
  `note - inputs._kbdMidiBase`; base is resynced from the current "Base"
  Hz selector via `keyboard.onAttach` (wired in `main.js`).

All mappers bypass the FFT entirely — no spectral leakage, no bucket
bleed, exact pad/key-to-emitter mapping.

## `sample()` for MIDI

Returns `true` with no analyser work. `inputs.ctx` is null (no
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

- `inputs.enable('midi')`: request MIDI access, attach handler, set active.
  main.js then calls `attachPush()` (thin wrapper over `midi.attach(...)`
  on the `MidiRouter` instance) which picks the matching device and
  writes `inputs._padMapper` + the mapper-label element.
- `inputs.disable()`: detach handler, clear notes, set inactive.
  main.js calls `detachPush()` first, which calls `midi.detach()` (clears
  LEDs on all controller devices and unsets `inputs._padMapper`).
- Source change: `detachPush()` → `inputs.disable()` → `inputs.enable(newSrc)` →
  `attachPush()` (if new source is MIDI).

## GPU tracer wlPerSource texture

When MIDI input provides per-source wavelength overrides (via MPE
slide or global pitch bend), the GPU tracer uploads a `wlPerSource`
texture — R32F format, 64x2 texels — containing `(wlMin, wlMax)` per
source. The bounce shader reads this to emit per-source wavelength
bands instead of using the global `u_wlMin`/`u_wlMax` uniforms.

## What MIDI input does NOT do

- No AudioContext, no AnalyserNode, no FFT.
- No audio monitoring of MIDI notes (unlike the keyboard source which
  plays sine oscillators through the analyser).
- No MIDI output — that's the controller module's job
  (`docs/js/midi-devices/push.js`, `akai-mpc.js`, or `akai-apc.js`).
- No CC-to-element mapping — that's wired in main.js via the
  controller's `onCC` callback.
