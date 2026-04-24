# Architecture: Elements

Defined in `docs/js/scene.js` (geometry) and `docs/js/elements.js` (property
schema). Convex polygons are easy; non-convex also works (e.g. `rabbit`)
as long as winding is consistent (CW in y-down). Lens surfaces are
arc-approximations with a fixed number of segments per arc — see
`localPolygon` in `docs/js/scene.js` for the current values.

Element kinds: `prism`, `block`, `mirror`, `mirror-concave`,
`mirror-convex`, `lens-convex`, `lens-concave`, `circle`, `rabbit`,
`diamond`.

## Element property schema (`docs/js/elements.js`)

Single source of truth for per-kind element properties. Exports
`ELEMENTS` (10 kinds) and `ELEMENT_KINDS`.

Each kind entry has:
- `label` — display name for dropdown/toolbar.
- `material` — default material.
- `materials` (optional) — valid materials for this kind. If omitted,
  all materials of the matching type (dielectric or mirror) are shown.
- `props` — ordered property descriptors (insertion order = slider
  order in the panel).
- `resize` — which props change on Shift+Up/Down, with min clamps.
- `pinch` — which props change on pinch-scale, with min clamps.

Property descriptor fields: `label`, `min`, `max`, `default`, `step`,
`type` (`'color'` or `'range'` default), `display` (value → string
formatter), `toInternal` / `fromInternal` (UI ↔ internal conversion,
e.g. deg ↔ rad for spin). All numeric sliders render a `×` reset
button automatically — click resets to `desc.default` (or 0 when no
default is declared, matching the old delay-null semantics). The
legacy `resetable` flag is now unused but left on shared templates.

Shared templates defined once and spread: `SPIN`, `ABSORB`, `DELAY`,
`COLOR`. `delayK` default is `null` (inherits from material).

Consumers:
- `makeElement` in `scene.js` reads defaults from the schema.
- Property panel in `ui.js` auto-generates sliders from `props`.
  All sliders show value in faded right-aligned text. Material
  dropdown is first in the panel, uses `def.materials` or falls back
  to all materials matching the element's type.
- Resize/pinch in `ui.js` driven by `ELEMENTS[kind].resize`/`.pinch`.
- `LABEL_BY_KIND` derived from `ELEMENTS[kind].label`.

## Per-element absorption multiplier (`el.absorb`)

Scalar multiplier on Beer-Lambert absorption. Default 1, range 0–50.
Defined in the schema as the `ABSORB` template. CPU tracer:
`elementAbsorption` in `spectrum.js` multiplies the material's base α
by `el.absorb ?? 1`. GPU tracer: stored in element texture row 0
w-channel, read in GLSL `matAbsorption`.

`mirror-concave` and `mirror-convex` are curved mirrors with parameters
`h` (aperture) and `radius`, material `mirror`. They appear in the toolbar
dropdown in `play.html`.

### Concave mirror geometry

Arc center at `(R, 0)` in local space (far right), arc angles `pi-phi`
to `pi+phi`. The surface scoops inward — same shape as one face of a
concave lens. Polygon traces the crescent (non-convex; even-odd fill
handles it). `convex: false` on the arc edge flips the normal.

### Convex mirror geometry

Arc center at `-(R-sag, 0)` (far left), arc angles `-phi` to `+phi`.
The surface bulges outward. Default rotation `Math.PI` (faces left
toward incoming rays).

## Polygon vs arc representations

`localPolygon()` returns dense vertex lists for all elements, used for
rendering, hit-testing, overlap detection, and particle exit in the delay
path. Arc-bearing elements (lens-convex, lens-concave, circle,
mirror-concave, mirror-convex) additionally emit analytic arc edges from
`worldEdges()` via the private `_arcEdges()` helper — these are what the
ray tracer intersects. Straight-edged elements emit segment edges as
before. See architecture-raytracer.md for the edge format and reduction
table.

