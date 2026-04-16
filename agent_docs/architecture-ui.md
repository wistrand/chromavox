# Architecture: UI

## Layout

Two-row, three-column grid in `style.css`:

```
"header header header"   auto (54 px fixed)
"left   stage  right"    1fr
```

- **Header (`#toolbar`)** holds the tool palette, Audio in/out toggles, the
  Distort checkbox, and Save / Load / Clear. Fixed 54 px tall, `z-index: 20`,
  and `overflow-x: auto` with `white-space: nowrap` so it always stays on
  screen regardless of viewport width. Every child has `flex-shrink: 0` so
  nothing compresses below its natural width.
- **Left panel** is parameter-dense (Emitters sliders, Audio-in modulation
  params, Sensors count/sync/volume/device, Selected property panel,
  Preset). Scrolls internally.
- **Stage** hosts the canvas.
- **Right panel** is the sensor-readout stack. `min-height: 100%` so bars
  flex-fill when tall, stay at `min-height: 14 px` and scroll when short.

On `≤ 860 px` the layout switches to a single-column stage under the header
and the side panels slide in as absolute-positioned overlays starting at
`top: 54 px` (matching header height).

## Mouse / pointer interaction

- **Tool palette**: clicking a placeable tool (Prism, Block, Convex Lens,
  Concave Lens, Mirror, Rabbit) drops the element at the centre of the bench
  and reverts to Select. Delete and Select are modal.
- **Select tool**: click to pick an element. Drag to move. Shift-drag (or
  right-button drag) rotates around the element's centre.
- **Two-finger touch (pinch)**: while an element is selected, putting a
  second pointer down starts a combined scale + rotate gesture. Scale
  applies to each kind's primary size fields (`size`, `w`, `h`, `radius`).
  Ends when fewer than two pointers remain.
- **Left-wall emitter tick click**: toggles that source on/off. Shift-click
  solos.
- **Sensor "Sync to source count"** auto-matches sensor count whenever
  source count changes; manually moving the sensor slider turns sync off.

## Keyboard shortcuts

- `←` / `→` — move selected element ±5 bench units.
- `↑` / `↓` — resize the primary dimension by ±8 bench units (`size` for
  prism/rabbit, `w`+`h` for block, `w` for mirror, `h`+`radius` for
  lenses). Clamped to sane minimums.
- `Shift + ←/→` — rotate ±1° per press.
- `Shift + ↑/↓` — fine resize (±1 unit).
- `Backspace` / `Delete` — delete the selected element.
- `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` — undo / redo.
- `Q` — toggle audio out.
- Keyboard claviature (when Audio in source is `keyboard`):
  `Z S X D C V G B H N J M` = one octave; `,` / `.` shift octave down/up.

Shortcuts are ignored when focus is in a form control, so typing into
inputs isn't hijacked.

## Undo / redo

`UI.history` captures scene snapshots as JSON strings (elements, emitter
settings, sensor count, bench, disabled source set).

- `beginEdit` is lazy — captures pre-state on first mutation in a burst.
- `endEdit` commits if the snapshot actually changed.
- A continuous drag, slider scrub, or held arrow key becomes a single undo
  entry.
- History restore calls `bumpIdCeiling()` so new placements don't collide
  with restored IDs.

Mutation entry points that bracket `beginEdit` / `endEdit`:

- Canvas drag (move / rotate / pinch): begin on pointerdown, commit on
  pointerup.
- Property-panel sliders (rotation, size, color picker, hue): begin on
  first `input`, commit on `change`.
- Material / color-reset: begin+commit synchronously.
- Place new element (via toolbar click): begin+commit immediately.
- Preset load, file load, clear, arrow-key nudges, left-wall source
  toggle — all bracket appropriately.

## Per-element color override

Property panel shows a **Color** row with a native color picker, a `×`
reset button, and a **Hue** slider below it. Changing either updates
`el.color`; the picker and slider stay in sync. The override affects:

- The renderer's element pass: body tint (multiplicative + additive) and
  rim-glint color.
- The tracer: `elementAbsorption(el, mat, λ)` derives α from the color's
  transmission filter (complement wavelengths absorb strongly); for
  mirrors, `elementReflectance(el, mat, λ)` tints the reflectance curve
  similarly.

Reset (`×`) clears `el.color` so the material's physics and default
visual return.

## Save / load

JSON is `version: 1`. `_selected` is stripped on serialize.
`emitter.disabled` converts between `Set` and array.
`deserializeScene` regenerates element IDs so imported scenes never
collide with running ones.

On load (preset or file) a synthetic `resize` event is dispatched so
`scene.bench` snaps to the current canvas aspect — otherwise a 1600×900
preset loaded into a different-aspect viewport would stretch polygons.

## Resize behaviour

The window `resize` handler proportionally scales every `el.x` and `el.y`
by the bench-dimension change. Elements stay at the same fraction of the
bench as the aspect changes; sizes are not rescaled. This is what makes
preset loads and window resizes composed scenes visually stable.

## Presets

`docs/presets/index.json` is an array of `{label, file}`. The UI fetches
it on startup and populates the Preset dropdown. Shipped presets: prism
rainbow, hyper prism, dark side, converging lens, diverging lens, double
prism, mirror bounce, dichroic mirrors, tinted glass. Preset files are
identical in shape to saved scenes.

## Device pickers

`mic-device` and `synth-device` dropdowns enumerate `audioinput` and
`audiooutput` devices. Labels only populate after the first mic permission
grant; before that, options show as "input N". Both re-populate on the
`devicechange` event and after the first successful `mic.enable`. The
mic-device row is hidden when `mic-source` isn't the microphone (kept in
layout via `visibility: hidden`).

## Mobile / touch

- `touch-action: none` on the canvas; pointer events unified so a single
  touch drag behaves like a mouse drag and two-finger touch triggers the
  pinch gesture.
- Hamburger button toggles left/right drawers, cycles L → R → closed.
  Positioned at `top: 62 px` so it sits below the 54 px header.
- Drawer panels start at `top: 54 px` to clear the header.
- DPR capped at 2 in the renderer for perf.
