# Architecture: Elements

Defined in `docs/scene.js`. Convex polygons are easy; non-convex also
works (e.g. `rabbit`) as long as winding is consistent (CW in y-down).
Lens surfaces are arc-approximations with a fixed number of segments
per arc — see `localPolygon` in `docs/scene.js` for the current values.

Element kinds: `prism`, `block`, `mirror`, `lens-convex`, `lens-concave`,
`circle`, `rabbit`. The `circle` is a regular polygon approximation;
the count is in `localPolygon`. The renderer's `MAX_EDGES` limit in
`docs/renderer.js` constrains how many vertices an element can have.

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
- `rabbit`, lenses — on-axis (rot 0) is correct.

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
5. Add a tool button in `index.html` (inside the `#toolbar .tools`
   group) — `placeable` set in `UI.bindTools` picks it up
   automatically.

## Element ID lifecycle

`scene.js` keeps a module-level `nextId` counter. `bumpIdCeiling(n)` is
exported so the history restore path can bump the counter past any
restored max to avoid collisions with subsequent new placements.
`deserializeScene` regenerates IDs on import so an imported file never
collides with the running scene.
