# MIDI Input — Design Notes

## What MIDI provides vs. the mic path

The mic path (`mic.js`) feeds an `AnalyserNode`, which `micBands()`
bins into N amplitude buckets. Each bucket drives one emitter source's
intensity. The mapping is indirect: audio → FFT → bucket → emitter →
ray → sensor → synth.

MIDI gives discrete, exact events: note number, velocity, on/off
timing, plus continuous controllers (CC), pitch bend, aftertouch. No
FFT noise, no bucket bleed, no latency from the analyser's smoothing
window.

## Five ways MIDI could drive the system

### 1. Emitter source — replace the FFT path

Each MIDI note maps to an emitter index. Note-on sets
`micLevels[i] = velocity / 127`; note-off sets it to 0. The mapping
follows the same scale logic the keyboard source already uses:
`scaleFreq(base, scaleName, i, stepDeg)` finds which emitter index
corresponds to each MIDI note number.

Drop-in integration: slots into `scene.emitter.micLevels` exactly
where the FFT buckets go. Everything downstream (rays, sensors,
synth) works unchanged. Pressing a MIDI key lights up the
corresponding emitter row with precise timing and zero bucket bleed.

Difference from the existing keyboard source: the keyboard source
generates a triangle-wave oscillator routed through the analyser, so
the FFT still runs. MIDI would skip the oscillator + analyser
entirely — cleaner, lower latency, no harmonic leakage into adjacent
buckets.

Polyphony maps naturally: multiple notes on = multiple emitters lit.

### 2. Element property control via CC

MIDI CC messages (knobs, sliders, mod wheel) drive element properties
in real time:

- CC1 (mod wheel) → selected element's `spin`
- CC2-4 → selected element's x, y, rotation
- CC7 (volume) → selected element's `delayK`
- CC74 (brightness) → selected element's color hue

A knob twist rotates a prism; a fader adjusts delay depth. Each CC
change calls `beginEdit` / mutate / `onChange` the same way the
property-panel sliders do.

Mapping could be hardcoded (specific CC numbers → specific
properties) or user-configurable via MIDI-learn (click a UI control,
twist a knob, binding stored).

### 3. Per-element MIDI channel assignment

Each placed element assigned a MIDI channel (1-16). Notes on that
channel drive that element's properties:

- Note number → rotation angle (0-127 → -180°..+180°)
- Velocity → scale/size
- Aftertouch → spin rate
- Pitch bend → x-position offset

Gives 16 independently-controllable elements from a single MIDI
controller. Combined with a DAW sequencer, you could choreograph a
prism rotation, a mirror sweep, and a slow-glass delay ramp as
parallel MIDI tracks.

### 4. Sensor output as MIDI out

Inverse direction: sensor deposits generate MIDI note messages. Each
sensor becomes a MIDI note; intensity maps to velocity. A prism
splitting white light into a rainbow produces a rising arpeggio as
different wavelengths hit different sensors.

Turns Chromavox into a MIDI instrument: audio in → optical simulation
→ MIDI out → external synth. The external synth's timbre replaces the
built-in additive synth.

