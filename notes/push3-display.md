# Push 3 Display — Research Notes

## Hardware

The Push 3 (USB ID `2982:1969`) exposes a Vendor Specific bulk
interface (Interface 0) with EP 1 OUT/IN at 512-byte packets.
This matches the Push 2's documented display interface exactly.

## Display specs (inferred from USB descriptor + Push 2 docs)

- 960 x 160 pixels
- 16-bit RGB (5-6-5 little-endian): red bits 0-4, green 5-10, blue 11-15
- Bulk OUT on endpoint `0x01`, 512-byte packets
- 640 packets per frame (1920 bytes pixel data + 128 filler per line)
- Each line XOR'd with `0xFFE7F3E7` before transmission
- 16-byte frame header: `FF CC AA 88 00 00 00 00 00 00 00 00 00 00 00 00`
- 60fps capable with double-buffering

## Protocol (from Push 2 official docs)

1. Send the 16-byte frame header via bulk OUT
2. Send 160 lines, each as 4 x 512-byte packets:
   - 1920 bytes of pixel data (960 pixels x 2 bytes)
   - 128 bytes filler
   - Each 512-byte buffer XOR'd with repeating `0xFFE7F3E7`
3. Total per frame: 1 header + 640 data packets = 327,680 bytes

## Why it can't work from a browser

The Push 3 is a composite USB device with 6 interfaces:

| Interface | Class | Purpose |
|---|---|---|
| 0 | Vendor Specific | Display (bulk EP 1 OUT/IN) |
| 1 | Audio Control | Audio control device |
| 2 | Audio Streaming | Audio output |
| 3 | Audio Streaming | Audio input |
| 4 | Audio Control | MIDI control |
| 5 | Audio/MIDI | MIDI streaming |

**WebUSB limitations:**
- MIDI and Audio interfaces are kernel-claimed (ALSA). WebUSB can't
  claim interface 0 without detaching the kernel from the whole
  device, which kills MIDI and audio.
- The Push doesn't advertise a WebUSB descriptor.
- Chrome won't show composite devices with kernel-claimed interfaces
  on Linux.

## Sidecar process (implemented)

`tools/push-display.js` bridges browser → display:

1. Shows a hello frame on startup (spectral gradient + logo + CHROMAVOX text)
2. Listens on `ws://localhost:9100` for PNG region updates from the browser
3. Composites regions onto the base frame using a regionMap
4. Refreshes the USB display at 30fps

Dependencies: `usb`, `pngjs`, `ws` (in `tools/package.json`).
Only claims interface 0, leaving MIDI/audio interfaces for the OS.

Start via `node serve.js --push-display` or standalone
`cd tools && node push-display.js`.

Browser side (`push.js`): `_connectDisplay()` connects with retry
every 2s. Sends two PNG regions per update at ~10fps: bench canvas
(left, progressive-halving downsample from GL readPixels) and sensor
spectrograms (right, rendered from sensorBins). Protocol: 4-byte
header (x, y as uint16 LE) + PNG bytes.

Reference implementation for Push 2:
[ableton-push-canvas-display](https://github.com/halfbyte/ableton-push-canvas-display)
(Node.js, archived May 2025, Push 2 only, protocol identical for Push 3).

## Push 3 vs Push 2 differences

- USB vendor/product ID: Push 2 = `2982:1967`, Push 3 = `2982:1969`
- Push 3 has additional audio interfaces (it's a full audio interface)
- Display protocol: believed identical but Ableton has not published
  a Push 3-specific interface document
- The Push 2 official spec is at:
  https://github.com/Ableton/push-interface/blob/main/doc/AbletonPush2MIDIDisplayInterface.asc

## What is displayed

Currently:
- Bench canvas (left region, aspect-preserved progressive-halving downsample)
- Sensor spectrogram (right region, rendered from sensorBins)
- Hello frame on startup (spectral gradient + logo + CHROMAVOX text)

Future:
- Element names and property values under each encoder
- Scale/mode/base info
- Delay particle count
