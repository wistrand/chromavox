# Ableton Push 3 — MIDI port quirk on Linux

## The issue

The Push 3 exposes three MIDI ports:

| rawmidi | ALSA seq | Name |
|---|---|---|
| hw:1,0,0 | 20:0 | Live Port |
| hw:1,0,1 | 20:1 | User Port |
| hw:1,0,2 | 20:2 | External Port |

The **rawmidi** interface (`amidi -p hw:1,0,1 -d`) receives note-on/off
from the User Port correctly. The **ALSA sequencer** (`aseqdump -p 20:1`)
only receives Active Sensing (0xFE) — no notes.

The browser's Web MIDI API uses the ALSA sequencer, not rawmidi. So the
User Port appears in the device dropdown but delivers no note data.

The Live Port (20:0) works correctly through both layers.

## Observed on

- Manjaro Linux, kernel 7.0.0-rc4-1-MANJARO
- Push 3 connected via USB
- Chromium / Chrome

## Likely cause

The ALSA USB MIDI kernel driver routes the User Port's USB endpoint
data to rawmidi subdevice 1 correctly, but the sequencer bridge for
that subdevice doesn't forward note events — only system-realtime
(Active Sensing). Possibly related to Push 3's multi-endpoint USB
descriptor or USB MIDI 2.0 (UMP) support in the driver.

## Workarounds

- **Use the Live Port** — the Push sends pad/key data there by
  default and it works through the sequencer.
- **Bridge rawmidi → sequencer** in the background:
  `amidi -p hw:1,0,1 -d | aplaymidi -` or use `a2jmidid` /
  `pw-jack` to create a virtual ALSA sequencer port from rawmidi.
- **Kernel update** — ALSA USB MIDI 2.0 support is actively
  developed (see `sound/usb/midi2.c`). A newer kernel may fix the
  sequencer routing for multi-port devices.

## Not a Chromavox bug

The app enumerates and subscribes to the ALSA sequencer port
correctly. The data just isn't there at the sequencer level.
