# Plan: Akai Controller Integration

Two new modules: `docs/akai-mpc.js` (MPC Live II / One / X) and
`docs/akai-apc.js` (APC Mini MK2 / APC64). Both follow the same
architecture as `push.js` — own the MIDI output port, manage pad
LED colors, and dispatch encoder/knob CCs to element properties.

## Shared design

Both modules export the same interface as `push.js`:

```js
{
  attach(midiAccess, inputPort),
  detach(),
  setScale(scaleName),
  flush(),
  updateFromSensors(sensorBins, binCount, sensorCount, emitter, runtime),
  setPixel(padIndex, r, g, b),
  handleCC(cc, val),
  onCC: null,           // callback set by main.js
  animating: false,
  pixels: Uint8Array,
}
```

`main.js` detects the device by MIDI port name and instantiates
the right module. A factory function `createController(midiAccess,
inputPort)` returns the matching controller or null:

```js
if (name.includes('MPC'))  return new AkaiMPC(...)
if (name.includes('APC'))  return new AkaiAPC(...)
if (name.includes('Push')) return new Push(...)
```

This replaces the current Push-only `attachPush` / `detachPush`.

---

## Module 1: `akai-mpc.js` (MPC Live II / One / X)

### Hardware facts

- **16 pads** in a 4x4 grid. Notes 36-51 (standard GM drum map,
  same as Push bottom-left quadrant).
- **4 Q-Link encoders** — assignable CCs. Relative or absolute
  depending on MPC mode. Default CCs vary by program; controller
  mode typically sends CC 16-19.
- **Jog wheel** — CC 100, relative (increment/decrement).
- **Transport buttons** — Play, Stop, Rec send standard MMC or
  note on/off. Exact mapping depends on controller mode config.
- **7" touchscreen** — NOT externally addressable. Internal Linux
  framebuffer only.

### Pad LED protocol

Direct per-pad RGB via SysEx (no palette management needed):

```
F0 47 7F [pid] 65 00 04 [pad] [R] [G] [B] F7
```

Product IDs:
- `0x3B` — MPC Live (original)
- `0x47` — MPC Live II
- `0x46` — MPC One
- `0x3A` — MPC X

RGB values are 7-bit (0-127). Can be sent individually per pad
or batched (multiple pad+RGB groups in one SysEx message — extend
data length field accordingly).

### USB MIDI ports

The MPC exposes 4 MIDI endpoints in controller mode:
- Port 0 (`MPC Public`) — SysEx and LED control
- Port 1 (`MPC Private`) — buttons, pads, note on/off
- Port 2 (`MIDI Port A`) — external MIDI routing
- Port 3 (`MIDI Port B`) — external MIDI routing

Web MIDI API sees all four. LED commands go to Port 0 (Public).
Pad input arrives on Port 1 (Private). `attach()` must find both
ports by name.

### Implementation plan

**Phase 1: Pad input + LED output**
1. `attach(midiAccess, inputPort)` — find the Public output port
   by matching device name. Store both input (Private) and output
   (Public) ports.
2. Auto-detect product ID from device name or SysEx device inquiry
   (`F0 7E 00 06 01 F7` → response contains product ID).
3. `setPixel(padIndex, r, g, b)` — store in `pixels` array (48
   bytes = 16 pads × 3 channels).
4. `flush()` — diff `pixels` against `_hwState`, send SysEx for
   changed pads only. No palette management needed — direct RGB.
5. Clear all pads on attach (send black to all 16).

**Phase 2: Sensor visualization on 4x4 grid**
1. `updateFromSensors(...)` — downsample N sensors to 4 rows.
   Each row gets the dominant wavelength color (same algorithm as
   Push but with 4 rows instead of 8).
2. Left 3 columns (12 pads) show in-key scale layout. Right column
   (4 pads) shows sensor spectrogram.
3. Alternatively: all 16 pads show a 4x4 spectrogram (no in-key
   layout) since 16 pads is too few for a useful keyboard.

**Phase 3: Q-Link encoders → element control**
1. Map 4 Q-Links to the most useful element properties:
   - CC 16: X position
   - CC 17: Y position
   - CC 18: Rotation
   - CC 19: Size/Width
2. Jog wheel (CC 100): cycle element selection (same as Push CC 70).
3. Transport: Play button toggles Audio out.

