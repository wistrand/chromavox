# Design: Song JSON Format

## Overview

A song is a timeline of optical scenes with musical events. It combines
two layers:

1. **Scene keyframes** — snapshots of the optical bench (elements,
   emitter config, sensor config) at specific times, with interpolation
   between them. Elements morph position/rotation/size; new elements
   fade in; removed elements fade out.

2. **Note events** — timestamped emitter activations with velocity,
   duration, and optional per-note parameters. These drive the emitter
   levels (replacing mic/touch input during playback).

The format is designed to be:
- Human-readable JSON (no binary, no compression)
- Playable without audio input (the note list IS the input)
- Editable by hand or by a sequencer UI
- Compatible with the existing scene serialization

## Format

```json
{
  "version": 1,
  "title": "My Song",
  "bpm": 120,
  "duration": 32.0,

  "global": {
    "emitter": { "count": 24, "wlMin": 400, "wlMax": 700, "raysPerSource": 512 },
    "sensorCount": 24,
    "mode": "chromatic",
    "base": 130.81,
    "span": 1,
    "carrier": "acid",
    "partials": 6,
    "volume": 0.25
  },

  "keyframes": [
    {
      "time": 0,
      "elements": [
        { "id": "prism1", "kind": "prism", "x": 200, "y": 450, "size": 130, "material": "crown", "rot": 0.5 }
      ]
    },
    {
      "time": 8.0,
      "elements": [
        { "id": "prism1", "kind": "prism", "x": 350, "y": 300, "size": 130, "material": "crown", "rot": 1.2 },
        { "id": "mirror1", "kind": "mirror", "x": 400, "y": 600, "size": 150, "material": "mirror", "rot": 2.0 }
      ]
    },
    {
      "time": 16.0,
      "elements": [
        { "id": "prism1", "kind": "prism", "x": 200, "y": 450, "size": 180, "material": "flint", "rot": 0.5 },
        { "id": "mirror1", "kind": "mirror", "x": 400, "y": 600, "size": 150, "material": "mirror", "rot": 3.5 }
      ]
    }
  ],

  "notes": [
    { "time": 0.0, "emitter": 5, "vel": 1.0, "dur": 0.5 },
    { "time": 0.5, "emitter": 7, "vel": 0.8, "dur": 0.25 },
    { "time": 1.0, "emitter": 5, "vel": 0.6, "dur": 1.0 },
    { "time": 2.0, "emitter": [3, 5, 7], "vel": 1.0, "dur": 0.5 },
    { "time": 4.0, "emitter": 10, "vel": 0.9, "dur": 2.0, "wl": 550 }
  ],

  "automation": [
    { "param": "volume", "points": [[0, 0.25], [8, 0.5], [16, 0.25]] },
    { "param": "carrier", "points": [[0, "sine"], [8, "acid"], [24, "noise"]] },
    { "param": "acidRes", "points": [[0, 0.3], [4, 0.9], [8, 0.5]] }
  ]
}
```

## Fields

### `global`

Synth and emitter configuration that applies for the entire song.
Overrides the UI settings during playback. On stop, UI settings
restore.

- `emitter`: count, wavelength range, rays — same as scene.emitter
- `sensorCount`: sensor count for the song
- `mode`, `base`, `span`: mic-side scale settings (applied via
  `onGlobal` callback to `mic-mode`, `mic-base`, `chromatic-span`)
- `carrier`: synth carrier mode (applied to `synth-carrier`)
- `partials`, `volume`: synth settings

The `global` section is applied once on load via the `onGlobal`
callback, guarded by the `_globalApplied` flag. The flag is set to
`true` on first application and only reset to `false` in `load()` —
so global settings apply once per song load, not on restart or seek.

### `keyframes`

Array of scene snapshots sorted by `time` (seconds). Each keyframe
has an `elements` array. Between keyframes, elements are linearly
interpolated:

- **Position** (`x`, `y`): linear lerp
- **Rotation** (`rot`): shortest-path angular lerp
- **Size** (`size`, `w`, `h`, `radius`): linear lerp
- **Material**: discrete switch at the midpoint between keyframes
- **Color** (`color`): RGB component lerp if both are hex strings

**Element matching** across keyframes uses the `id` field (string).
An element present in keyframe A but absent in keyframe B fades out
(intensity → 0) over the transition. An element in B but not A fades
in. This allows elements to appear/disappear over the song timeline.

**Spin**: if an element has `spin` in a keyframe, it applies from
that keyframe until the next one overrides it. Between keyframes,
`rot` interpolation adds on top of the spin accumulation.

### `notes`

Array of note events sorted by `time` (seconds). Each note:

- `time`: onset time in seconds from song start
- `emitter`: emitter index (0-based) or array of indices for chords
- `vel`: velocity 0-1 (maps to micLevel for that emitter)
- `dur`: duration in seconds. The emitter level ramps to `vel` at
  onset (attack ~5ms) and ramps to 0 at offset (release ~20ms).
- `wl` (optional): override wavelength for this note's emitter.
  Sets `wlPerSource` for that emitter during the note.

Notes are the input to the optical system — they replace touch/mic
input during playback. Multiple notes on the same emitter overlap
additively (clamped to 1.0).

**Timing**: `time` is in seconds. If `bpm` is set, a helper converts
beat positions: `timeFromBeat(beat) = beat * 60 / bpm`. The format
stores seconds, not beats, so BPM is informational / for UI grid
snapping.

### `automation`

Array of parameter automation lanes. Each lane:

