# Chromavox

2D optics raycaster in the browser. Emitters on the left, sensors on the
right, placeable prisms, blocks, lenses, mirrors, and a rabbit in between.
Real Snell refraction with Sellmeier (or Cauchy) dispersion, Beer-Lambert
absorption for colored glass, and dichroic mirrors with wavelength-dependent
reflectance. Optional audio input modulates per-source intensity by audio
frequency bucket; optional additive synth plays the sensor readouts back.

Plain HTML + ES modules + WebGL2. No dependencies.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP, not `file://`. Open http://localhost:8005/.

## Use

- Pick a tool (Prism, Block, Convex Lens, Concave Lens, Mirror, Rabbit,
  Select, Delete) and click the canvas to place.
- Select mode: click an element to select, drag to move, **Shift-drag** or
  right-button drag to rotate. Arrow keys nudge; **Shift+Left/Right** rotate
  1° per press; **Backspace** deletes. **Ctrl+Z / Ctrl+Shift+Z** undo/redo.
- Click an emitter tick on the left wall to toggle that source; Shift-click
  to solo.
- Adjust source count, wavelength range, rays-per-source, spread, and
  aperture in the left panel. Tick "Sync to source count" to lock sensors
  to sources.
- Load a preset from the Preset dropdown, or save/load scenes as JSON.
- **Audio in** drives per-source intensity from a chosen sound source:
  microphone, pure sine, harmonic stack, white/pink noise, or a computer
  keyboard claviature (ZXCVBNM/SDGHJ, `,`/`.` shift octaves). Mode selects
  log-spaced vs chromatic bucketing; Span widens chromatic buckets for
  broader range. Bucket color paints each source with its ladder colour.
- **Audio out** (or press `Q`) enables an additive synth where each sensor
  is a voice whose pitch matches the input ladder and whose timbre comes
  from the wavelengths reaching that sensor.

## Layout

- `docs/index.html`, `docs/style.css` — shell and panels.
- `docs/spectrum.js` — wavelength→RGB, Sellmeier/Cauchy dispersion,
  Beer-Lambert absorption, dichroic reflectance, material table.
- `docs/scene.js` — data model, polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer, per-frame vertex buffer, sensor bins.
- `docs/renderer.js` — WebGL2 passes: additive rays, alpha overlay.
- `docs/ui.js` — pointer input, property panel, save/load, presets,
  undo/redo, keyboard shortcuts.
- `docs/mic.js` — audio input (mic or synthetic) + FFT bucket extraction.
- `docs/synth.js` — additive sensor synth.
- `docs/main.js` — wiring, render loop, device pickers.
- `docs/presets/` — preset scenes + `index.json` list.
- `serve.js` — zero-dep static server rooted at `docs/`.

## Materials

Dielectrics (with Beer-Lambert absorption band):
- `crown` (N-BK7, clear), `flint` (N-SF11, rose-tinted), `fused` (clear),
  `water` (cyan-tinted), `diamond` (real n≈2.4; TIRs in 60° prisms),
  `hyper` (synthetic ~4× flint dispersion, magenta-tinted).

Mirrors (wavelength-dependent reflectance):
- `mirror` (neutral silver), `mirror-red`, `mirror-green`, `mirror-blue`
  (dichroic — reflects narrow band, absorbs the rest).

For an equilateral prism to transmit any light, `n < 2` is required; diamond
demonstrates the TIR limit.

## Browser notes

- WebGL2 required (all current desktop and mobile browsers).
- Audio output device picker uses `AudioContext.setSinkId()` (Chromium ≥110
  / recent Firefox); older browsers fall back to system default.
- Microphone input disables AGC/AEC/NS so the analyser sees the raw envelope.
