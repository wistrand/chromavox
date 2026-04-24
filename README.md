# Chromavox

An **optical synthesizer** that runs in the browser. Audio comes in on the
left wall as a row of light emitters; an additive synth on the right wall
plays back whatever reaches the sensors. Place prisms, lenses, mirrors,
colored glass, dichroic mirrors, and a brilliant-cut diamond between them
to reshape how pitch is mapped, how timbre evolves, and where each note's
energy lands.

Underneath is a real 2D optical simulation: Snell refraction with Sellmeier
(or Cauchy) dispersion, Beer-Lambert absorption for colored glass, and
dichroic mirrors with wavelength-dependent reflectance.

Plain HTML + ES modules + WebGL2. No dependencies.

## Run

```
npm start                    # node serve.js, port 8005
node serve.js 9000           # override port
node serve.js --push-display # also spawn the Push display sidecar
```

ES modules require HTTP, not `file://`. Open http://localhost:8005/ for
the landing page and http://localhost:8005/play (or `/play.html`) for the
app itself. `serve.js` emulates GitHub Pages' clean-URL fallback so
extensionless paths resolve to the matching `.html`.

## Use

- Pick an element from the Add split-button (Prism, Block, Convex Lens,
  Concave Lens, Mirror, Concave Mirror, Convex Mirror, Circle, Rabbit,
  Diamond). The main button places the last-used kind; `▾` opens the
  full menu.
- Tap or click an element to select it. Drag to move; **Shift-drag** or
  right-button drag to rotate. Two-finger pinch on touch devices scales
  and rotates simultaneously. Arrow keys nudge; **Shift+Left/Right**
  rotate 1° per press; **Backspace / Delete** removes the selection.
  **Ctrl+Z / Ctrl+Shift+Z** undo/redo. Press `H` or `?` for the full
  shortcut list.
- Click an emitter tick on the left wall to toggle that source;
  long-press or Shift-click to solo.
- Tweak source/sensor counts, scale mode, base note, span, smoothing,
  rays-per-source, sim rate from the toolbar dropdowns. Tick **Sync to
  source count** to lock sensor count to source count.
- **Audio in** drives per-source intensity from a chosen sound source:
  microphone, sine, harmonics, white/pink noise, MIDI in (live MIDI
  device), an audio file, or a computer keyboard claviature
  (ZXCVBNM/SDGHJ, `,`/`.` shift octaves). Touch on the left edge of the
  bench plays directly. Mode picks log-spaced, voice-band, or any of
  several musical scales (chromatic, major, minor, pentatonic, whole-
  tone, blues).
- **Audio out** (or press `Q`) enables an additive synth where each
  sensor is a voice whose pitch matches the input ladder and whose
  timbre comes from the wavelengths reaching that sensor. Carriers:
  sine, FM, supersaw, pulse, vocoder, Karplus, acid (303-style),
  noise (resonant bandpass), piano (modal). Master Reverb (Freeverb)
  sits after voice summation.
- **Bench** dropdown: aspect (portrait / landscape / square), distort
  toggle, scale labels + wall markers, **smoke** backdrop with
  intensity + hue sliders and a **bloom** halo slider, no-overlap,
  debug windows (mic spectrum, synth spectrum, synth waveform, stats).
  Smoke parts around objects, swirls under your finger, and swirls
  with spinning elements; bloom gives rays a soft halo wherever the
  smoke is dense.
- **Auto ✨** (in the Add menu): analyzes the current song and scene
  and places a fitting element positioned to interact optically with
  what's already on the bench — prism for bass, lens for wide
  spreads, concave mirror for cavities, etc. — while avoiding the
  song's melody range so the line stays intact.
- **Songs**: pick from the catalog dropdown, or import via `⇪` /
  drag-drop. Native song JSON, MusicXML (`.musicxml` / `.xml`), and
  Standard MIDI Files (`.mid` / `.midi`) are accepted. MIDI imports open
  a track-picker so you choose which tracks contribute notes; the `♪`
  button reopens the picker after closing it. The transport bar has
  play/stop, repeat (`⟳`), seek, and a time readout.
