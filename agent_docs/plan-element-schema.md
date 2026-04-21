# Plan: Element Property Schema

Single source of truth for per-kind element properties. Replaces
scattered defaults in `makeElement`, slider ranges in `sizeFields`,
resize/pinch `switch` statements, and ad-hoc property checks.

## Schema format

`docs/elements.js` — one entry per element kind:

```js
export const ELEMENTS = {
  prism: {
    label: 'Prism',
    material: 'flint',           // default material
    // materials: omitted — all dielectric materials available.
    props: {
      rot:    { default: Math.PI / 6 },
      size:   { label: 'Size',   min: 40,  max: 300, default: 120, step: 1 },
      absorb: { label: 'Absorb', min: 0,   max: 50,  default: 1,   step: 0.1,
                display: v => v.toFixed(1) + '×' },
      spin:   { label: 'Spin',   min: -180, max: 180, default: 0, step: 1,
                unit: 'deg/s', toInternal: v => v * Math.PI / 180,
                fromInternal: v => v * 180 / Math.PI },
      delayK: { label: 'Delay',  min: 0, max: 0.01, default: 0, step: 0.000005 },
      color:  { type: 'color', default: null },
    },
    // Resize behavior: which props scale on Shift+↑/↓ and pinch.
    resize: { keys: ['size'], min: { size: 20 } },
  },

  block: {
    label: 'Block',
    material: 'crown',
    // materials: omitted — all dielectric materials available.
    props: {
      rot:    { default: Math.PI / 6 },
      w:      { label: 'Width',  min: 40,  max: 400, default: 180, step: 1 },
      h:      { label: 'Height', min: 20,  max: 300, default: 80,  step: 1 },
      absorb: { label: 'Absorb', min: 0,   max: 50,  default: 1,   step: 0.1,
                display: v => v.toFixed(1) + '×' },
      spin:   { ... },
      delayK: { ... },
      color:  { type: 'color', default: null },
    },
    resize: { keys: ['w'], min: { w: 20 } },
    pinch:  { keys: ['w', 'h'], min: { w: 20, h: 10 } },
  },

  'lens-convex': {
    label: 'Convex Lens',
    material: 'crown',
    // materials: omitted — all dielectric materials available.
    props: {
      rot:    { default: 0 },
      h:      { label: 'Height', min: 40,  max: 300, default: 110, step: 1 },
      radius: { label: 'Radius', min: 80,  max: 1200, default: 220, step: 1 },
      absorb: { ... },
      spin:   { ... },
      delayK: { ... },
      color:  { type: 'color', default: null },
    },
    resize: { keys: ['h', 'radius'], min: { h: 40, radius: 80 } },
    pinch:  { keys: ['h', 'radius'], min: { h: 40, radius: 80 } },
  },

  mirror: {
    label: 'Mirror',
    material: 'mirror',
    materials: ['mirror', 'mirror-red', 'mirror-green', 'mirror-blue'], // explicit — mirrors only
    props: {
      rot:    { default: Math.PI / 4 },
      w:      { label: 'Width',  min: 30, max: 400, default: 180, step: 1 },
      h:      { label: 'Height', min: 2,  max: 20,  default: 6,   step: 1 },
      spin:   { ... },
      // No absorb, delayK, or color for mirrors.
    },
    resize: { keys: ['w'], min: { w: 20 } },
    pinch:  { keys: ['w'], min: { w: 20 } },
  },

  // ... mirror-concave, mirror-convex, lens-concave, circle, rabbit
};
```

### Property descriptor fields

| Field | Type | Description |
|---|---|---|
| `label` | string | Display name for the slider label |
| `min` | number | Slider minimum |
| `max` | number | Slider maximum |
| `default` | any | Default value for `makeElement` |
| `step` | number | Slider step (default 1) |
| `type` | string | `'color'` for hex color picker, `'range'` (default) for slider |
| `display` | function | Optional `(value) → string` for the label (like carriers.js) |
| `unit` | string | Display unit (informational) |
| `toInternal` | function | Convert from UI value to internal (e.g., deg → rad for spin) |
| `fromInternal` | function | Convert from internal to UI value |

### Element-level fields

| Field | Description |
|---|---|
| `label` | Display name for dropdown/toolbar |
| `material` | Default material |
| `materials` | Optional. Valid materials for this kind. If omitted, all materials of the matching type (dielectric or mirror) are shown. |
| `props` | Property descriptors (ordered — determines slider order) |
| `resize` | Which props change on Shift+↑/↓, with min clamps |
| `pinch` | Which props change on pinch-scale, with min clamps |

## Shared properties

Several properties (`spin`, `delayK`, `absorb`, `color`, `rot`)
appear on most element kinds with identical ranges. Define them
once as templates:

```js
const SPIN = { label: 'Spin', min: -180, max: 180, default: 0, step: 1,
               unit: 'deg/s', toInternal: v => v * Math.PI / 180,
               fromInternal: v => v * 180 / Math.PI };
const DELAY = { label: 'Delay', min: 0, max: 0.01, default: 0, step: 0.000005 };
const ABSORB = { label: 'Absorb', min: 0, max: 50, default: 1, step: 0.1,
                 display: v => v.toFixed(1) + '×' };
const COLOR = { type: 'color', default: null };
```