**Phase 4: Init animation**
1. 4x4 is too small for the polygon animation. Use a simple color
   sweep: spectral gradient scrolling across all 16 pads over 1s.

### Limitations
- 16 pads vs Push's 64 — in-key keyboard layout is marginal.
  Consider making all 16 pads direct emitter triggers (1:1 mapping,
  no scale layout) for up to 16 emitters.
- 4 encoders vs Push's 8 — only 4 element properties controllable.
  Could use a shift/page button to switch encoder bank.
- No external display.
- Controller mode must be manually activated on the MPC (Menu →
  controller mode icon).

---

## Module 2: `akai-apc.js` (APC Mini MK2 / APC64)

### Hardware facts

**APC Mini MK2:**
- **64 pads** in 8x8 grid. Notes 0x00-0x3F (0-63).
  Bottom-left = 0x00, bottom-right = 0x07, top-left = 0x38.
- **9 faders** — CC 48-56 (absolute, 0-127).
- **8 track buttons** — notes 0x64-0x6B (single-color red LED).
- **8 scene launch buttons** — notes 0x70-0x77 (single-color green).
- **No rotary encoders.**
- **No display.**

**APC64:**
- **64 pads** in 8x8 grid. Layout similar to APC Mini MK2.
- **8 touch strips** (instead of faders/encoders).
- **Standalone MIDI capability** (CV/gate outputs).
- Protocol documentation not publicly available; likely similar
  to APC Mini MK2 given shared product line.

### Pad LED protocol

Two methods for controlling pad LEDs:

**Method 1: Fixed palette via velocity (simple)**
Note On message: `[0x9C] [pad] [velocity]`
- MIDI channel (byte 1 high nibble) controls behavior:
  - Ch 0 (0x90): 10% brightness
  - Ch 6 (0x96): 100% brightness (solid)
  - Ch 7 (0x97): pulsing 1/16
  - Ch 11 (0x9B): blinking 1/24
- Velocity (byte 3) selects from a fixed 128-color palette.
  Palette is hardcoded and cannot be changed.

**Method 2: Direct RGB via SysEx (full color)**
```
F0 47 7F 4F 24 [lenMSB] [lenLSB] [startPad] [endPad]
  [rMSB] [rLSB] [gMSB] [gLSB] [bMSB] [bLSB]
  ... (repeat RGB for each pad in range) ...
F7
```
- Product model ID: `0x4F` (APC Mini MK2).
- Message type: `0x24`.
- Start/end pad: range of pads to set (0x00-0x3F).
- RGB: 14-bit per channel (MSB + LSB, each 0-127). Full 8-bit
  color: `value = (MSB << 7) | LSB`.
- Can batch multiple pads in one message.
- Each pad in the range gets 6 bytes (rMSB, rLSB, gMSB, gLSB,
  bMSB, bLSB).

The SysEx method is what Chromavox should use — it gives full-
spectrum color control matching the Push integration.

### Pad note layout

```
0x38 0x39 0x3A 0x3B 0x3C 0x3D 0x3E 0x3F   ← top row
0x30 0x31 0x32 0x33 0x34 0x35 0x36 0x37
0x28 0x29 0x2A 0x2B 0x2C 0x2D 0x2E 0x2F
0x20 0x21 0x22 0x23 0x24 0x25 0x26 0x27
0x18 0x19 0x1A 0x1B 0x1C 0x1D 0x1E 0x1F
0x10 0x11 0x12 0x13 0x14 0x15 0x16 0x17
0x08 0x09 0x0A 0x0B 0x0C 0x0D 0x0E 0x0F
0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07   ← bottom row
```

Formula: `note = row * 8 + col` (row 0 = bottom, col 0 = left).
Same layout concept as Push (row-major, bottom-up) but different
note offset (Push starts at 36, APC at 0).

### Implementation plan

**Phase 1: Pad input + LED output**
1. `attach(midiAccess, inputPort)` — find matching output port.
   APC Mini MK2 has one MIDI port (not split like MPC).
2. `setPixel(padIndex, r, g, b)` — store in `pixels` (192 bytes).
3. `flush()` — diff against `_hwState`. Send SysEx RGB messages
   for changed pads. Batch contiguous changed pads into single
   SysEx messages for efficiency.
