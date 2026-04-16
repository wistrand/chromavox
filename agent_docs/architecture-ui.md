# Architecture: UI

## Layout

Two-row, three-column grid defined in `docs/style.css`:

```
"header header header"   auto (fixed-height toolbar)
"left   stage  right"    1fr
```

The stage flex-centers a `#bench-viewport` div locked to the canonical
bench aspect (`aspect-ratio: 556 / 900`). The canvas fills that viewport
exactly, so the rest of the stage is the letterbox black bar. Emitter
labels live inside the viewport so they track the canvas, not the full
stage.

- **Header (`#toolbar`)** holds the tool palette (Add ▾ menu, Select,
  Delete), Audio in / Audio out **split-button dropdowns** (toggle +
  options ▾), the Distort checkbox, Save / Load / Clear, the Preset
  dropdown, and Help. Fixed height, `z-index` above the drawers, and
  `overflow-x: auto` with `white-space: nowrap` so it stays on screen
  regardless of viewport width. Children have `flex-shrink: 0` so
  nothing compresses below its natural width.
- **Left panel** carries the parameter sliders the toolbar dropdowns
  don't own: Emitters (count/wavelength range/rays/spread/aperture),
  Sensors (count/sync/factor), and the Selected property panel.
  Audio in/out controls live entirely in the toolbar `▾` dropdowns.
  Scrolls internally.
- **Stage** hosts the canvas.
- **Right panel** is the sensor-readout stack. `min-height: 100%` on
  the readout and `min-height` per bar (see `.sensor-bar` CSS) mean
  bars flex-fill when tall and stay readable + scroll when short.

On the mobile breakpoint (see the `@media` rule) the layout becomes a
single-column stage under the header; the side panels slide in as
absolute-positioned overlays starting below the header.

## Mouse / pointer interaction

- **Tool palette**: clicking a placeable tool drops the element at the
  centre of the bench and reverts to Select. Delete and Select are
  modal.
- **Select tool**: click to pick, drag to move, Shift-drag (or
  right-button drag) rotates around the element's centre.
- **Two-finger touch (pinch)**: while an element is selected, a second
  pointer starts a combined scale + rotate gesture. Scale applies to
  each kind's primary size fields; rotation updates `rot`. Ends when
  fewer than two pointers remain.
- **Left-wall emitter tick**: short tap toggles on/off. Shift-click or
  long-press solos. The long-press delay, drift cancel distance, and
  solo logic are in `UI.onDown` / `UI._applyEmitterToggle`. Long-press
  uses a deferred-apply timer with an identity guard so stale timers
  from previous presses can't fire against later ones.
- **Sensor "Sync to source count"** auto-matches sensor count to
  `source × sensor-factor` whenever source count or the factor slider
  changes; manually moving the sensor slider turns sync off. Default
  factor is configured in `play.html` (currently `2`).

## Keyboard shortcuts

Defined in `UI.bindShortcuts`. See the source for exact step sizes and
key bindings — they include:

- Arrow keys to move the selected element.
- Shift + Arrow Left/Right to rotate.
- Shift + Arrow Up/Down to resize the primary dimension.
- Backspace / Delete to remove.
- Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y for undo / redo.
- Q to toggle audio out.
- H or ? to toggle the help dialog.
- Keyboard claviature (when Audio in source is `keyboard`): bottom-row
  piano layout, comma / period to shift octave.

Shortcuts are ignored when focus is in a form control so typing into
inputs isn't hijacked. They are also short-circuited while a mouse
drag is in progress (`if (this.dragging) return;`) so the user can
play keyboard notes (or anything else) without delete/move/rotate/undo
hijacking the gesture.

## Undo / redo

`UI.history` captures scene snapshots as JSON strings (elements,
emitter settings, sensor count, bench, disabled source set).

- `beginEdit` is lazy — captures pre-state on first mutation in a
  burst. Also snapshots a `delayFingerprint(scene)` for the Phase 2
  chase re-arm hook.
- `endEdit` commits if the snapshot actually changed, and returns
  `{changed, delayChanged}`. `delayChanged` is true only when the
  delay-fingerprint diff is non-empty (see below).
- `UI.onRearm` (constructor arg #4, called by `endEdit` when
  `delayChanged`) fires the Phase 2 chase re-arm in `main.js`. Plain
  edits — moving a prism, tweaking a mirror's hue, any edit at all in
  a scene with no delay material — never re-arm and therefore never
  drain the current ray image.