- **Fullscreen** (`F` key or `⛶` button): hides toolbar and panels;
  bench + sensor spectrograms remain.
- **Hardware controllers**: Ableton Push 2 / Push 3 and Akai MPC / APC
  are auto-detected when MIDI in is selected.

## Layout

- `docs/index.html` — static landing page.
- `docs/play.html`, `docs/style.css` — app shell, panels, transport.
- `docs/js/spectrum.js` — wavelength↔RGB, Sellmeier/Cauchy dispersion,
  Beer-Lambert absorption, dichroic reflectance, material table.
- `docs/js/elements.js` — per-kind property schema (single source of
  truth for UI sliders and `makeElement` defaults).
- `docs/js/scene.js` — data model, polygon geometry (`localPolygon`),
  edge generation (`worldEdges`), JSON save/load.
- `docs/js/raytracer.js` — CPU tracer; per-frame vertex buffer; sensor
  bins; particle pools for delay materials.
- `docs/js/gpu-tracer.js` — WebGL2 transform-feedback ping-pong tracer;
  default when no delay elements are present (33–870× faster than CPU).
- `docs/js/renderer.js` — three-pass WebGL2 pipeline: instanced SDF
  rays into an HDR FBO, tonemapped blit, per-element distortion pass,
  overlay lines.
- `docs/js/ui.js` — pointer input, property panel, undo/redo, shortcuts.
- `docs/js/mic.js` — audio input modes + scale-aware bucketing.
- `docs/js/synth.js` + `docs/js/synth-worklet.js` — additive synth in
  a single `AudioWorkletProcessor`; nine carrier modes + Freeverb.
- `docs/js/carriers.js` — carrier parameter schema.
- `docs/js/song.js` — song player (keyframes + notes + automation).
- `docs/js/musicxml.js` — MusicXML → song JSON converter.
- `docs/js/midi.js` — Standard MIDI File parser + song converter.
- `docs/js/midi-devices/` — Push, Akai MPC, Akai APC adapters.
- `docs/js/main.js` — wiring, render loop, transport, device pickers.
- `docs/songs/` — bundled songs + `index.json` catalog.
- `docs/presets/` — preset scenes + `index.json`.
- `serve.js` — zero-dep static server rooted at `docs/`.
- `agent_docs/` — per-subsystem architecture notes.

## Materials

Dielectrics (with Beer-Lambert absorption band):
- `crown` (N-BK7, clear), `flint` (N-SF11, rose-tinted), `fused`
  (clear), `water` (cyan-tinted), `diamond` (real n≈2.4), `hyper`
  (synthetic ~4× flint dispersion, magenta-tinted), `slowGlass`
  (crown-shaped, `delayK = 0.002` — stateful delay material; light is
  captured as particles inside the glass and propagated in real time).

Mirrors (wavelength-dependent reflectance):
- `mirror` (neutral silver), `mirror-red`, `mirror-green`, `mirror-blue`
  (dichroic — reflects a narrow band, absorbs the rest).

For an equilateral prism to transmit any light, `n < 2` is required;
the `diamond` material demonstrates the TIR limit. The brilliant-cut
`diamond` element exploits this — at any meaningful angle it traps
all incoming rays inside.

## Browser notes

- WebGL2 required (all current desktop and mobile browsers). The GPU
  tracer additionally needs `EXT_color_buffer_float` and
  `EXT_float_blend`; if either is missing it falls back to the CPU
  tracer transparently.
- Audio output device picker uses `AudioContext.setSinkId()`
  (Chromium ≥110 / recent Firefox); older browsers fall back to the
  system default.
- Microphone input disables AGC/AEC/NS so the analyser sees the raw
  envelope.
- `navigator.mediaDevices` requires a secure context — mic input fails
  with a clear error on plain HTTP.
- Scenes auto-save to `localStorage` on every edit and restore on
  reload.