The renderer's `MAX_EDGES` limit in `docs/js/renderer.js` constrains how
many vertices an element can have (applies to the polygon representation).

`localAABB(el)` is an O(1), zero-allocation sibling that returns just
the axis-aligned bounding box `{ w, h }` in local space, derived
directly from schema fields (size, w, h, radius, and — for diamond —
the table/crown/pavilion ratios). Used by per-frame hot paths like the
smoke-source packer where walking `localPolygon`'s N point objects
(128 for a circle) would be GC-pressure-heavy. If you add a new
element kind, extend both helpers: `localPolygon` for the visible
shape, `localAABB` for the fast bounds.

## Lens parameter constraints

- `lens-convex`: user picks `h` (aperture) and `radius`; sagitta is
  derived.
- `lens-concave`: user picks `w` (rim half-thickness), `h`, `radius`.

## Default rotations

Chosen in `makeElement` (`docs/js/scene.js`) so horizontal rays produce a
visible effect on placement:

- `prism` — rotated to avoid flint TIR at apex-up / 0° incidence.
- `block` — 75° so an axis-aligned block doesn't pass rays through
  invisibly at 0° incidence.
- `mirror` — 45° so an axis-aligned thin strip isn't grazed
  by rays.
- `mirror-convex` — `Math.PI` (faces left toward incoming rays).
- `rabbit`, lenses, `mirror-concave`, `diamond` — on-axis (rot 0) is
  correct.

Check `makeElement` for the current values.

## Diamond

`diamond` uses a round-brilliant-cut side profile: flat table on top,
slanted crown out to the widest girdle, tapering down to a single
culet point. Five vertices. The three brilliant-cut proportions are
exposed as sliders and default to standard ratios:

- `table` (0..0.95, default **0.53**) — table width as a fraction of
  the diameter.
- `crown` (0..0.4, default **0.162**) — crown height as a fraction of
  the diameter (34.5° crown angle).
- `pavilion` (0.05..0.8, default **0.431**) — pavilion depth as a
  fraction of the diameter (40.75° pavilion angle).

Defaults are **Tolkowsky's Ideal Cut** — the classic perfect-cut
proportions: total depth ≈ 59.3% of diameter, table ≈ 53%. Girdle
half-width is always `size/2`. Material is `diamond` (high refractive
index). At any meaningful angle the bounce geometry produces total
internal reflection on every internal hit, so the element behaves as
a closed light trap regardless of entry angle (caveat: some chosen
`el.color` filters can absorb the ray before it returns). Properties:
`size`, `table`, `crown`, `pavilion`, `spin`, `delayK`, `color`,
`absorb`.

## Adding a new element kind

1. Add an entry to `ELEMENTS` in `docs/js/elements.js` with label,
   material, props, resize, and pinch.
2. Extend `localPolygon` in `docs/js/scene.js` with its geometry.
3. Extend `localAABB` in `docs/js/scene.js` with a per-kind bounds
   formula (smoke source packer relies on this; falls back to a
   100×100 default otherwise).
4. Extend `elementOutlineColor` in the renderer (or let it fall through
   to the default) and optionally add a `LOOK` entry for the element
   pass.
5. Add a tool button in `play.html` (inside the `#toolbar .tools`
   group) — `placeable` set in `UI.bindTools` picks it up
   automatically.

## Presets and test scenes

- `czerny-turner.json` — two concave mirrors + flint prism in Z-fold
  monochromator layout.
- `test-concave-mirror.json`, `test-convex-mirror.json` — test presets
  for curved mirrors, included in `trace-snapshot.js` test list.
- Lens snapshots regenerated for analytic arc paths. Mirror and lens
  presets added to `gpu-test.html`.

## Element ID lifecycle

`scene.js` keeps a module-level `nextId` counter. `bumpIdCeiling(n)` is
exported so the history restore path can bump the counter past any
restored max to avoid collisions with subsequent new placements.
`deserializeScene` regenerates IDs on import so an imported file never
collides with the running scene.
