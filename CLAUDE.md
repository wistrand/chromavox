# Chromavox

2D optics raycaster: emitters on the left, sensors on the right, placeable
dielectric/mirror/silhouette elements in between. Real Snell refraction with
Sellmeier (or Cauchy) wavelength-dependent index, Beer-Lambert absorption,
and dichroic mirrors. Optional audio input modulates per-source intensity;
optional additive synth plays sensor readouts back as sound. Plain HTML +
ES modules + WebGL2. No dependencies.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP (not `file://`). The static server's ROOT is `docs/`,
which is also the folder GitHub Pages serves.

## Layout

- `docs/index.html`, `docs/style.css` — 3-column shell; drawer panels on ≤860px.
- `docs/spectrum.js` — Dan-Bruton wavelength→RGB, Sellmeier/Cauchy dispersion,
  Beer-Lambert absorption, dichroic reflectance, material table.
- `docs/scene.js` — data model, local/world polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer, per-frame vertex buffer + sensor bins.
- `docs/renderer.js` — WebGL2. Two passes: additive line blend (light field), alpha overlay.
- `docs/ui.js` — pointer events (mouse + touch unified), property panel,
  save/load, preset dropdown, undo/redo, keyboard shortcuts.
- `docs/mic.js` — audio input (mic or synthetic source) + FFT bucket extraction.
- `docs/synth.js` — additive sensor synth (harmonic partials driven by bins).
- `docs/main.js` — wiring + dirty-flag render loop + device pickers.
- `docs/presets/*.json` — scene presets; `presets/index.json` lists them.
- `serve.js` — zero-dep static server; ROOT resolves to `./docs/`.

## Coordinate system

Scene coordinates are "bench pixels" in a logical space with `bench.w`, `bench.h`.
The renderer re-derives bench size from canvas aspect on resize (fixed short axis = 900).
All UI input is converted via `UI.canvasToBench`.

Y is **down** (screen convention). Polygon winding and outward-normal sign in
`worldEdges` depend on this — see the shoelace / `cw` logic. If you change the
coordinate convention, re-derive the normal sign carefully; getting it wrong
flips refraction direction and everything breaks subtly.

## Render loop

`main.js` uses a dirty flag. `markDirty()` is passed to `UI` as `onChange` and
called on every interaction. Don't run the tracer on every RAF unconditionally —
it's pure JS and expensive at high ray counts. When audio in is active the loop
marks dirty each frame so buckets animate; when audio out is active the synth
update also runs every frame.

## Ray tracer notes

- Max bounces: 12 (in `raytracer.js`).
- Per-ray intensity: `1.6 / sqrt(raysPerSource)` — sub-linear so piling on rays
  brightens the field instead of dimming to nothing.
- Source modelling: each source is an extended aperture across a fraction of
  its y-strip (`emitter.apertureFactor`, slider 0–1, default 0.01). Ray origins,
  wavelengths, and angles use decorrelated golden-ratio sequences so the beam
  looks continuous rather than an ordered fan.
- Wavelength assignment: every source emits the same `raysPer`-wide mix from
  `wlMin..wlMax`. Same mix per source by design. With `emitter.wlPerSource` set
  (audio in + "Bucket color" option) sources get their own narrow wavelength
  band instead.
- Disabled sources: `emitter.disabled` is a `Set<number>` of source indices to
  skip entirely. Toggled by clicking the left-wall tick; shift-click solos.