4. Fall back to fixed-palette velocity method if SysEx is
   unavailable (find closest palette entry by RGB distance).
5. Clear all pads on attach.

**Phase 2: In-key layout + sensor visualization**
1. Same in-key scale layout as Push — 8x8 grid, `degree = row *
   rowOffset + col`, same `fourthOffset` table.
2. Sensor spectrogram on right column (same as Push).
3. `updateFromSensors(...)` — same two-pass rendering as Push
   (in-key base colors + sensor override on column 7).

**Phase 3: Fader → element control**
1. APC Mini MK2 has 9 faders (CC 48-56), absolute 0-127.
   Map 8 faders to element properties (same as Push encoders):
   - CC 48: X position
   - CC 49: Y position
   - CC 50: Rotation
   - CC 51: Spin
   - CC 52: Hue
   - CC 53: Delay
   - CC 54: Size/Width
   - CC 55: Height/Radius
   - CC 56: (fader 9) Volume
2. Faders are absolute, not relative — need to track the current
   element property value and compute delta from fader movement.
   Use pickup mode: fader has no effect until it crosses the
   current value, then tracks 1:1.
3. Track buttons (notes 0x64-0x6B): element selection (cycle
   through elements, or direct 1-of-8 selection).
4. Scene launch buttons (notes 0x70-0x77): preset load or
   element type quick-add.

**Phase 4: Init animation**
1. 8x8 grid supports the same polygon animation as Push.
   Reuse `playAnimation()` from Push (extract to shared utility
   or duplicate with different note mapping).

### APC64-specific considerations
- Touch strips send CC values — map similar to faders but with
  continuous tracking (no pickup needed).
- Has standalone MIDI routing — could be used without a computer
  if paired with hardware synths.
- Protocol likely shares the APC Mini MK2 SysEx format (same
  product line, same manufacturer). Product model ID may differ.

---

## Shared utilities to extract from push.js

Several functions in `push.js` are hardware-agnostic and should
be extracted to a shared module (`docs/controller-common.js`):

1. **`fourthOffset(scaleName)`** — in-key row offset calculation.
2. **Bresenham line drawing** on a pixel grid — init animation.
3. **`wavelengthToRGB` downsampling** — sensor bin to pad color.
4. **Element property dispatch** — CC → `beginEdit` / property
   mutation / `endEdit` pattern.
5. **Scale degree → pad color** — base color logic (idle, root,
   pressed, disabled).

The hardware-specific parts (SysEx format, note-to-pad mapping,
palette vs direct RGB, port discovery) stay in each module.

---

## Priority and dependencies

```
Phase 1 (pad I/O) for both modules — independent, can be parallel.
  |
  +→ Phase 2 (visualization) — needs Phase 1.
  |
  +→ Phase 3 (encoders/faders) — needs Phase 1.
  |
  +→ Phase 4 (animation) — needs Phase 1.

Shared utility extraction can happen before or after.
```

The APC module is higher priority — 8x8 grid matches Push's
capability closely and the protocol is fully documented. The MPC
module is lower priority — 4x4 grid limits the experience.

---

## Risk notes

- **Web MIDI SysEx permission**: browsers require user gesture +
  `sysex: true` in `navigator.requestMIDIAccess()`. The existing
  Push code already requests this. Verify it works with Akai
  devices (some browsers whitelist by manufacturer ID).

- **APC Mini MK2 SysEx RGB batching**: sending 64 pad updates as
  individual SysEx messages may be slow. The protocol supports
  start/end pad ranges — batch contiguous updates into single
  messages. Worst case: 64 individual messages × ~15 bytes each
  = ~1 KB/frame at 60 fps = ~60 KB/s, well within USB MIDI
  bandwidth.

- **MPC controller mode latency**: the MPC must be manually put
  into controller mode. USB MIDI latency in controller mode is
  unknown — may be higher than dedicated controllers.

- **APC64 protocol**: not publicly documented. Assume APC Mini MK2
  compatibility and test. If incompatible, will need reverse
  engineering or a separate code path.

- **Fader pickup mode**: absolute faders jump to the fader's
  physical position on first touch, which would snap element
  properties. Pickup mode (ignore until fader crosses current
  value) adds complexity but is essential for usable control.
