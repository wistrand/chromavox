# Architecture: Ableton Push 2/3 Integration

`docs/push.js` — owns the MIDI output port, 8x8 RGB pixel map,
dynamic palette management, sensor-to-pad color mapping, and
encoder-to-element dispatch. Separated from `mic.js` so the mic
module stays a generic MIDI note/CC source.

## Hardware facts

The Push hardware uses a **fixed** note-to-pad mapping:

- Note 36 = bottom-left pad (row 0, col 0).
- Note 37 = next pad right (row 0, col 1).
- Note 99 = top-right pad (row 7, col 7).
- Formula: `note = 36 + row * 8 + col`.

This mapping is always the same regardless of scale/key settings.
The "in-key" layout visible on the Push's display is Ableton Live
software, not the hardware. Without Live running, pads send
sequential notes 36-99.

LED addressing follows the same fixed mapping: sending Note On for
note N always lights the pad at position N, one pad per note.

See `notes/push-midi-map.md` for the full pad/button/encoder/LED
reference.

## In-key layout (computed in software)

Since we talk to the raw hardware, `push.js` implements the in-key
layout itself. Each pad's position maps to a scale degree:

```
degree = row * rowOffset + col
```

Where `rowOffset` = the number of scale degrees in a perfect fourth
(5 semitones). Computed by `fourthOffset(semitones)`:

| Scale | Row offset | Degrees per octave |
|---|---|---|
| chromatic | 5 | 12 |
| major, minor | 3 | 7 |
| pentaMajor, pentaMinor | 2 | 5 |
| wholeTone | 2 | 6 |
| blues | 2 | 6 |

`push.setScale(scaleName)` updates `rowOffset` and `scaleLength`.
Called from `syncKeyboardScale()` in main.js whenever Mode changes.

The degree is used as both the emitter index (for input) and the
lookup key for LED colors (for output). Pads at the same degree
(due to the row overlap inherent in the fourths layout) get the
same color — which is correct, they represent the same note.

## Pixel map

Source of truth for pad colors: `push.pixels`, a `Uint8Array(192)`
holding 64 RGB triplets (3 bytes each, index = pad position 0-63).

Any code can call `push.setPixel(padIndex, r, g, b)`. Nothing is
sent to the Push until `push.flush()`.

## Dynamic palette

The Push's 128 palette entries (index 0 = off, 1-127 = colors) are
managed dynamically:

1. Colors are quantized to 15-bit keys (5 bits/channel = 32 levels)
   via `colorKey(r, g, b)`.
2. `_keyToIdx` maps each unique quantized color to a palette index.
3. New colors allocate a free palette slot and upload via SysEx:
   `F0 00 21 1D 01 01 03 [idx] [rL rH gL gH bL bH wL wH] F7`.
4. Palette entries are reference-counted; freed when no pad uses them.
5. If SysEx isn't available, allocation still works but the Push
   shows its default palette colors (won't match, but won't crash).

## Flush (minimum diff, two-pass ordering)

`push.flush()` compares `_wantState` (desired palette index per pad)
against `_hwState` (what the Push currently shows). Only changed
pads get a Note On message:

```
[0x90, 36 + padIndex, paletteIndex]
```

The diff is sent in two passes: non-zero palette indices (lit pads)
first, then zero indices (black pads) last. This avoids a visible
flash-to-black on transitions where a pad changes color — the new
color arrives before the old one is cleared.

A frame where nothing changed sends zero MIDI bytes.

## Sensor-to-pad color update (two-pass rendering)

`push.updateFromSensors(sensorBins, binCount, sensorCount, emitter, runtime)`
runs each frame when the Push output is connected. Rendering is
split into two passes:

**Pass 1 — in-key layout colors (all 64 pads):**

Every pad gets a base color from its scale position:

- **Idle enabled pad**: dim cyan (0, 30, 40).
- **Root note** (degree % scaleLength == 0): dim green (0, 40, 0).
- **Pressed** (micLevels > 0.01): bright yellow (255, 200, 0).
- **Disabled or beyond emitter count**: black (0, 0, 0).

**Pass 2 — sensor spectrogram (rightmost column only):**

Column 7 (8 pads) shows a downsampled sensor spectrogram. N sensors
are compressed to 8 rows using the dominant wavelength per row
(strongest bin, not averaged RGB). Non-zero sensor values override
the in-key color from pass 1. The column is vertically flipped so
the top pad corresponds to the top of the bench.

Finally calls `flush()`.

## Encoder → element control

Push track encoders (CC 71-78) send relative values around 64.
`mic.onCC` dispatches to `push.handleCC` → `push.onCC` callback,
wired in main.js:

| CC | Property | Step |
|---|---|---|
| 71 | X position | ±0.5 bench units |
| 72 | Y position | ±0.5 bench units |
| 73 | Rotation | ±0.02 rad |
| 74 | Spin | ±0.4 deg/s (inverted sign) |
| 75 | Hue (color shift) | ±0.5 deg RGB rotation |
| 76 | Delay (delayK) | ±0.000005 |
| 77 | Size / Width | ±0.3 |
| 78 | Height / Radius | ±0.3 |

