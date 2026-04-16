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
- Layout is a two-row / three-column grid — fixed 54 px toolbar on top,
  left and right panels + stage below. Toolbar stays visible always
  (`z-index: 20`, fixed height, horizontal scroll on narrow widths).
- Window resize scales `el.x` / `el.y` proportionally to the bench-aspect
  change so compositions stay in-bounds; sizes unchanged.
- Touch: single pointer drags/rotates (shift-drag rotates); two
  simultaneous pointers on a selected element pinch-scale + rotate.
- `navigator.mediaDevices` requires a secure context. `mic.enable('mic')`
  guards and throws a clear error on plain HTTP.
