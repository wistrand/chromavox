# Chromavox

An **optical synthesizer** that runs in the browser. Audio comes in on the
left wall as a row of light emitters; an additive synth on the right wall
plays back whatever reaches the sensors. Place prisms, lenses, mirrors,
colored glass, and dichroic mirrors between them to reshape how pitch is
mapped, how timbre evolves, and where each note's energy lands.

Underneath is a real 2D optical simulation: Snell refraction with Sellmeier
(or Cauchy) dispersion, Beer-Lambert absorption for colored glass, and
dichroic mirrors with wavelength-dependent reflectance.

Plain HTML + ES modules + WebGL2. No dependencies.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP, not `file://`. Open http://localhost:8005/ for
the landing page and http://localhost:8005/play (or `/play.html`) for the
app itself. `serve.js` emulates GitHub Pages' clean-URL fallback so
extensionless paths resolve to the matching `.html`.

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
- **Sim rate** slider (in Audio in dropdown): log-scaled multiplier on
  particle advance speed inside delay materials (0.05x..4x, default 1x).
- **Audio out** (or press `Q`) enables an additive synth where each sensor
  is a voice whose pitch matches the input ladder and whose timbre comes
  from the wavelengths reaching that sensor.

## Layout

- `docs/index.html` — static landing page (centered logo, no links).
- `docs/play.html`, `docs/style.css` — app shell and panels.
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
- `docs/presets/` — preset scenes + `index.json` list. Includes
  `slow-glass.json` (6 sources, 256 rays, slow-glass block + 2 mirrors).
- `serve.js` — zero-dep static server rooted at `docs/`.

## Materials

Dielectrics (with Beer-Lambert absorption band):
- `crown` (N-BK7, clear), `flint` (N-SF11, rose-tinted), `fused` (clear),
  `water` (cyan-tinted), `diamond` (real n≈2.4; TIRs in 60° prisms),
  `hyper` (synthetic ~4× flint dispersion, magenta-tinted),
  `slowGlass` (crown-glass-shaped, `delayK = 0.002` — stateful delay
  material; light is captured as particles inside the glass and
  propagated in real time).

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
