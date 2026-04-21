# Architecture: UI

## Layout

Two-row, three-column grid defined in `docs/style.css`:

```
"header header header"   auto (fixed-height toolbar)
"left   stage  right"    1fr
```

The stage flex-centers a `#bench-viewport` div sized by
`renderer.resize()` to the largest box at the current bench aspect that
fits the stage (computed in JS; pure CSS `aspect-ratio` + `max-width`
broke on narrow mobile portrait screens). Bench aspect is variable:
`scene.bench` is the source of truth. Three presets via a toolbar
Bench dropdown: portrait (556x900), landscape (900x556), square
(900x900). `renderer.setBenchSize(w, h)` updates the letterbox
aspect. The canvas fills the viewport exactly; the rest of the stage
is the letterbox black bar. Emitter labels live inside the viewport so
they track the canvas, not the full stage.

- **Header (`#toolbar`)** holds (left to right): Help (`?`), the Add
  split-button, Delete (trashcan icon, disabled when no selection),
  Bench dropdown (aspect presets, no-overlap, distort, stats, spectrum
  toggles, tracer indicator), Audio in / Audio out **split-button
  dropdowns** (toggle + options `▾`), Save / Load / Clear, and the
  Preset dropdown (styled via `#preset-select`, placeholder `[preset]`).
  Add button label hidden on mobile (<=960px), shows only SVG icon.
  Fixed height, `z-index` above the drawers, `overflow-x: auto` with
  `white-space: nowrap` so it stays on screen regardless of viewport
  width, and `overflow-y: hidden` to prevent a vertical scrollbar.
  Children have `flex-shrink: 0` so nothing compresses below its
  natural width.
- **Left panel** carries: Emitters (count/wavelength range/rays/spread/
  aperture plus a **lambda bend** slider below the wavelength sliders),
  Sensors (count/sync/factor), and the Selected property panel
  (auto-generated from the element schema in `docs/elements.js`).
  Global settings (aspect, no-overlap, distort, stats, spectrum
  toggles, tracer indicator) moved to the Bench toolbar dropdown.
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

- **Tool palette**: the Add button is a split button — left side places
  the last-used element type (shows SVG icon + label), right side (`▾`)
  opens the full dropdown. Picking from the dropdown updates the
  default. Fixed 140 px width to avoid layout shift. Delete is an
  action button (not a mode) — disabled when nothing is selected,
  click deletes the selected element and selects the next one.
  No separate Select button; selection is always the default behavior.
- **Selection**: click/tap an element to select it, drag to move,
  Shift-drag (or right-button drag) rotates around the element's
  centre. Click/tap empty space to deselect. Hit test has a 15px
  proximity fallback for small/thin elements on touch screens.
- **Two-finger touch (pinch)**: if nothing is selected, the element
  whose center is nearest to the midpoint of the two fingers (within
  60% of the finger span) is auto-selected. Then the standard pinch
  gesture starts: scale + rotate. Scale applies to each kind's primary
  size fields; rotation updates `rot`. Ends when fewer than two
  pointers remain.
- **Left-wall emitter tick**: short tap toggles on/off. Shift-click or
  long-press solos. The long-press delay, drift cancel distance, and
  solo logic are in `UI.onDown` / `UI._applyEmitterToggle`. Long-press
  uses a deferred-apply timer with an identity guard so stale timers
  from previous presses can't fire against later ones. Changing the
  emitter count clears `emitter.disabled` so stale toggle indices
  don't persist across count changes.
- **Sensor "Sync to source count"** auto-matches sensor count to
  `source × sensor-factor` whenever source count or the factor slider
  changes; manually moving the sensor slider turns sync off. Default
  factor is configured in `play.html` (currently `2`).

## Keyboard shortcuts

Defined in `UI.bindShortcuts`. See the source for exact step sizes and
key bindings — they include:

- Arrow keys to move the selected element.
- Shift + Arrow Left/Right to rotate.
- Ctrl + Arrow Left/Right to adjust spin by 10 deg/s.
- Shift + Arrow Up/Down to resize the primary dimension.
- Backspace / Delete to remove (triggers the Delete action button,
  which selects the next element after deletion).
- Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y for undo / redo.
- A to toggle audio in.
- Q to toggle audio out.
- H or ? to toggle the help dialog.
- Keyboard claviature (works alongside any source — see
  architecture-audio.md): bottom-row piano layout, comma / period to
  shift octave.
- 1/2/3/4 toggle floating windows: 1=mic spectrum, 2=synth spectrum,
  3=synth waveform, 4=stats.
- F to toggle fullscreen mode.

Shortcuts are ignored when focus is in a form control so typing into
inputs isn't hijacked. They are also short-circuited while a mouse
drag is in progress (`if (this.dragging) return;`) so the user can
play keyboard notes (or anything else) without delete/move/rotate/undo
hijacking the gesture.

## Undo / redo

`UI.history` captures scene snapshots as JSON strings (elements,
emitter settings, sensor count, bench, disabled source set).

- `beginEdit` is lazy — captures pre-state on first mutation in a
  burst.
- `endEdit` commits if the snapshot actually changed.
- A continuous drag, slider scrub, or held arrow key becomes a
  single undo entry.
- History restore calls `bumpIdCeiling()` so new placements don't
  collide with restored IDs.
- The history depth limit is in the `History` constructor default.

Phase 3 does **not** couple the undo system to the delay simulation.
Dragging or reshaping a delay element triggers normal re-traces, so
its held particles continue advancing in the new local frame. Undo
snaps geometry back but does not rewind the photon field — in-flight
particles continue along their current local paths.

Mutation entry points that bracket `beginEdit` / `endEdit`:

- Canvas drag (move / rotate / pinch): begin on pointerdown, commit on
  pointerup.
- Property-panel sliders (rotation, size, color, hue): begin on first
  `input`, commit on `change`.
- Material / color-reset: begin+commit synchronously.
- Place new element (toolbar click): begin+commit immediately.
- Preset load, file load, clear, arrow-key nudges, left-wall source
  toggle — all bracket appropriately.

## Continuous rotation (spin)

Elements can carry `el.spin` (rad/s). The frame loop applies
`el.rot += el.spin * dt`. The property panel shows a **Spin** slider
(-180..180 deg/s) with a `×` reset button. Ctrl+Left/Right adjusts
spin by 10 deg/s. The property serializes into scene JSON and
participates in undo/redo automatically.

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

Scene auto-saves to `localStorage` (key `'chromavox-scene'`) on every
`markDirty`. On page load, `main.js` restores from localStorage if
available, otherwise calls `createScene()`.

Clear button `Object.assign`s a fresh `createScene()` over the scene
(not just `elements = []`), calls `syncControls` +
`rebuildSensorReadout`, and removes the localStorage entry. The fresh
`createScene()` provides a clean `scene.runtime` (micLevels,
wlPerSource) and resets `emitter.disabled`, so no manual nulling is
needed. Clear, file-load, and preset-load all invoke the
`onSceneReset` callback (4th UI constructor arg), which in `main.js`
calls `renderer.resetReadout()` (zeros `_displayBins` and `_peakMax`
on the Renderer) and `tracer.resetPersistence()`.

`syncControls` dispatches `'change'` events on all 7 sliders after
setting values programmatically so label-rebuild listeners in `main.js`
fire correctly.

On load (preset or file) a synthetic `resize` event is dispatched so
`scene.bench` snaps to the current canvas aspect — otherwise a preset
saved at one aspect loaded into a different-aspect viewport would
stretch polygons.

## Resize behaviour

Bench is letterboxed at the current `scene.bench` aspect, so element
coordinates are stable across viewport sizes — the resize handler just
calls `renderer.resize()` (re-allocates the FBO etc.) and marks dirty.
No element rescaling. `deserializeScene` preserves saved bench size
as-is; only legacy 1600x900 scenes are rescaled to the current bench.

## Presets

