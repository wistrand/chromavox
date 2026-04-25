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
  (auto-generated from the element schema in `docs/js/elements.js`).
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
  The last menu item is **Auto ✨** — an action, not a placeable kind
  — see "Auto placement" below.
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
- 1/2/3/4 toggle floating windows: 1=input spectrum, 2=synth spectrum,
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

While an element is selected, a small `+12.3°` overlay (the
`#rotation-label` div inside `#bench-viewport`) shows the current
rotation. The label is anchored just past the tip of the 20-unit
rotation indicator, in the same bearing as `el.rot` — so it reads as
the annotation for the arc rather than a disconnected badge. Position
is computed from `canvas.getBoundingClientRect()` converted into the
label's `offsetParent` coord system so letterbox offsets, aspect
changes, and fullscreen toggles can't shift the label relative to the
indicator. Bench-space offset: `sel.x + cos(rot)·26` horizontal,
`sel.y + sin(rot)·26` vertical (plus a 6 px vertical trim to center
on the line).

## Auto placement

`docs/js/auto-place.js` implements the Add-menu **Auto ✨** action.
Given the current scene and the loaded song (if any), it picks a new
element kind, material, size, rotation, and position that:

1. Doesn't overlap any existing element.
2. Doesn't fall inside the song's *melody band* (the smoothed-peak
   emitter range carrying most of the musical weight) so the line
   isn't transposed or blocked.
3. Prefers placements that interact optically with existing elements
   (chain dispersion past another prism, circle at a convex lens's
   focal point, cavity opposite a flat mirror, complementary-color
   block beside an already-colored element, etc.).
4. Is weight-randomised, so repeated presses on the same scene+song
   yield different but coherent results.

Song analysis (`analyzeSong`) returns a feature vector built from
`song.notes`: per-emitter pitch-energy histogram `W[i] = Σ vel·dur`,
pitch centroid and spread, bass/treble ratios, notes-per-second,
average polyphony (= total note-seconds / duration), velocity σ, bpm,
and the derived `melodyLo/Hi` + `quietLo/Hi` emitter ranges. The
melody band is capped to ≤ N/2 emitters so polyphonic pieces don't
veto the whole bench. The quiet band is the widest-minimum-energy
window (width ≥ N/5) that does not overlap the melody band.

Scene analysis (`analyzeScene`) flags the kinds present, whether
anything is spinning, and whether any element has `el.color` set.
Each synergy unlocks or boosts a candidate — e.g. an existing flat
mirror boosts the "concave mirror cavity" candidate, an existing
prism boosts the "colorful chain-dispersion prism", a colored element
adds a "complementary-color block" candidate anchored to it.

Prisms are deliberately favored — three prism flavors (rotating-bass,
colorful-chain, dispersive-chord) cover most song moods. Circles and
slow-glass / delay materials are **intentionally excluded** from
Auto's candidate pool — they capture or muddy the melody. Blocks are
kept only for the specific complementary-color-filter use case, with
a low weight.

**Mirrors are gated on a prism existing in the scene** and are always
small (flat: w ≈ 40–70 bench units; concave: h ≈ 35–55). They anchor
to the prism so placement orbits the dispersion fan — the intent is
to catch part of the spectrum rather than dominate the bench. A
standalone "scatter" mirror-convex was removed; it tended to wash the
output rather than complement it.

After per-candidate weighting, a **diversity multiplier** divides each
score by `1 + existingCountOfThatKind`. Adding another prism to a
scene that already has one is half as attractive; adding the same
kind twice more is a third. This prevents the "press Auto four times,
get four prisms stacked at the bass" failure mode — once a kind is
placed, novel kinds dominate the weighted pick.

Tempo-synced spin is deliberately gentle — one full rotation every 8,
16, or 32 beats with a 45 deg/s hard cap. The goal is "drifting
slowly" visual motion, not anything hectic.

Candidate weights are jittered (±15%) and sorted; each is then tried
in turn through three placement strategies:

- **S1 Synergy-anchored** — for candidates with an `anchor`, propose
  `(x, y)` downstream of the anchor along `anchor.rot` at a distance
  = `anchorRadius + size/2 + pad`, with small bearing/distance
  perturbations.
- **S2 Quiet-band widest gap** — scan existing elements' x-extents
  within the quiet band's y-range, propose the midpoints of the
  widest empty gaps.
