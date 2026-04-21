# Architecture: Elements

Defined in `docs/scene.js`. Convex polygons are easy; non-convex also
works (e.g. `rabbit`) as long as winding is consistent (CW in y-down).
Lens surfaces are arc-approximations with a fixed number of segments
per arc — see `localPolygon` in `docs/scene.js` for the current values.

Element kinds: `prism`, `block`, `mirror`, `mirror-concave`,
`mirror-convex`, `lens-convex`, `lens-concave`, `circle`, `rabbit`.

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

The renderer's `MAX_EDGES` limit in `docs/renderer.js` constrains how
many vertices an element can have (applies to the polygon representation).

## Lens parameter constraints

- `lens-convex`: user picks `h` (aperture) and `radius`; sagitta is
  derived.
- `lens-concave`: user picks `w` (rim half-thickness), `h`, `radius`.

## Default rotations

Chosen in `makeElement` (`docs/scene.js`) so horizontal rays produce a
visible effect on placement:

- `prism` — rotated to avoid flint TIR at apex-up / 0° incidence.
- `block` — rotated so an axis-aligned block doesn't pass rays through
  invisibly at 0° incidence.
- `mirror` — rotated to 45° so an axis-aligned thin strip isn't grazed
  by rays.
- `mirror-convex` — `Math.PI` (faces left toward incoming rays).
- `rabbit`, lenses, `mirror-concave` — on-axis (rot 0) is correct.

Check `makeElement` for the current values.

## Adding a new element kind

1. Extend `localPolygon` with its geometry.
2. Extend `makeElement` with its defaults (size, material, initial
   `rot`).
3. Extend UI's `sizeFields` map so the property panel shows the right
   sliders, and `bumpSize` in `bindShortcuts` for arrow-key resize.
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