`docs/presets/index.json` is an array of `{label, file}`. The UI
fetches it on startup and populates the Preset dropdown (styled via
`#preset-select`, placeholder `[preset]`). Preset files are identical
in shape to saved scenes.

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
mode they show note names via `freqToNote(scaleFreq(...))`; in log and
voice modes they show bucket centre frequency in Hz / kHz (voice uses
the 100–4000 Hz range, log uses 80–6000 Hz).

The **Span** slider row is hidden when the mode is `log` or `voice`
(both are log-spaced, so step size is meaningless). Visibility is
toggled by `syncSpanVisibility()` in `main.js`.

## Help dialog

Native `<dialog id="help-dialog">` opened via the `?` button at the
far left of the toolbar (before the Add split-button) or `H` / `?`
keypress. Lists mouse, touch, and keyboard shortcuts plus the
keyboard-claviature note layout. `Esc` closes it.

## Stats window

Floating draggable window toggled via a checkbox in the left panel
(below the Distort checkbox). Shows live counts: elements, sources,
sensors, rays/src, segments, particles, pools, and spinning elements.
Also shows audio stats reported by the worklet: carrier mode,
active/total voices, block size, and xruns (dropped buffers detected
via `currentFrame` gap checking in the worklet). Close button in
titlebar; the pointerdown handler skips `.fw-close` targets to avoid
starting a drag from the close button. Updates every frame when visible
and skips DOM writes when hidden. Stats text is selectable
(`user-select: text`).

## Right wall touch gestures

When **Independent scale** is checked, touch gestures near the right
wall (sensor side) control synth parameters:

- **Drag up/down** near the right wall: shifts synth base frequency.
- **Pinch** on the right wall: zooms synth span.

These gestures are only active when independent scale is on.

## Mobile / touch

- `touch-action: none` on the canvas; pointer events unified so a
  single touch drag behaves like a mouse drag and two-finger touch
  triggers the pinch gesture.
- Two independent drawer toggles: `#left-toggle` (top-left) and
  `#right-toggle` (top-right) each `classList.toggle('show-left' /
  'show-right')`. Visible only on the mobile breakpoint.
- Drawer panels start below the header; DPR cap is set in
  `Renderer.resize`.

## Fullscreen mode

`F` key or the `⛶` button toggles fullscreen. Adds `.fullscreen-mode`
to `#app`, which switches the CSS grid to a two-column layout
(`stage + right`), hiding the toolbar, left panel, transport, and
panel toggles. Scale labels fade to 25% opacity. On mobile (≤600 px)
the right panel is also hidden — only the bench is shown.

Uses the Fullscreen API (`requestFullscreen` / `exitFullscreen`).
A `fullscreenchange` listener removes `.fullscreen-mode` when the
browser exits fullscreen (e.g. via Escape). Resize + setDirty are
called on both enter and exit.

## Idle RAF loop

The frame loop stops when idle — no dirty flag, no particles in flight,
no spinning elements, no audio active, no song playing, and no touch
levels ramping. `scheduleFrame()` wakes it; called from `setDirty()`,
`markDirty()`, and all state-changing event handlers (mic enable/
disable, file play/pause/restart, song play/stop/seek, synth enable,
visibility resume, keyboard shortcuts).

Three-tier scheduling:
- `scheduleFrame()` — wake the RAF loop (display-only updates)
- `setDirty()` — also retrace rays on the next frame
- `markDirty()` — also save to localStorage and pause song keyframes

The idle check at the end of each frame:
`needsFrame = dirty || particlesInFlight || hasSpinning || touchRamping
|| songPlayer.playing || (mic.active && source !== 'touch') || synth.active`

## Touch level ramping

`setTouchLevel` writes to `_touchTargets`, not `_touchLevels` directly.
`smoothTouchLevels()` is called once per frame in the main loop, ramping
actual levels toward targets (attack 0.2/frame, release 0.15/frame).
Prevents clicks from instant 0→1 steps into vocoder or other carriers.
`mic.onTouchChange` callback calls `setDirty()` in `main.js` to wake
the frame loop on keyboard note on/off. The idle check keeps the loop
running while any touch level differs from its target (`touchRamping`).
