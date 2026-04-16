# Architecture: UI

## Interaction

- **Tool palette**: click to select a tool, then click on the canvas to
  place an element.
- **Select** tool: click to pick, drag to move, Shift-drag (or
  right-button drag) to rotate around the element's center.
- **Backspace / Delete** removes the selected element.
- **Arrow keys** nudge the selected element by 5 bench units.
- **Shift+Left / Shift+Right** rotate by 1° per press (hold to repeat;
  the whole held sequence batches into one undo entry).
- **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** — undo / redo.
- **Q** — toggle audio out.
- **Click on a left-wall emitter tick** — toggle that source on/off.
  **Shift-click** — solo (disable all others, or restore all if it was
  already the only one on).
- **Sensor "Sync to source count"** auto-matches sensor count to
  emitter count whenever the latter changes; manually moving the sensor
  slider turns sync off.

Keyboard shortcuts are ignored when focus is in a form control so typing
into inputs isn't hijacked.

## Undo / redo

`UI.history` captures scene snapshots as JSON strings (elements,
emitter settings, sensor count, bench, disabled source set).

- `beginEdit` is lazy — it captures the pre-state on first mutation in
  a burst.
- `endEdit` commits if the snapshot actually changed.
- A continuous drag or slider scrub becomes a single undo entry; rapid
  arrow presses collapse when held.
- History restore calls `bumpIdCeiling()` so new placements don't
  collide with restored IDs.

Mutation entry points that bracket `beginEdit`/`endEdit`:

- Canvas drag move/rotate (begin on pointerdown, commit on pointerup).
- Property-panel sliders (begin on first `input`, commit on `change`).
- Material select, delete button (both begin/commit synchronously).
- Place new element (begin at placement, commit on pointerup).
- Preset load, file load, clear, arrow-key nudges, left-wall source
  toggle — all bracket appropriately.

## Save / load

JSON is `version: 1`. `_selected` is stripped on serialize.
`emitter.disabled` converts between `Set` and array.
`deserializeScene` regenerates element IDs so imported scenes never
collide with running ones.

On load (preset or file), a synthetic `resize` event is dispatched so
`scene.bench` snaps to the current canvas aspect — otherwise a
1600×900 preset loaded into a different-aspect viewport would stretch
polygons (visible as a non-equilateral prism).

## Presets

`docs/presets/index.json` is an array of `{label, file}`. The UI fetches
it on startup and populates the Scene panel's Preset dropdown. Shipped
presets: prism rainbow, hyper prism, dark side, converging lens,
diverging lens, double prism, mirror bounce, dichroic mirrors, tinted
glass. Preset files are identical in shape to saved scenes.

## Device pickers

`mic-device` and `synth-device` dropdowns enumerate `audioinput` and
`audiooutput` devices. Labels only populate after the first mic
permission grant; before that, options show as "input N". Both
re-populate on the `devicechange` event and after the first successful
`mic.enable`. The mic-device row is hidden when `mic-source` isn't the
microphone (kept in layout via `visibility: hidden`).

## Mobile

- `touch-action: none` on the canvas; pointer events unified so a touch
  drag behaves like a mouse drag.
- Hamburger button toggles left/right drawers, cycles L → R → closed.
- DPR capped at 2 in the renderer for perf.