Then reference via spread: `spin: { ...SPIN }, absorb: { ...ABSORB }`.

---

## Consumers (what reads the schema)

### 1. `makeElement(kind, x, y)` in scene.js

Currently hardcodes defaults per kind. Replace with:

```js
export function makeElement(kind, x, y) {
  const def = ELEMENTS[kind];
  if (!def) throw new Error('unknown element kind: ' + kind);
  const el = { id: genId(), kind, x, y, material: def.material };
  for (const [key, desc] of Object.entries(def.props)) {
    if (desc.default !== undefined && desc.default !== null) {
      el[key] = desc.default;
    }
  }
  return el;
}
```

### 2. Property panel in ui.js

Currently uses `sizeFields` table + ad-hoc slider creation for
material, color, spin, delay, absorb. Replace with a single loop
over `ELEMENTS[el.kind].props`:

```js
for (const [key, desc] of Object.entries(def.props)) {
  if (desc.type === 'color') { /* color picker row */ }
  else { /* slider row: min, max, step, display from desc */ }
}
```

Material dropdown uses `def.materials` if present; otherwise
populates from all `MATERIALS` keys whose type matches the
element's default material type (dielectric or mirror).

### 3. Keyboard resize (Shift+↑/↓) in ui.js

Currently a `switch` on `el.kind`. Replace with:

```js
const resize = ELEMENTS[el.kind].resize;
if (resize) {
  for (const key of resize.keys) {
    el[key] = Math.max(resize.min[key] ?? 0, el[key] + delta);
  }
}
```

### 4. Pinch-scale in ui.js

Currently another `switch`. Replace with:

```js
const pinch = ELEMENTS[el.kind].pinch ?? ELEMENTS[el.kind].resize;
if (pinch) {
  for (const key of pinch.keys) {
    el[key] = Math.max(pinch.min[key] ?? 0, base[key] * scale);
  }
}
```

### 5. `_captureBaseSize` in ui.js

Currently captures `{ size, w, h, radius }` generically. With the
schema, capture all numeric props:

```js
_captureBaseSize(el) {
  const snap = {};
  for (const key of Object.keys(ELEMENTS[el.kind].props)) {
    if (typeof el[key] === 'number') snap[key] = el[key];
  }
  return snap;
}
```

### 6. Serialization validation (optional)

`serializeScene` could strip unknown properties:

```js
elements: scene.elements.map(el => {
  const def = ELEMENTS[el.kind];
  const out = { id: el.id, kind: el.kind, x: el.x, y: el.y };
  for (const key of Object.keys(def.props)) {
    if (el[key] !== undefined) out[key] = el[key];
  }
  out.material = el.material;
  return out;
})
```

### 7. Song format validation

Song keyframes reference element properties by name. The schema
validates that property names are real and values are in range.

### 8. Toolbar dropdown labels + icons

`LABEL_BY_KIND` in ui.js is replaced by `ELEMENTS[kind].label`.

---

## Phases

### Phase 1: Create `docs/elements.js`

Define the schema for all 9 element kinds. Export `ELEMENTS` and
the shared property templates. No consumers changed yet — the
schema is purely declarative.

Validate: write a test that checks every `makeElement` kind
produces the same defaults as the current hardcoded version.

### Phase 2: Wire `makeElement`

Replace the `switch` in `scene.js` with a schema-driven loop.
`makeElement` imports `ELEMENTS` and reads defaults from it.

Validate: existing tests + snapshot verification (element
defaults must not change).

### Phase 3: Wire property panel

Replace `sizeFields`, ad-hoc material/color/spin/delay/absorb
slider creation with a single loop over `ELEMENTS[kind].props`.
Remove `LABEL_BY_KIND` — use `ELEMENTS[kind].label`.

Validate: visual inspection — every slider should appear as before,
same ranges, same labels.

### Phase 4: Wire resize + pinch

Replace the two `switch` statements with schema-driven loops.
Remove `_applyPinchScale` method body — replace with generic.

Validate: test resize and pinch for each element kind.

### Phase 5: Wire serialization (optional)

Add property stripping to `serializeScene` so saved scenes don't
contain stray properties. Add validation to `deserializeScene` so
loaded elements reject unknown properties.

---

## Risk notes

- **Prop ordering matters.** The schema's `props` object determines
  slider order in the panel. ES2015+ guarantees insertion-order
  iteration for string keys. Use insertion order intentionally.

- **`rot` is in props but has no slider.** The property panel shows
  rotation via a custom row (with reset button + keyboard shortcut
  label). The schema should include `rot` for defaults but mark it
  `ui: false` or handle it specially.

- **`toInternal` / `fromInternal` conversions.** Spin is stored in
  rad/s internally but displayed in deg/s. The schema defines the
  conversion functions. The property panel applies them on
  read/write. Other consumers (serialization, song format) see
  the internal value.

- **Backward compatibility.** Old saved scenes and presets may have
  properties not in the schema (or missing properties that are now
  required). `deserializeScene` should apply schema defaults for
  missing properties and silently ignore unknown ones.
