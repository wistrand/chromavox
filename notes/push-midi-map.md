# Ableton Push 2/3 — MIDI Pad & LED Reference

Based on the official [Push 2 MIDI and Display Interface](https://github.com/Ableton/push-interface/blob/main/doc/AbletonPush2MIDIDisplayInterface.asc).
Push 3 uses the same protocol on the Live Port (see `notes/push3-midi.md`
for the User Port sequencer issue on Linux).

## Ports

| Port | Push 2 | Push 3 | Purpose |
|---|---|---|---|
| 1 (Live) | USB MIDI port 1 | hw:X,0,0 | Default — Ableton Live control |
| 2 (User) | USB MIDI port 2 | hw:X,0,1 | External apps (broken on Linux seq for Push 3) |

In User mode, pads and buttons send on Port 2 and accept LED
feedback on Port 2. On Push 3 Linux, use Port 1 (Live Port)
instead — it works through the ALSA sequencer.

## Pad grid — note numbers

8x8 grid, notes 36-99. Bottom-left is 36, top-right is 99.

```
Top row:     92  93  94  95  96  97  98  99
             84  85  86  87  88  89  90  91
             76  77  78  79  80  81  82  83
             68  69  70  71  72  73  74  75
             60  61  62  63  64  65  66  67
             52  53  54  55  56  57  58  59
             44  45  46  47  48  49  50  51
Bottom row:  36  37  38  39  40  41  42  43
```

Formula: `noteNumber = row * 8 + 36 + col` where row 0 = bottom,
col 0 = left.

Pad press sends Note On (0x90) with velocity 1-127.
Pad release sends Note Off (0x80) or Note On with velocity 0.

## Setting pad LED color

### Method 1: indexed palette (simple)

Send a Note On back to the device on the same note number.
Velocity = palette color index (0-127).

```
90 [note] [colorIndex]
```

Default palette highlights:
- 0 = off (black)
- 122 = white
- 125 = blue
- 126 = green
- 127 = red

### Method 2: custom RGB via SysEx palette entry

Modify a palette entry (0-127) to any RGBW value, then address
pads with that index via Note On.

```
F0 00 21 1D 01 01 03 [index] [r_lsb] [r_msb] [g_lsb] [g_msb] [b_lsb] [b_msb] [w_lsb] [w_msb] F7
```

SysEx header: `F0 00 21 1D 01 01` (Ableton, device 01, model 01 = Push 2).
Command `03` = Set LED Color Palette Entry.

Each color component (0-255) is split into two 7-bit values:
- `lsb = value & 0x7F` (lower 7 bits)
- `msb = (value >> 7) & 0x01` (bit 7)

Example — set palette index 1 to orange (255, 128, 0):
```
F0 00 21 1D 01 01 03  01  7F 01  00 01  00 00  00 00  F7
                       idx r     g      b      w
```

Then light pad 36 with that color:
```
90 24 01
```

### Method 3: direct RGB SysEx per pad (Push 2 only, undocumented)

Reported by community — may not work on Push 3:
```
F0 47 7F 15 04 00 08 [pad] 00 [rHi] [rLo] [gHi] [gLo] [bHi] [bLo] F7
```

Where `pad` = `row * 8 + col` (0-63, bottom-left = 0), and
rHi/rLo are the high/low 4-bit nibbles of the 8-bit red value.

## LED animation via MIDI channel

The channel nibble in the Note On status byte controls animation:

| Channel | Effect |
|---|---|
| 0 (0x90) | Static — set color immediately |
| 1-5 (0x91-0x95) | One-shot fade — 1/24 to 1/2 note duration |
| 6-10 (0x96-0x9A) | Pulsing — 1/24 to 1/2 note |
| 11-15 (0x9B-0x9F) | Blinking — 1/24 to 1/2 note |

Animation timing requires MIDI clock (0xF8), start (0xFA), and
stop (0xFC) messages.

## Button CC numbers

Buttons send CC messages (0xB0). LED feedback uses the same CC
number with velocity = palette color index.

| CC | Button |
|---|---|
| 20-27 | Display buttons (top row, left to right) |
| 28 | Master |
| 32 | Add (+) — Chromavox maps to "add element" |
| 36-43 | Scene buttons (right side, 43=top, 36=bottom) |
| 44-47 | Left, Right, Up, Down |
| 48 | Select |
| 49 | Shift |
| 50 | Note |
| 51 | Session |
| 52 | Add Device |
| 53 | Add Track |
| 54 | Octave Down |
| 55 | Octave Up |
| 56 | Repeat |
| 57 | Accent |
| 58 | Scale |
| 59 | User |
| 60 | Mute |
| 61 | Solo |
| 62 | Page Left |
| 63 | Page Right |
| 85 | Play |
| 86 | Record |
| 87 | New |
| 88 | Duplicate |
| 89 | Automate |
| 90 | Fixed Length |

## Encoders

Track encoders send relative CC messages (increment/decrement around
64). The large wheel and volume encoder differ (see note below).

| CC | Encoder |
|---|---|
| 70 | Large selection wheel (Push 3; not in Push 2 spec) |
| 71-78 | Track encoders 1-8 (left to right) |
| 79 | Volume / Master encoder |
| 14 | Tempo |
| 15 | Swing |

**Push 3 note**: CC 70 and CC 79 send `val=127` for clockwise and
`val=1` for counter-clockwise (NOT relative-around-64 like track
encoders CC 71-78).

## Touch strip

31 LEDs controlled via SysEx command `0x19`:
```
F0 00 21 1D 01 01 19 [b0] ... [b15] F7
```

16 bytes, 2 LEDs per byte (4 bits each, color indices 0-7).
Touch strip sends pitchbend (0xE0) for position.

## Chromavox integration ideas

- **Pad → emitter**: each pad press maps to an emitter via its note
  number's frequency. 64 pads = up to 64 simultaneous emitters.
- **LED feedback from sensors**: color each pad's LED based on the
  wavelength mix reaching the corresponding sensor. Map the sensor's
  dominant wavelength to a Push palette index.
- **Encoder → element control**: CC 71-78 could map to selected
  element's rotation, size, delayK, spin, x, y, hue, opacity.
- **Scene buttons → preset load**: CC 36-43 could trigger presets.
- **Touch strip → global parameter**: map to sim rate or ray width.
- **Animation**: pulse pad LEDs in sync with the synth output using
  MIDI clock + channel-based animation modes.

Sources:
- [Push 2 MIDI and Display Interface (official)](https://github.com/Ableton/push-interface/blob/main/doc/AbletonPush2MIDIDisplayInterface.asc)
- [Push User Mode documentation](https://help.ableton.com/hc/en-us/articles/209071249-Push-User-Mode-for-custom-MIDI-mappings)
- [Direct RGB SysEx discussion](https://github.com/Ableton/push-interface/issues/12)
- [LED color palette discussion](https://github.com/Ableton/push-interface/issues/2)