Combined with MIDI in (#1), this gives a full MIDI-to-MIDI transform
where the optical bench is the "effect" in between.

### 5. Transport / scene control

MIDI program change → load a preset. MIDI start/stop → toggle audio
in/out. MIDI clock → sync `simRate` to external tempo (delay time
quantized to beat divisions).

Less musically interesting than #1-4 but useful for live performance.

## Implementation surface

All five share a common entry point: Web MIDI API
(`navigator.requestMIDIAccess()`). A new `midi.js` module would:

1. Request MIDI access (requires secure context, same as mic).
2. List available MIDI input/output ports (dropdown, same pattern as
   mic/synth device pickers).
3. Attach `onmidimessage` handler to the selected input port.
4. Dispatch messages based on the chosen mode.

The handler parses 3-byte MIDI messages: `[status, data1, data2]`.
Status byte encodes message type + channel. ~20 lines of parsing.

For #1 (emitter control): handler writes `scene.emitter.micLevels`,
calls `markDirty()`. No tracer/renderer/synth changes.

For #2 (CC → element properties): handler calls `ui.beginEdit()`,
mutates property, `ui.endEdit()` + `markDirty()`. Same path as
property-panel sliders.

For #4 (MIDI out): `synth.js` or a new module opens a MIDI output
port, sends note-on/off each frame based on `sensorBins` changes.

## Recommendation

**#1 is highest-value, lowest-cost.** Replaces the noisiest part of
the input chain (FFT bucketing) with exact note data, drops into the
existing `micLevels` array with no downstream changes. A MIDI
keyboard becomes a first-class Chromavox input.

**#2 is most fun for live performance** but has higher design cost
(CC mapping UI, MIDI-learn, per-element binding persistence).

**#4 is architecturally elegant** (bench as MIDI effect processor)
but needs careful thought about latency, note-off detection, and
avoiding MIDI floods from 64 sensors at 60fps. See the detailed
MIDI out section below.

## MIDI out — detailed design

### Core idea

Each sensor maps to a MIDI note (same pitch ladder as the synth).
When light arrives at a sensor, a note-on is sent; when it stops, a
note-off. Velocity tracks intensity. The optical bench becomes a
MIDI instrument or effect processor that an external synth or DAW
can listen to.

### Note mapping

Same logic as the synth side: sensor `i` maps to a pitch via
`scaleFreq(base, scaleName, i, stepDeg)`. Convert to the nearest
MIDI note number: `Math.round(12 * Math.log2(freq / 440) + 69)`.
In chromatic mode with base C3, sensor 0 = MIDI 48 (C3), sensor
1 = MIDI 49, etc.

### On/off detection

Raw `sensorBins` is noisy frame-to-frame. Need hysteresis:

- **Note-on**: total energy for sensor `s` crosses above a threshold
  (e.g., 0.05) AND was below it on the previous frame.
- **Note-off**: energy drops below a lower threshold (e.g., 0.02)
  for N consecutive frames (debounce, e.g., 3 frames = 50ms).
- **Velocity**: map peak energy at note-on time to 1-127. Use the
  IIR-smoothed `_displayBins` (from the spectrum readout) rather
  than raw bins, so velocity doesn't spike on single-frame noise.

Per-sensor state: `{ active: bool, offCount: int, lastVelocity: int }`.

### Continuous control

Beyond on/off, sensor energy could drive:

- **Aftertouch** (polyphonic): ongoing intensity → aftertouch value
  for that note. Updates each frame if the value changed by more
  than a threshold (avoids flooding).
- **CC per sensor group**: average intensity of a sensor range →
  a CC value. E.g., "how much red reaches the right wall" as CC1.

### Message rate control

At 60fps with 24 sensors, naively sending per-frame updates would
be 1440 messages/second. MIDI serial bandwidth is ~3125 bytes/sec
(31.25 kBaud), so even USB-MIDI (which is faster) benefits from
throttling:

- Only send note-on/off on state transitions (not every frame).
- Throttle aftertouch/CC to every 3rd frame (~20fps) or on
  value-change-above-threshold.
- Batch note-offs: if multiple sensors go dark on the same frame,
  send all note-offs together.

### Channel assignment

- **Single channel (default)**: all sensors on channel 1. Simple.
  External synth sees polyphonic input.
- **Multi-channel**: sensor groups on different channels. E.g.,
  sensors 0-7 on ch1, 8-15 on ch2, 16-23 on ch3. Lets a DAW
  route different sensor ranges to different instruments.
- **Mirror input channel**: if MIDI in is on channel N, MIDI out
  uses channel N+1 (or a configurable offset). Useful for
  MIDI-in → optical transform → MIDI-out chains without feedback.

### Combined with MIDI in (#1)

The full loop: MIDI keyboard → emitter micLevels → rays → optics →
sensors → MIDI out → external synth. The optical bench is a
real-time audio-rate MIDI effect. A chord played on the keyboard
gets spectrally split by a prism, delayed by slow-glass, filtered
by colored mirrors, and re-emitted as a transformed chord on the
output — different voicing, different timing, different timbre
depending on what's on the bench.

### Combined with built-in synth

MIDI out and the built-in additive synth can coexist. The synth
plays what reaches the sensors; MIDI out sends note messages for
the same data. The user can mute the built-in synth and use only
MIDI out, or layer both.

### Implementation sketch

New module `midi-out.js` (or extend `midi.js` to cover both
directions):

```
class MidiOut {
  constructor() {
    this.output = null;       // MIDIOutput port
    this.channel = 0;         // 0-15
    this.sensorState = [];    // per-sensor { active, offCount, vel }
    this.onThreshold = 0.05;
    this.offThreshold = 0.02;
    this.offDebounce = 3;
  }
  setOutput(port) { ... }
  update(sensorBins, binCount, sensorCount, base, scale, step) {
    // Per sensor: sum bins → energy.
    // Compare against thresholds.
    // Send note-on / note-off / aftertouch as needed.
  }
}
```

Called from the frame loop alongside `synth.update()`. Reads the
same `sensorBins` array. Output port selected via a dropdown in
the Audio out menu (same device-enumeration pattern as the synth
output device picker).

### Latency

Web MIDI send is near-instant (USB-MIDI has ~1ms jitter). The
dominant latency is the optical simulation: a MIDI note-in triggers
an emitter, rays trace in the same frame (~16ms), sensors deposit,
MIDI note-out sends. Total: ~1 frame = 16ms. With delay materials,
add the transit time (e.g., 200ms for a slow-glass crossing).

That transit-time delay is the *feature* — it's the physical delay
the user placed on the bench, now expressed as MIDI timing.

## Constraints

- Web MIDI API requires secure context (HTTPS or localhost).
- Firefox needs a flag (`dom.webmidi.enabled`). Chrome/Edge native.
- Permission prompt on first request.
- SysEx (not needed for notes/CC) requires an additional flag.
- Mic path should remain functional alongside MIDI — they're
  complementary. A "Source" dropdown entry (`midi`) next to
  `microphone`, `keyboard`, `sine`, etc. is the natural home.
