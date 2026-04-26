# Chromavox

Optical synthesizer. Audio input drives a row of light emitters on the left
wall; an additive synth plays back what arrives at sensors on the right wall.
Placeable prisms, lenses, mirrors, colored glass, and dichroic mirrors between
them reshape the pitch mapping, timbre, and routing of the sound. Underneath
is a real 2D optics simulation — Snell refraction, Sellmeier (or Cauchy)
wavelength-dependent index, Beer-Lambert absorption, dichroic reflectance.
Plain HTML + ES modules + WebGL2, no dependencies.

## Run

```
npm start                    # node serve.js, port 8005
node serve.js 9000           # override port
node serve.js --push-display # also spawn Push display sidecar
```

ES modules require HTTP (not `file://`). Server ROOT is `docs/`, which is
also the GitHub Pages folder.

## Tests

`npm test` runs `test/run.js` (Node, no browser, no dependencies).
Do not run tests unless explicitly asked or when a change is likely to
break core math/physics (spectrum, scene geometry, tracer capture/exit).

## Architecture docs

Detailed notes are split into topic files under `agent_docs/`:

- [Overview & module layout](agent_docs/architecture-overview.md)
- [Ray tracer](agent_docs/architecture-raytracer.md)
- [Materials](agent_docs/architecture-materials.md)
- [Elements](agent_docs/architecture-elements.md)
- [Audio in / out](agent_docs/architecture-audio.md)
- [UI & state](agent_docs/architecture-ui.md)
- [Delay materials](agent_docs/architecture-delay.md)
- [MIDI input](agent_docs/architecture-midi.md)
- [Ableton Push](agent_docs/architecture-push.md)
- [Akai controllers](agent_docs/architecture-akai-controllers.md)
- [GPU tracer](agent_docs/architecture-gpu-tracer.md)
- [Song format design](agent_docs/design-song-format.md)
- [Known gotchas](agent_docs/architecture-gotchas.md)
- [Plan: per-ray carrier (per-note instruments)](agent_docs/plan-per-ray-carrier.md)
- [Plan: improve MIDI mapping for typical songs](agent_docs/plan-midi-mapping.md)

Note: `agent_docs/plan-element-schema.md` was removed (implemented).


## Conventions

- **No build step.** No bundlers, transpilers, or runtime deps.
  Browser loads `main.js` via `<script type="module">`.
- **No shader loader.** All GLSL lives as template strings in javascript.
- **ES modules only.** `package.json` sets `"type": "module"`.
- **2-space indentation** in `.js`, `.html`, `<style>`.
- **No AI-isms in user-facing text.** Keep prose direct and
  concrete.
- **Mind GC pressure and wasted work on hot paths.** 
  Prefer pooled scratch objects
  over per-call allocations, pass out-parameters instead of
  returning fresh objects, skip work when there's nothing to do
  (invisible hint, unchanged state, culled region), and guard
  the biggest loops with tighter iteration bounds


## Cross-cutting invariants

These are the load-bearing rules that touch many subsystems. Per-topic
invariants (audio internals, UI behavior, tracer details, etc.) live in
the `agent_docs/architecture-*.md` files listed above — read the
relevant one before editing that subsystem.

- **Coordinates** are bench pixels; y is **down**. Polygon winding,
  outward-normal sign in `worldEdges`, and emitter/sensor index 0
  (bottom of bench, low frequency) all depend on this.
- **Tracer never branches rays** (no Fresnel split). TIR reflects;
  dichroic mirror absorbs the non-reflected fraction. Keeps the vertex
  buffer size predictable across CPU and GPU tracers.
- **Scene JSON is `version: 1`.** IDs are regenerated on deserialize;
  `bumpIdCeiling` keeps the running counter ahead of any restored max.
  `serializeScene` emits `title` (auto-generated via `autoTitle(scene)`),
  `date`, and optional `synth: { carrier, params }`.
- **Transient per-frame state lives on `scene.runtime`** (created by
  `createScene()`): `{ micLevels, wlPerSource }`. `serializeScene`
  excludes runtime via an explicit field list. `Object.assign(scene,
  fresh)` on clear/load/preset automatically replaces runtime.
- **`scene.runtime` array sizing is co-managed with `emitter.count`.**
  `ensureRuntimeSize(scene)` (`scene.js`) is the single owner: resizes
  `runtime.micLevels` and any present `runtime.wlPerSource.{min,max}`
  to match `scene.emitter.count`. Idempotent (cheap when sizes already
  match). Called from every shape-change site (`song.js`
  `_applyKeyframes`, `applyKeyframeAt`; `main.js` `restoreSongJson`,
  top of frame loop; `ui.js` emitter-count handler, `_restore`
  undo/redo). With this contract, every consumer can index by emitter
  index without bounds checks — no per-call `Number.isFinite` /
  length-check guards needed.
- **`scene.generation`** is incremented by `createScene()` AND
  `bumpGeneration(scene)` at every shape-change site (paired with
  `ensureRuntimeSize`). The tracer checks it at the top of `trace()`
  and self-resets all persistence (pools, localPolys, exitSegs,
  sensorPersist, secondary queue) on mismatch. The renderer's edge
  memory uses an analogous tripwire — bumps on generation mismatch OR
  emitter/sensor-count mismatch — so per-row accumulators never carry
  meaning across a row-index reshuffle.
- **Idle RAF loop**: the frame loop stops when nothing needs updating.
  `needsFrame = dirty || particlesInFlight || hasSpinning ||
  touchRamping || songPlayer.playing || inputs.active || synth.active`.
  State-changing handlers call `scheduleFrame()` / `setDirty()` /
  `markDirty()` (the last also persists to localStorage).
- **Element property schema** (`docs/js/elements.js`) is the single
  source of truth for per-kind properties. `makeElement` reads from it;
  property panel and resize/pinch in ui.js are schema-driven.
- **Document title** uses the loaded song's title when one is loaded
  (`songPlayer.song.title`), falling back to `autoTitle(scene)`. Set
  via `updateDocTitle()` from `markDirty`, `resetDisplay`, and
  `loadSongJson`.


## Planning estimates

Never estimate in human time (hours/days/weeks) — meaningless for an agent. 
Use agent-cost units: turn count, tool-call count/mix, or context weight (light/medium/heavy).
Order-of-magnitude only; no fake precision. If it's small, skip the estimate.

Bad: "~500 lines, ~1-2 days."
Good: "~500 lines across 3 files, ~10-15 turns, light context."