All encoder steps use `Math.sign(delta)` to clamp to ±1 per detent,
so the step column above is the exact per-click amount.

Only affects the currently selected element (`ui.selected`). Each
CC event brackets a `beginEdit` / `endEdit` for undo/redo.

**Auto-select**: the first CC received when nothing is selected
auto-selects `scene.elements[0]` via `ui.select()` and returns
without applying any delta. Subsequent CCs apply deltas normally.
The two steps are split so that `select`'s `onChange` callback
doesn't interact with `beginEdit` / `endEdit`.

## Init animation

On attach, `push.playAnimation(kind, duration)` plays a short
animation on the 8x8 pad grid (default: `'prism'`, 2 seconds).
The polygon is obtained from `localPolygon(makeElement(kind))`,
normalized to fit the grid. Three spectral-colored edges are drawn
using Bresenham lines on the 8x8 pixel grid. The animation includes
a decay trail (0.85/frame) and fade in/out. The `animating` flag
suppresses normal sensor rendering while the animation is playing.

Any element kind can be passed — the polygon is extracted the same
way regardless of kind.

## Lifecycle

- **Attach**: `push.attach(midiAccess, inputPort)` — finds the
  matching output port by name, tests SysEx with a dummy palette
  entry, resets pixel map and palette state, sends 64 Note On
  messages with velocity 0 to clear any LEDs left over from a
  previous session, then plays the init animation.
- **Detach**: `push.detach()` — clears all pad LEDs via flush,
  nulls output.
- **Scale change**: `push.setScale(scaleName)` — updates row offset
  and scale length from the `SCALES` table. Called from
  `syncKeyboardScale()` in main.js whenever Mode changes, and also
  called explicitly at startup after `restoreUiState`.

Attach/detach are called from `attachPush()` / `detachPush()` in
main.js at every MIDI enable/disable/switch site.

## Push 3 Linux quirk

The Push 3's User Port (hw:X,0,1) is broken at the ALSA sequencer
level — only delivers Active Sensing, no notes. The Live Port
(hw:X,0,0) works. `mic.js` auto-selects the Live Port by name
matching. See `notes/push3-midi.md` for details.

## Push transport buttons

- **Play** (CC 85): toggles Audio out on press (clicks `synthBtn`).

## Push 3 CC differences from Push 2

Some CCs behave differently on Push 3 hardware compared to the Push 2
spec:

- **CC 70** (0x46) — large selection wheel. Cycles through scene
  elements (see below). Not listed in the Push 2 spec.
- **CC 79** (0x4F) — volume encoder. Adjusts synth master volume
  (see below). Push 2 spec calls this "Master encoder".
- Both CC 70 and CC 79 send `val=127` for clockwise and `val=1` for
  counter-clockwise. This differs from track encoders (CC 71-78)
  which use relative-around-64.

## Element selection via Push wheel

CC 70 cycles through `scene.elements`. Clockwise = next, counter-
clockwise = previous, wraps around. If nothing is selected, the
first turn picks `scene.elements[0]`.

## Volume control via Push

CC 79 adjusts the synth volume slider by +/-2 per detent. Updates
both `synth.setVolume` and the DOM slider/label.

## Push display sidecar

The Push 3 display (960x160, USB bulk) can't be driven from the
browser (WebUSB can't claim interfaces on composite USB devices).
A Node.js sidecar (`tools/push-display.js`) bridges WebSocket to
USB. See `notes/push3-display.md` for protocol details.

- **Start**: `node serve.js --push-display` (spawns child process),
  or standalone `cd tools && node push-display.js`.
- **Dependencies**: `usb`, `pngjs`, `ws` (in `tools/package.json`).
- **Hello frame**: on startup, composites a spectral gradient + logo
  + CHROMAVOX text onto the display.
- **Protocol**: browser connects via `ws://localhost:9100`. Each
  message is a 4-byte header (x, y as uint16 LE) + PNG bytes. The
  sidecar composites regions onto the base frame using a regionMap
  and refreshes at 30fps.
- **Browser side** (`push.js`): `_connectDisplay()` connects with
  retry every 2s. Sends two PNG regions per update at ~10fps: bench
  canvas (left, progressive-halving downsample from GL readPixels)
  and sensor spectrograms (right, rendered from sensorBins).
  `_sendRegionPng(x, y, canvas)` uses `canvas.toBlob('image/png')`.
- **preserveDrawingBuffer**: WebGL context uses
  `preserveDrawingBuffer: true` for reliable GL readPixels.
- **Progressive halving downsample**: bench bitmap ping-pongs between
  two offscreen canvases, halving dimensions each step (~2:1) with
  bilinear `imageSmoothingEnabled` for quality. Preserves thin ray
  lines that single-step downsampling would lose.

## Future extensions

- **Scene buttons** (CC 36-43): preset load.
- **Touch strip**: map to sim rate or ray width.
- **Selection wheel LED feedback**: highlight the selected element on
  the Push display.
