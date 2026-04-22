# Architecture: Akai Controllers

Two modules: `docs/js/midi-devices/akai-mpc.js` (MPC Live II / One / X) and
`docs/js/midi-devices/akai-apc.js` (APC Mini MK2 / APC64). Both follow the same
interface pattern as `push.js` — own the MIDI output port, manage pad
LED colors, and dispatch encoder/fader CCs to element properties via
the shared `onCC` callback.

## Shared interface

Both export a class with the same API surface as Push:

```
attach(midiAccess, inputPort)
detach()
setScale(scaleName)
flush()
updateFromSensors(sensorBins, binCount, sensorCount, emitter, runtime)
setPixel(padIndex, r, g, b)
handleCC(cc, val)
onCC: null           // callback set by main.js
animating: false
pixels: Uint8Array
```

## Controller detection

`MidiRouter` (`docs/js/midi-devices/router.js`) picks the matching
device by port name — each device class exposes `static matches(name)`
and the router iterates `[mpc, apc, push, keyboard]`, first match wins.
A mapper-type indicator in the MIDI options panel shows which layout
is active:

- Port name includes `MPC` → `MPCController`, mapper `MPC 4x4`
- Port name includes `APC` → `APCController`, mapper `APC 8x8`
- Port name includes `Push` → Push, mapper `Push in-key`
- otherwise → `KeyboardDevice`, mapper `keyboard (linear)`
- Other MIDI keyboard → linear note mapper, mapper `keyboard (linear)`

---

## MPC module (`docs/js/midi-devices/akai-mpc.js`)

### Hardware

- **16 pads** in a 4x4 grid. Notes 36-51 (GM drum map).
- **4 Q-Link encoders** — CCs 16-19 (relative around 64).
- **Jog wheel** — CC 100 (relative).
- USB MIDI: Port 0 (Public) for SysEx/LEDs, Port 1 (Private) for pads.
  `attach()` finds the Public output port by name.

### Pad LED protocol

Direct per-pad RGB via SysEx (no palette):

```
F0 47 7F [pid] 65 00 04 [pad] [R] [G] [B] F7
```

Product IDs: `0x3B` MPC Live, `0x47` MPC Live II, `0x46` MPC One,
`0x3A` MPC X. RGB values 0-127 (7-bit). Auto-detected from port name.

### Flush

Diff-based: `_hwState` tracks the last-sent 7-bit RGB per pad. Only
changed pads get a SysEx message.

### Sensor visualization (4x4 grid)

All 16 pads show a spectrogram. Left 3 columns: emitter input levels
(N emitters downsampled to 4 rows, columns show brightness ramp).
Right column: sensor output (dominant wavelength color).

### CC dispatch

Q-Links (CC 16-19) are remapped to Push encoder CCs (71-74) so the
shared `onCC` handler in `main.js` works for both. Jog wheel (CC 100)
remaps to Push's selection wheel (CC 70).

### Emitter mapping

`mpcPadNoteToEmitter(note)`: 1:1 mapping from pad index (note - 36)
to emitter. No in-key layout (16 pads is too few).
`setScale()` is a no-op.

### Init animation

Spectral gradient sweep across all 16 pads over 1.5 s with decay
trail. Simpler than Push's polygon animation given the 4x4 grid.

---

## APC module (`docs/js/midi-devices/akai-apc.js`)

### Hardware

- **64 pads** in 8x8 grid. Notes 0x00-0x3F (0-63).
  Bottom-left = 0x00, row 0 = bottom. Formula: `note = row * 8 + col`.
- **9 faders** — CC 48-56 (absolute 0-127).
- **Track buttons** (notes 0x64-0x6B), **scene launch** (0x70-0x77).

### Pad LED protocol

Two methods:

1. **Fixed palette** (fallback): Note On `[0x96, pad, velocity]`.
   128-color palette, no custom colors. `_sendPadPalette` maps RGB
   to the nearest hue.
2. **Direct RGB via SysEx** (preferred):
   ```
   F0 47 7F 4F 24 [lenMSB] [lenLSB] [startPad] [endPad]
     [rMSB] [rLSB] [gMSB] [gLSB] [bMSB] [bLSB] ... F7
   ```
   Product ID `0x4F` (APC Mini MK2). 14-bit per channel
   (`MSB << 7 | LSB`). Supports pad range batching.

### Flush

Diff-based with batching: contiguous changed pads are sent in a single
SysEx message via `_sendPadRgbBatch`. Falls back to palette mode if
SysEx is unavailable.

### In-key layout + sensor visualization

Same two-pass rendering as Push:

**Pass 1** — in-key scale layout on all 64 pads. Same
`fourthOffset()` algorithm (duplicated from `push.js`). Pad colors:
idle dim cyan, root dim green, pressed bright yellow, disabled/out-of-
range black.

**Pass 2** — rightmost column (8 pads) overridden by sensor spectrogram
(dominant wavelength per row).

`setScale(scaleName)` updates `_rowOffset` and `_scaleLength` from
`SCALES`.

### Fader control with pickup mode

Faders 0-7 (CC 48-55) map to Push encoder CCs 71-78 (X, Y, rotation,
spin, hue, delay, size, height). Fader 9 (CC 56) maps to volume
(CC 79).

Since faders are absolute (not relative), **pickup mode** prevents
property jumps: the fader is ignored until it crosses the last-known
position, then tracks 1:1. Deltas are converted to relative-around-64
format for the shared `onCC` handler.

### Init animation

Same rotating polygon animation as Push — `playAnimation(kind, duration)`
extracts the polygon from `localPolygon(makeElement(kind))`, normalizes
to the 8x8 grid, draws spectral-colored edges via Bresenham with
decay trail. Default: prism, 2 seconds.

---

## Shared utilities

Several functions are duplicated across `push.js` and `akai-apc.js`:

- `fourthOffset(semitones)` — in-key row offset calculation
- Bresenham line drawing on the pixel grid
- `wavelengthToRGB` downsampling for sensor-to-pad color
- Scale degree → pad color logic

The hardware-specific parts (SysEx format, note-to-pad mapping, port
discovery) stay in each module.

## Limitations

- **MPC**: 16 pads (no in-key layout), 4 encoders (vs Push's 8),
  no external display. Controller mode must be manually activated.
- **APC**: no rotary encoders (faders only, pickup mode adds latency
  on first touch). APC64 protocol undocumented, assumed compatible.
- **Web MIDI SysEx**: requires `sysex: true` in `requestMIDIAccess`.
  Existing Push code already requests this.
