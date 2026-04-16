# Chromavox

Optical synthesizer. Audio input drives a row of light emitters on the left
wall; an additive synth plays back what arrives at sensors on the right wall.
Placeable prisms, lenses, mirrors, colored glass, and dichroic mirrors between
them reshape the pitch mapping, timbre, and routing of the sound. Underneath
is a real 2D optics simulation — Snell refraction, Sellmeier (or Cauchy)
wavelength-dependent index, Beer-Lambert absorption, dichroic reflectance.
Plain HTML + ES modules + WebGL2, no dependencies.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP (not `file://`). Server ROOT is `docs/`, which is
also the GitHub Pages folder.

## Architecture docs

Detailed notes are split into topic files under `agent_docs/`:

- [Overview & module layout](agent_docs/architecture-overview.md)
- [Ray tracer](agent_docs/architecture-raytracer.md)
- [Materials](agent_docs/architecture-materials.md)
- [Elements](agent_docs/architecture-elements.md)
- [Audio in / out](agent_docs/architecture-audio.md)
- [UI & state](agent_docs/architecture-ui.md)
- [Known gotchas](agent_docs/architecture-gotchas.md)

## Key invariants to remember

- Coordinates are bench pixels; y is **down**. Polygon winding and
  outward-normal sign in `worldEdges` depend on it.
- Tracer never branches rays (no Fresnel split). TIR reflects; dichroic
  mirror absorbs the non-reflected fraction. Keeps the vertex buffer
  size predictable.
- Nested / overlapping dielectrics use an inside-element *stack*
  (`this._stack`) so `n1` / `n2` and Beer-Lambert α reflect the actual
  current medium, not just "vacuum or this element".
- Ray hot loop avoids allocations: walls and inside-stack are reused
  Tracer fields; element infos iterate as an array, not a Map iterator.
- Equilateral prism requires `n < 2` for any transmission. `diamond`
  always TIRs; `hyper` is tuned to satisfy the bound.
- Undo/redo batches via `beginEdit` / `endEdit`; drags and slider scrubs
  collapse into one history entry.
- Scene JSON is `version: 1`. IDs are regenerated on deserialize;
  `bumpIdCeiling` keeps the running counter ahead of any restored max.
- Rays render via instanced SDF quads, not GL line primitives — width
  and soft falloff are controlled by `renderer.rayWidth` and the
  fragment shader.
- Element rendering is a three-pass pipeline: rays → FBO → screen blit →
  per-element SDF distortion pass sampling the FBO → overlay lines. Each
  material has a `LOOK` entry in `renderer.js` controlling tint,
  distortion magnitude, falloff, edge glow, and opacity. Sharp vs soft
  edges come from `edgeWidth`; refractive distortion comes from
  `magnitude` and `falloff`. Distortion itself is opt-in via the Distort
  toggle (defaults off); rim glint and tint stay on regardless.
- Per-element `el.color` overrides both visuals *and* physics: renderer
  replaces tint + edge glow; tracer switches to `elementAbsorption` /
  `elementReflectance` that treat the color as a transmission filter.
- Layout is a two-row / three-column grid — fixed-height toolbar on top,
  left and right panels + stage below. Toolbar stays visible always
  (raised z-index over the drawer overlays, fixed height, horizontal
  scroll on narrow widths).
- Bench is **letterboxed** at the canonical portrait golden-ratio aspect
  (`CANONICAL_BENCH` in `scene.js`). `Renderer.benchSize` returns the
  constant; CSS pins the canvas's display aspect with black bars on the
  rest of the stage. Resize never rescales elements. `deserializeScene`
  rescales loaded preset coords + sizes to the canonical bench so older
  presets keep composing correctly.
- Touch: single pointer drags/rotates (shift-drag rotates); two
  simultaneous pointers on a selected element pinch-scale + rotate.
- Emitter ticks: short tap toggles, long-press or shift-click solos.
  Long-press uses a pending object with identity-guarded timer so stale
  timers can't fire on subsequent presses. Timing in `UI.onDown`.
- Inline mini-spectrum painted at each sensor tick on the canvas, drawn
  only when the right-side spectrum panel is off-screen (so it's
  always visible somewhere). Logic in `Renderer.buildOverlay`.
- Vertical frequency labels overlay the canvas left edge, one per
  emitter row, just above each tick. Labels show note names in any
  scale mode, Hz in log mode. Updated whenever count, mode, base, or
  span changes.
- Sensor count can auto-track source count via the **Sync** checkbox
  with a multiplier slider (`sensor-factor`); manual sensor-slider use
  turns sync off.
- Help dialog (`?` button or `H` / `?` key) summarises all shortcuts.
- `navigator.mediaDevices` requires a secure context. `mic.enable('mic')`
  guards and throws a clear error on plain HTTP.
- Synth sweep glitches mitigated with a slow-decaying peak-hold for the
  per-frame normalization and a longer voice-gain time constant in
  `synth.js`.
- Keyboard claviature voices use `'triangle'` so a single key mostly
  occupies one chromatic bucket without turning into a full harmonic
  stack like sawtooth.
- UI shortcuts ignore key events while a drag is in progress
  (`if (this.dragging) return;`) so playing keyboard notes mid-drag
  doesn't hijack the gesture.
- Audio bucketing supports musical scales: `Mode` is one dropdown
  combining `log` with the `SCALES` keys (`chromatic`, `major`,
  `minor`, `pentaMajor`, `pentaMinor`, `wholeTone`, `blues`). `log`
  picks the broadband path; any other value names a scale walked by
  `scaleFreq` from `baseHz`. Window per bucket is the geometric
  midpoint between neighboring scale degrees, so any scale gets full
  coverage with no overlap.
- Synth side can run **independent** of the mic side via the
  `Independent scale` checkbox — separate Mode/Base/Span controls
  appear that drive the synth ladder. Off (default), synth follows
  mic so input-output pitch corresponds under identity optics.
- Mic smoothing is exposed as a slider (`AnalyserNode.smoothingTimeConstant`)
  for per-keyboard-style snappy response or smoother envelope tracking.
- Toolbar's element placement is a div-based dropdown (`Add ▾`) so each
  menu item has space for custom renderings (currently shows an SVG
  thumbnail rendered from the element's own `localPolygon`).
- `endEdit` short-circuits while `this.dragging` is set so unrelated
  events (Shift keyup, slider change) can't prematurely seal the drag's
  pending history snapshot.