- Per-source mic gain: if `emitter.micLevels` is present, each source's ray
  intensity is scaled by `micLevels[s]` (that source's audio bucket amplitude).
- No Fresnel amplitude split. 100% transmission unless TIR. Simpler and fine for
  pedagogy; adding reflected rays at each dielectric surface would branch the
  ray tree and change the buffer sizing.
- Beer-Lambert absorption: while a ray is inside a dielectric, each segment is
  attenuated by `exp(-α(λ) · d)` where α comes from the material's absorption
  band. Segment endpoints carry different intensities; the GL line interpolates
  so a long internal path fades along its length.
- Dichroic mirrors: mirror materials expose a wavelength-dependent reflectance
  `R(λ)` instead of a flat 0.98. The non-reflected fraction is absorbed, not
  transmitted — keeps the ray tree unbranched.
- Ray absorbed at bench walls; sensor wall is the right edge, deposits into a
  `sensorCount × 64` histogram by (y-strip, wavelength-bin).
- Starting medium: `pointInPolygon` test at emitter origin decides if the ray
  starts inside a dielectric. Matters if user drops a lens over the emitter line.

## Materials

Each entry in `MATERIALS` has `type: 'dielectric' | 'mirror'`, dispersion data
(Sellmeier 3-term for real glasses; Cauchy `A,B` for synthetic ones), and one
of `absorb` (dielectrics) or `reflect` (mirrors). Both are Gaussian-band
parametric: `{ base, peak, center, sigma }`.

- Dielectrics: `crown` (N-BK7), `flint` (N-SF11, rose tint), `fused`, `water`
  (cyan tint), `diamond` (real, n>2), `hyper` (synthetic, magenta tint).
- Mirrors: `mirror` (neutral silver, R≈0.98), `mirror-red`, `mirror-green`,
  `mirror-blue` (narrow band reflectance, rest absorbed).

`materialN(mat, λ)` dispatches Sellmeier vs Cauchy. `materialAbsorption(mat, λ)`
returns α in 1/bench-unit (path lengths are hundreds of units — peak ~0.004
gives a noticeable gradient over ~200 units). `mirrorReflectance(mat, λ)`
returns R in [0,1]. UI material select auto-filters by type per element kind.

## Dispersion gotchas (important)

- Sellmeier `n²(λ) = 1 + Σ B_i λ²/(λ²−C_i)` with λ in µm (Cauchy for synthetic).
- **Equilateral-prism TIR constraint**: for any ray to pass through a 60° prism,
  `n < 2` is required — otherwise the internal ray hits the exit face beyond the
  critical angle and total-internally-reflects. `diamond` (n≈2.4) always TIRs;
  `hyper` is tuned below 2.
- **Prism orientation matters**: with `rot=0` (apex up) and horizontal rays,
  incidence is only 30° — near the TIR cutoff for flint. Default `makeElement`
  gives prisms `rot=π/6` so new placements disperse visibly.
- **Block zig-zag**: rectangular dielectrics always TIR on faces *adjacent* to
  the entry face (geometry: adjacent-face incidence ≥ 90°−θc > θc). Rays can
  only exit through the parallel opposite face, zigzagging off perpendicular
  walls. Long zigzags hit `MAX_BOUNCES` and leave a stub inside the glass.

## Elements

Convex polygons are easy; non-convex also works (e.g. `rabbit`) as long as
winding is consistent (CW in y-down). Lens surfaces are arc-approximations
(24 verts per arc for convex, 20 for concave).

Lens params are constrained:
- `lens-convex`: user picks `h` (aperture) and `radius`; sagitta is derived.
- `lens-concave`: user picks `w` (rim half-thickness), `h`, `radius`.

Default rotations are chosen so horizontal rays produce a visible effect on
placement:
- `prism` — π/6 (~30°): avoids flint TIR.
- `block` — π/6: axis-aligned block has 0° incidence → passes through invisibly.
- `mirror` — π/4 (45°): axis-aligned thin strip would be grazed by rays.
- `rabbit`, lenses — 0: on-axis is correct.

If you add a new element kind, extend `localPolygon`, `makeElement`, UI's
`sizeFields`, and `elementColor` in the renderer, and add a tool button in
`index.html`.

## Audio input

Toggle `Audio in` in the left panel (or `Q` — that's audio *out*, see below).
`mic-source` picks the signal generator:

- `microphone` — real mic via `getUserMedia`. Browser AGC/AEC/NS are **off**
  (AGC flattens amplitude and makes input look maxed-out). Device selectable
  via the Device dropdown (enumerated `audioinput` devices); defaults to the
  user-agent default.
- `sine 440` / `harmonics 220` — fixed oscillator tone(s) for testing.
- `white` / `pink` — broadband noise.
- `keyboard` — ZXCVBNM / SDGHJ bottom-row claviature, polyphonic sawtooth.
  `,` / `.` shift the base octave. Selecting this source auto-switches Mode
  to chromatic and pins Base to the current octave's C (synced to the Base
  dropdown when octave changes).

All sources feed a single `AnalyserNode` (fftSize=8192, smoothing=0.6), so
downstream code doesn't know where the audio came from.

`micBands(mic, n, mode, baseHz, stepSemi)` bins the FFT into `n` buckets:
- **log** mode: 80–6000 Hz log-spaced — good general coverage.
- **chromatic** mode: `stepSemi`-semitone ladder from `baseHz` upward, window
  half-a-step wide. Default `stepSemi = 1` (one semitone per bucket → total
  range `n` semitones); the Span slider widens this so N buckets can cover
  several octaves at lower pitch resolution.

Both modes apply a noise floor (0.08) and `γ=1.2` shaping so quiet buckets
read zero. Result is written to `scene.emitter.micLevels`. The renderer draws
an amber bar extending from each emitter tick proportional to its bucket.

"Bucket color" option additionally assigns each source a narrow wavelength
band (±12 nm around the source's linearly-mapped position across 400–700 nm)
via `emitter.wlPerSource`, so different notes show as different colors.

## Audio out (sensor synth)

`Audio out` toggles the additive synth (`docs/synth.js`). Each sensor drives
one voice with **6 sine harmonics**. Voice pitch is the log-spaced or
chromatic sensor-index frequency (same base and step as the mic side, so
input and output ladders line up). Harmonic gains come from grouping the
sensor's 64 wavelength bins into 6 groups — so the *timbre* of each voice
depends on which colors hit that sensor.

- Per-frame peak normalization across all partials caps loudness.
- Master gain slider (0–100%).
- Output device picker uses `AudioContext.setSinkId()` (Chromium ≥110).
- `Q` toggles audio out from the keyboard.

## Save/load / history

JSON is `version: 1`. `_selected` is stripped on serialize, `emitter.disabled`
converts between `Set` and array. `deserializeScene` regenerates ids.

Undo/redo: `UI.history` captures scene snapshots. `beginEdit` is lazy (first
mutation in a burst) and `endEdit` commits if the snapshot actually changed,
so a continuous drag or slider scrub becomes a single undo entry. `Ctrl+Z` /
`Ctrl+Shift+Z` (or `Ctrl+Y`) undo/redo; shortcuts are ignored when focus is
in a form control. History restores bump `bumpIdCeiling()` so new placements
don't collide with restored IDs.

On load (preset or file), a synthetic `resize` event is dispatched so
`scene.bench` snaps to the current canvas aspect — otherwise a 1600×900 preset
loaded into a different-aspect viewport would stretch polygons (visible as a
non-equilateral prism).

## Presets

`docs/presets/index.json` is an array of `{label, file}`. The UI fetches it
on startup and populates the Scene panel's Preset dropdown. Shipped presets:
prism rainbow, hyper prism, dark side, converging/diverging lens, double
prism, mirror bounce, dichroic mirrors, tinted glass. Preset files are
identical in shape to saved scenes.

## Mobile

- `touch-action: none` on canvas; pointer events unified.
- Hamburger button toggles left/right drawers, cycles L → R → closed.
- DPR capped at 2 in renderer for perf.

## UI interaction

- Tool palette: click to select tool, then click on canvas to place element.
- **Select**: click to pick, drag to move, Shift-drag or right-button drag to
  rotate around center.
- **Backspace / Delete** removes the selected element.
- **Arrow keys** nudge the selected element by 5 bench units.
  **Shift+Left/Right** rotates by 1° per press (hold to repeat; batched into
  one undo entry).
- **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y**: undo / redo.
- **Q**: toggle audio out.
- Click a left-wall emitter tick: toggle that source on/off. Shift-click: solo
  (disable all others, or restore all if it was already the only one on).
- Sensor "Sync to source count" auto-matches sensor count to emitter count.

## Known gotchas

- `gl.lineWidth` is driver-clamped to 1px on nearly all WebGL implementations.
  Emitter ticks and bars are drawn as stacked 1px lines to look thicker.
- Slider sanity: nothing prevents `wlMin > wlMax`; tracer handles it but the
  output gets weird.
- Large ray counts (128 sources × 2000 rays/source = 256k rays) are the hard
  cap via slider maxes. Product can balloon vertex buffer memory; watch for
  perf drops on low-end mobile.
- `hyper` and `diamond` materials illustrate the `n < 2` TIR constraint —
  don't mistake internal bouncing for a physics bug.
- Chromatic mode range equals `count × stepSemi` semitones. At default
  `stepSemi=1` and 12 sources, only one octave is covered — bump count or
  widen Span to see more of the input spectrum.
- `AudioContext.setSinkId()` is not supported in older browsers; the app
  silently falls back to the system-default audio output.