- **S3 Gaussian around preferred center** — both `x` and `y` are
  sampled from Box-Muller normal variates centered on the preferred
  region (quiet-band midpoint for `quiet`, bass/treble mid-heights for
  those hints, the anchor's position for anchored hints). Sigma is
  half the quiet band's height (min 30 px) on y and `bench.w / 4` on
  x. Proposals further from the center are automatically shrunk — the
  size is multiplied by `1 − 0.5·min(1, ‖d/σ‖/2)` — so tail samples are
  smaller and therefore more likely to fit in crowded scenes without
  giving up.

Each proposal is rejected if any of: `isInBench` (element AABB outside
the bench rect), `violatesMelody` (AABB y-range intersects the melody
band y-range), or `overlapsAny` (polygon intersects an existing
element). Retry budget is built into the number of proposals
generated per candidate (~20); candidates are then tried in weight
order. On total failure a `status-toast` message is shown.

Spin sync (point 1 of the design): if nothing in the scene is
spinning and the song is loaded, the element furthest from the
melody-band y-center is given a tempo-synced spin
(`bpm/60 · 2π / beatsPerRotation` rad/s, random sign, random
`beatsPerRotation ∈ {2,4,8}`). Applied together with the new element
inside one `beginEdit/endEdit` so undo collapses the whole Auto
operation to a single history step.

The module is pure (no DOM). UI wiring is in `UI.autoPlace()` in
`ui.js`, triggered from the `data-tool="auto"` menu item. `main.js`
exposes the song player via `window.chromavox.songPlayer` so the UI
method can reach it without constructor plumbing, and provides
`window.chromavox.statusToast(message)` for the failure notification.

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

The serializer also emits:
- `title` — compact auto-label via `autoTitle(scene)`, e.g.
  `"3 prisms, 2 mirrors - vocoder"`. Always regenerated at serialize
  time (no manual title UI).
- `date` — ISO-8601 timestamp (`new Date().toISOString()`).
- `synth` (optional) — `{ carrier, params }` captured from the carrier
  select and cp-slider values by `syncSceneSynth()` in `main.js`.
  `markDirty` calls `syncSceneSynth` before serialize so localStorage
  stays in sync; the Save button uses the `ui.beforeSerialize` hook
  (wired to `syncSceneSynth`) so the downloaded file matches.
- `applySceneSynth()` (called from `resetDisplay`) restores `scene.synth`
  onto the DOM + worklet on file/preset load.

Save button filename: `chromavox-<slug>.json` where `<slug>` comes
from `filenameFromTitle(autoTitle(scene))` in `ui.js` — NFKD-normalized,
diacritics stripped, any non-alphanumeric run collapsed to `-`,
lowercased.

`document.title = 'Chromavox - ' + autoTitle(scene)` is set on init,
on every `markDirty`, and on `resetDisplay`.

Scene auto-saves to `localStorage` (key `'chromavox-scene'`) on every
`markDirty`. On page load, `main.js` restores from localStorage if
available, otherwise calls `createScene()`.

The currently-loaded song is separately persisted under
`'chromavox-song'` as `{ song, selectValue }` — written by
`_persistSong(json)` from `loadSongJson` (so catalog, MusicXML, and
MIDI loads all persist), cleared on empty `songSelect` and on any
scene reset (`resetDisplay`). On page load a persisted song is
restored via `restoreSongJson(json, selectValue)`, which skips the
first-keyframe-element apply (the scene was restored separately and
must not be overwritten) and sets `keyframesPaused = true` so scene
additions the user made on top of the song aren't clobbered when
they press play. The song's `global` config (emitter count, wavelength
range, rays-per-source, sensor count, scale mode, base, span, carrier)
*is* applied explicitly — without it the song would play against
whatever carrier/scale the synth happened to have before reload,
which sounds completely different. Priority order at init: saved song
> saved scene (no song) > catalog default. The welcome overlay is
suppressed on restore.

### Runtime song import

Two paths, sharing `importSongFile(f)` in `main.js`:

- **`⇪` button** next to the song selector (transport bar). Opens a
  hidden `<input type="file">` accepting `.json`, `.xml`,
  `.musicxml`, `.mid`, `.midi`. Loads the file but does not auto-play
  (manual flow). MIDI files do auto-play once the user picks tracks.
- **Drop onto `#stage`** — dragging a file over the stage adds
  `.drop-target` (dashed cyan outline). On drop, the file is read
  and — on success — `playBtn.click()` fires so the song auto-plays.
  The drop gesture counts as user interaction so the AudioContext
  starts. The `songSelect` dropdown clears to reflect that the
  loaded song isn't one of the catalogued ones.

