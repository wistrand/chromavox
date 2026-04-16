# Architecture: Elements

Defined in `docs/scene.js`. Convex polygons are easy; non-convex also
works (e.g. `rabbit`) as long as winding is consistent (CW in y-down).
Lens surfaces are arc-approximations (24 verts per arc for convex, 20
for concave).

## Lens parameter constraints

- `lens-convex`: user picks `h` (aperture) and `radius`; sagitta is
  derived.
- `lens-concave`: user picks `w` (rim half-thickness), `h`, `radius`.

## Default rotations

Chosen so horizontal rays produce a visible effect on placement:

- `prism` — π/6 (~30°): avoids flint TIR.
- `block` — π/6: axis-aligned block has 0° incidence → passes through
  invisibly.
- `mirror` — π/4 (45°): axis-aligned thin strip would be grazed by rays.
- `rabbit`, lenses — 0: on-axis is correct.

## Adding a new element kind

1. Extend `localPolygon` with its geometry.
2. Extend `makeElement` with its defaults (size, material, initial `rot`).
3. Extend UI's `sizeFields` map so the property panel shows the right
   sliders.
4. Extend `elementColor` in the renderer (or let it fall through to the
   default).
5. Add a tool button in `index.html`.

## Element ID lifecycle

`scene.js` keeps a module-level `nextId` counter. `bumpIdCeiling(n)` is
exported so the history restore path can bump the counter past any
restored max to avoid collisions with subsequent new placements.
`deserializeScene` regenerates IDs on import so an imported file never
collides with the running scene.
