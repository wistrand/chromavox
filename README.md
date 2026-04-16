# Chromavox

2D optics raycaster in the browser. Emitters on the left, sensors on the
right, placeable prisms, blocks, lenses, mirrors, and a rabbit in between.
Real Snell refraction with Sellmeier (or Cauchy) dispersion, Beer-Lambert
absorption for colored glass, and dichroic mirrors with wavelength-dependent
reflectance. Optional microphone input modulates per-source intensity by
audio frequency bucket.

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
  right-button drag to rotate.
- Adjust source count, wavelength range, rays-per-source, spread, and
  aperture in the left panel.
- Load a preset from the Preset dropdown, or save/load scenes as JSON.
- Click "Mic modulate" to drive per-source intensity from the microphone.
  Each source corresponds to one log-spaced FFT bucket (80–6000 Hz).

## Layout

- `docs/index.html`, `docs/style.css` — shell and panels.
- `docs/spectrum.js` — wavelength→RGB, Cauchy `n(λ)=A+B/λ²`, material presets.
- `docs/scene.js` — data model, polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer, per-frame vertex buffer, sensor bins.
- `docs/renderer.js` — WebGL2 passes: additive rays, alpha overlay.
- `docs/ui.js` — pointer input, property panel, save/load, presets.
- `docs/mic.js` — microphone capture, FFT bucketing.
- `docs/main.js` — wiring and dirty-flag render loop.
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