The helper reads the file as `ArrayBuffer`, sniffs the first four
bytes for the MIDI magic `MThd` (Standard MIDI File), then sniffs a
BOM (`FE FF` → UTF-16 BE, `FF FE` → UTF-16 LE) so Finale's UTF-16
MusicXML exports decode correctly, then content-sniffs `<` vs `{`
to choose between `musicxmlToSong(text)` (`docs/js/musicxml.js`)
and `JSON.parse(text)`. MIDI hits open the floating "MIDI tracks"
window (`#midi-tracks-window`) where the user toggles which tracks
contribute notes — see design-song-format.md for the importer
defaults. Errors bubble up via `alert()`.

A small `♪` button sits next to `⇪` in the transport. It is hidden
until the first MIDI import; then it stays available so the user can
reopen the track-picker after closing it. Loading any other song
(catalog dropdown, MusicXML, native JSON) drops the cached MIDI
state and hides the button again.

The welcome overlay (rendered from the loaded song's `welcome`
field) is clickable — clicking or tapping anywhere on it calls
`playBtn.click()`, so the user-prompt "Press ▶ to play" actually
plays when pressed.

### Transport buttons

- **`▶` / `❚❚` Play-pause** — toggles playback on the loaded song.
- **`■` Stop** — stops and resets time to 0.
- **`⟳` Repeat** — toggles `songPlayer.song.loop` on the currently
  loaded song. Uses the existing `button.active` accent colour to
  indicate on/off; `aria-pressed` kept in sync. `loadSongJson`
  calls `syncLoopBtn()` to reflect the loaded song's `loop` field.
- Seek slider + time readout.

MusicXML imports default to `loop: true` (the typical workflow is
"drop a score, it keeps playing") — users turn it off via `⟳`.
Catalogued songs use whatever `loop` is in their JSON.

### Stats window diagnostics

The floating stats window shows both cosmetic stats (FPS, element
counts) and audio-thread diagnostics. Diagnostics are computed only
while the window is open: the worklet gates all extra work behind
`_statsEnabled` and main.js flips it via `synth.setStatsEnabled()`
on show/hide. Stats messages from the worklet are suppressed entirely
when the window is hidden — no worklet → main-thread postMessage
traffic during normal playback.

When opened, the worklet primes its counter so the first stats
message arrives within one block instead of ~500 ms later.

Window position: `showStats()` on first show places it top-right
(`top: 64px; right: 12px`). After that it's user-draggable.
`clampStatsWindow()` is called on show, after each drag, and on
`window.resize` so the window can never end up outside the viewport
— either content wider than the viewport pins it `left: 4px;
right: 4px` with `max-width` set, or the window's existing size is
kept and top/left clamped. Prevents the "reload on mobile leaves
window off-screen" issue.