- `param`: parameter name (string). Supported:
  - `volume` — master synth volume (0-1)
  - `carrier` — carrier mode string (discrete: "sine"/"noise"/"acid")
  - `acidRes`, `acidEnv` — acid filter parameters (0-1)
  - `partials` — partial count (1-8, stepped)
  - `mode` — scale mode (discrete)
  - `base` — base frequency Hz
  - `bend` — global wavelength bend, -1..+1 (same as the `wl-bend`
    slider). Lerp between points gives smooth pitch-bend automation
    (folk-song "singing" glide, siren sweeps, etc.). The UI slider
    is updated in sync.
  - Any element property via `element.id.property` syntax:
    `"prism1.rot"`, `"mirror1.x"` — overrides keyframe interpolation
- `points`: array of `[time, value]` pairs, sorted by time.
  Numeric values interpolate linearly. String values switch at the
  point time (discrete).

Automation overrides keyframe interpolation for the targeted
parameter. This allows fine-grained control (e.g. a filter sweep
that doesn't align with keyframe boundaries).

## Playback engine

### State machine

```
STOPPED → PLAYING → STOPPED
                  → PAUSED → PLAYING
                           → STOPPED
```

### Per-frame update (inside the RAF loop)

```js
function updateSong(songTime) {
  // 1. Interpolate scene keyframes → apply to scene.elements
  const [kfA, kfB, t] = findKeyframePair(songTime);
  lerpElements(scene, kfA, kfB, t);

  // 2. Evaluate active notes → build micLevels
  const levels = new Float32Array(emitterCount);
  for (const note of activeNotes(songTime)) {
    const env = noteEnvelope(songTime, note);
    const emitters = Array.isArray(note.emitter) ? note.emitter : [note.emitter];
    for (const e of emitters) {
      levels[e] = Math.min(1, levels[e] + note.vel * env);
    }
  }
  scene.runtime.micLevels = levels;

  // 3. Evaluate automation → apply to synth/scene params
  for (const lane of song.automation) {
    const val = evalAutomation(lane, songTime);
    applyParam(lane.param, val);
  }
}
```

### Element interpolation

```js
function lerpElements(scene, kfA, kfB, t) {
  const mapA = new Map(kfA.elements.map(e => [e.id, e]));
  const mapB = new Map(kfB.elements.map(e => [e.id, e]));
  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

  scene.elements = [];
  for (const id of allIds) {
    const a = mapA.get(id);
    const b = mapB.get(id);
    if (a && b) {
      // Both present: interpolate
      scene.elements.push(lerpElement(a, b, t));
    } else if (a) {
      // Fading out: present in A, absent in B
      const el = { ...a };
      el._opacity = 1 - t; // renderer uses this for fade
      scene.elements.push(el);
    } else {
      // Fading in: absent in A, present in B
      const el = { ...b };
      el._opacity = t;
      scene.elements.push(el);
    }
  }
}
```

### Note envelope

Simple AD envelope per note:

```js
function noteEnvelope(time, note) {
  const attack = 0.005; // 5ms
  const release = 0.02; // 20ms
  const noteEnd = note.time + note.dur;
  if (time < note.time) return 0;
  if (time < note.time + attack) return (time - note.time) / attack;
  if (time < noteEnd) return 1;
  if (time < noteEnd + release) return 1 - (time - noteEnd) / release;
  return 0;
}
```

## Implementation plan

### Phase 1: Playback only (MVP)

1. **`docs/js/song.js`** — Song loader + playback engine.
   - `loadSong(json)` → parsed song object
   - `SongPlayer` class with `play()`, `pause()`, `stop()`, `seek(t)`
   - Per-frame `update(dt)` called from the RAF loop
   - Keyframe interpolation + note evaluation + automation
   - Outputs: `scene.elements` (mutated), `scene.runtime.micLevels`

2. **`main.js` integration** — when a song is playing:
   - Disable touch/mic input (song's notes drive emitters)
   - Call `songPlayer.update()` before `tracer.trace()`
   - Show transport controls (play/pause/stop/seek bar)

3. **UI** — minimal transport bar below the toolbar:
   - Play/Pause button, Stop button, time display, seek slider
   - Song selector (load from `songs/` folder or file input)

### Phase 2: Authoring

4. **Timeline UI** — horizontal scrollable lane view:
   - Element lanes showing keyframe markers (draggable)
   - Note lane with piano-roll-style blocks
   - Automation lanes with breakpoint curves
   - Snap to grid (configurable: beat, bar, free)

5. **Recording** — capture live touch/mic input as note events:
   - Start recording, play the instrument, stop
   - Touch events → note events with timing + velocity
   - Optionally record element movements as keyframes

6. **Export** — save song as JSON, share via URL or file.

### Phase 3: Polish

7. **Loop regions** — `loopStart` / `loopEnd` fields
8. **Tempo changes** — automation lane for BPM
9. **Per-note effects** — glide, accent, slide (303-style)
10. **Preset songs** — shipped in `docs/songs/` folder

## File location

Songs stored in `docs/songs/`. Not in `presets/` — presets are
static scenes, songs are temporal sequences. Index file:
`docs/songs/index.json`.

## Compatibility

The song format references scene elements by `id` (string, user-
assigned in the song file). These IDs are independent of the runtime
`genId()` counter. On playback, elements are created fresh from the
keyframe data — no dependency on existing scene state.

The `global` block overrides UI settings during playback. On stop,
previous settings restore (saved before play starts).