- A continuous drag, slider scrub, or held arrow key becomes a single
  undo entry.
- History restore calls `bumpIdCeiling()` so new placements don't
  collide with restored IDs.
- The history depth limit is in the `History` constructor default.

The **delay fingerprint** hashes only the delay-material elements:
their id, material, effective `delayK` (per-element override or
material default), x/y/rot, size/w/h, and color. Non-delay elements
don't contribute. So a scene with no slow-glass produces an empty
fingerprint and no edit ever re-arms; a scene with one slow-glass
re-arms whenever that one element changes.

Mutation entry points that bracket `beginEdit` / `endEdit`:

- Canvas drag (move / rotate / pinch): begin on pointerdown, commit on
  pointerup.
- Property-panel sliders (rotation, size, color, hue): begin on first
  `input`, commit on `change`.
- Material / color-reset: begin+commit synchronously.
- Place new element (toolbar click): begin+commit immediately.
- Preset load, file load, clear, arrow-key nudges, left-wall source
  toggle — all bracket appropriately.

## Per-element color override

Property panel shows a **Color** row with a native color picker, a `×`
reset button, and a **Hue** slider below it. Changing either updates
`el.color`; the picker and slider stay in sync. The override affects:

- Renderer's element pass: body tint (multiplicative + additive) and
  rim-glint color.
- Tracer: `elementAbsorption(el, mat, λ)` derives α from the color's
  transmission filter; for mirrors, `elementReflectance(el, mat, λ)`
  tints the reflectance curve similarly.

Reset clears `el.color` so the material's physics and default visual
return.

## Save / load

JSON is `version: 1`. `_selected` is stripped on serialize.
`emitter.disabled` converts between `Set` and array.
`deserializeScene` regenerates element IDs so imported scenes never
collide with running ones.

On load (preset or file) a synthetic `resize` event is dispatched so
`scene.bench` snaps to the current canvas aspect — otherwise a preset
saved at one aspect loaded into a different-aspect viewport would
stretch polygons.

## Resize behaviour

Bench is letterboxed at the canonical aspect, so element coordinates
are stable across viewport sizes — the resize handler just calls
`renderer.resize()` (re-allocates the FBO etc.) and marks dirty. No
element rescaling. Loading a preset that was authored at a different
bench size triggers `deserializeScene` to rescale element coords +
sizes onto the canonical bench.

## Presets

`docs/presets/index.json` is an array of `{label, file}`. The UI
fetches it on startup and populates the Preset dropdown. Preset files
are identical in shape to saved scenes.

## Device pickers

`mic-device` and `synth-device` dropdowns enumerate `audioinput` and
`audiooutput` devices. Labels only populate after the first mic
permission grant; before that, options show as "input N". Both
re-populate on the `devicechange` event and after the first successful
`mic.enable`. The mic-device row is hidden (via `visibility: hidden`
so space is preserved) when `mic-source` isn't the microphone.

## Vertical frequency labels

Two overlays inside `#bench-viewport`:

- `#emitter-labels` on the left edge — mic-side scale (`micMode()`,
  `currentBaseHz()`, `chromaticSpan`). Rebuilt on mic-side or
  emitter-count changes.
- `#sensor-labels` on the right edge — synth-side scale (`synthMode`,
  `synthBase`, `synthStep`). Rebuilt on synth-side, sensor-count, or
  Independent toggle changes (and also on mic-side changes when the
  synth is following the mic). Diverges from emitter labels when
  `Independent scale` is on.

Each row is a tiny `<div>` whose `top` is `((i + 0.5) / count) × 100%`
so labels track the canvas height regardless of resize. In any scale
mode they show note names via `freqToNote(scaleFreq(...))`; in log
mode they show bucket centre frequency in Hz / kHz.

## Help dialog

Native `<dialog id="help-dialog">` opened via the `?` button in the
toolbar or `H` / `?` keypress. Lists mouse, touch, and keyboard
shortcuts plus the keyboard-claviature note layout. `Esc` closes it.

## Mobile / touch

- `touch-action: none` on the canvas; pointer events unified so a
  single touch drag behaves like a mouse drag and two-finger touch
  triggers the pinch gesture.
- Two independent drawer toggles: `#left-toggle` (top-left) and
  `#right-toggle` (top-right) each `classList.toggle('show-left' /
  'show-right')`. Visible only on the mobile breakpoint.
- Drawer panels start below the header; DPR cap is set in
  `Renderer.resize`.