Displayed audio diagnostics (from the worklet's stats postMessage):

- `CPU/block` / `drift` — wall-clock duration of `process()` and
  cumulative audio-vs-wall-clock skew. Require `performance.now()`
  in the worklet scope; display `-` on platforms where it's absent.
- `Max step` / `D²` — largest first/second derivative in the block's
  output. Catches in-signal clicks we generated.
- `Boundary` — `|bufL[0] - bufL_prev[len-1]|`, isolates voice-skip
  and block-boundary discontinuities from mid-block ones.
- `msgs/block` — inbound `port.onmessage` count per process() call.
  Excess indicates main → worklet message pressure.

Plus main-thread **`RAF p99`** — 99th-percentile RAF-to-RAF interval
over a ring buffer of the last ~240 frames. Correlates audio
glitches with main-thread stalls (GC, heavy layout, etc.).

Clear button `Object.assign`s a fresh `createScene()` over the scene
(not just `elements = []`), calls `syncControls` +
`rebuildSensorReadout`, and removes the localStorage entry. The fresh
`createScene()` provides a clean `scene.runtime` (micLevels,
wlPerSource) and resets `emitter.disabled`, so no manual nulling is
needed. Clear, file-load, and preset-load all invoke the
`onSceneReset` callback (4th UI constructor arg), which in `main.js`
calls `renderer.resetReadout()` (zeros `_displayBins` and `_peakMax`
on the Renderer) and `tracer.resetPersistence()`.

In-place mutations of `emitter.count` / `sensorCount` (UI sliders,
song keyframe globals, undo/redo `_restore`) bump `scene.generation`
via `bumpGeneration(scene)` and call `ensureRuntimeSize(scene)` so
runtime arrays stay co-sized with the emitter count. Without this
pair the tracer's persistence caches and the renderer's edge-memory
accumulators would carry stale values into the new shape. See
CLAUDE.md cross-cutting invariants.

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

`input-device` and `synth-device` dropdowns enumerate `audioinput` and
`audiooutput` devices. Labels only populate after the first mic
permission grant; before that, options show as "input N". Both
re-populate on the `devicechange` event and after the first successful
`inputs.enable`. The input-device row is hidden (via `visibility: hidden`
so space is preserved) when `input-source` isn't the microphone.

## Vertical frequency labels

Two overlays inside `#bench-viewport`:

- `#emitter-labels` on the left edge — input-side scale (`micMode()`,
  `currentBaseHz()`, `chromaticSpan`). Rebuilt on input-side or
  emitter-count changes.
- `#sensor-labels` on the right edge — synth-side scale (`synthMode`,
  `synthBase`, `synthStep`). Rebuilt on synth-side, sensor-count, or
  Independent toggle changes (and also on input-side changes when the
  synth is following the mic). Diverges from emitter labels when
  `Independent scale` is on.

Each row is a tiny `<div>` whose `top` is `((i + 0.5) / count) × 100%`
so labels track the canvas height regardless of resize; the
`transform: translate(0, -50%)` centers it on its tick so even the
topmost label can't escape into the letterbox above the bench. In
any scale mode they show note names via `freqToNote(scaleFreq(...))`;
in log and voice modes they show bucket centre frequency in Hz / kHz
(voice uses the 100–4000 Hz range, log uses 80–6000 Hz). Text colour
is `rgba(220, 230, 240, 0.55)` — deliberately semi-transparent so
rays + smoke dominate the visual.

The **Labels** checkbox in the Bench dropdown toggles a
`#app.no-labels` class (pure CSS `display: none` on both label hosts).
The **Markers** checkbox toggles `renderer.showTicks` for the
GL-drawn wall markers and level indicator. Both are also
auto-hidden on narrow drawer-mode viewports (`@media (max-width: 600px)`
for labels; a `matchMedia` listener gating `showTicks` for markers).
User's checkbox choices re-apply the moment the viewport grows past
600 px.

The **Span** slider row is hidden when the mode is `log` or `voice`
(both are log-spaced, so step size is meaningless). Visibility is
toggled by `syncSpanVisibility()` in `main.js`.

## Smoke + bloom controls

The Bench dropdown hosts four smoke/bloom-related controls:

- **Smoke** checkbox → `renderer.smokeEnabled`. Master toggle. When
  off, the smoke pre-pass, bloom ping-pong, and source packing are
  all skipped entirely (zero GPU cost). `renderer.hasActivePointers`
  is short-circuited to `false` when smoke is disabled so pointer
  sources retired mid-press can't pin the RAF loop awake.
- **Smoke int.** slider (0–2, 0.05 step) → `renderer.smokeIntensity`.
  Multiplies the smoke RGB output. Does not affect density
  modulation of rays, so rays still get their min-0.5 gain even
  when the haze is invisible.
- **Smoke hue** slider (0–360°, 1° step) → `renderer.smokeHue`.
  Rotates the smoke plume colour in HSV (saturation 0.45, value
  0.18). Default 220° matches the original cool blue-grey.
- **Bloom** slider (1.0–2.5, 0.05 step) → `renderer.bloomSpread`.
  Controls `uSpread` in `BLUR_FS`, the per-tap spacing in the 9-tap
  Gaussian. Halo radius at full-res ≈ `spread · 16 px` (clamped
  above 2.5 to avoid kernel banding).

All four values participate in `UI_CONTROL_IDS` persistence, so they
survive reloads. See `architecture-overview.md` for the shader
pipeline details (smoke pre-pass, two-pass blur, HDR bloom
composition in the blit + element passes, elements deliberately
exclude smoke + bloom so glass stays "clean").

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
|| songPlayer.playing || (inputs.active && source !== 'touch') || synth.active`

## Touch level ramping

`setTouchLevel` writes to `_touchTargets`, not `_touchLevels` directly.
`smoothTouchLevels()` is called once per frame in the main loop, ramping
actual levels toward targets (attack 0.2/frame, release 0.15/frame).
Prevents clicks from instant 0→1 steps into vocoder or other carriers.
`inputs.onTouchChange` callback calls `setDirty()` in `main.js` to wake
the frame loop on keyboard note on/off. The idle check keeps the loop
running while any touch level differs from its target (`touchRamping`).
