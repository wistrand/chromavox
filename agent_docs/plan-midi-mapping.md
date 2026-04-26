# Plan: improve MIDI import mappings for typical songs

The current MIDI import (`docs/js/midi.js`) gets multi-instrument
playback working (Stage 4 of `plan-per-ray-carrier.md`), but typical
MIDI files (piano sonatas, full-band tracks, orchestral scores) reveal
several rough edges. This plan groups improvements by payoff so they
can ship independently.

## Tier 1 — ship first (high impact, ~independent, each ~30 LOC)

### 1. Per-program (128-entry) carrier mapping ✅ SHIPPED

**Why**: today's `_GM_GROUP_TO_CARRIER` lumps 8 GM programs per group.
Within a single group there are real timbral differences that the
group-average mapping flattens:

- 0-7 Piano: harpsichord (6) is plucked → should be `karplus`,
  clavinet (7) is filtered/funky → should be `acid`. Both currently
  map to `piano`.
- 24-31 Guitar: nylon → `karplus`, distortion → `acid`, harmonics →
  `sine` (clean), overdriven → `pulse`.
- 32-39 Bass: acoustic → `karplus`, electric/fretless → `acid`, slap
  → `acid`, synth bass → `pulse`.
- 88-95 Synth pad: most → `supersaw`, but #7 "halo" / #6 "metallic"
  fit `vocoder` better (currently excluded — re-introduce only here).

**How**: replace `_GM_GROUP_TO_CARRIER[16]` with a 128-entry
`_GM_PROGRAM_TO_CARRIER` array. `programToCarrier(prog)` becomes a
single array lookup. No perf cost.

**Estimate**: ~30 LOC, ~5 turns. Light context.

### 2. Sustain pedal (CC 64) honoring ✅ SHIPPED

**Why**: most piano MIDI files use the sustain pedal heavily. Without
honoring it, every note ends abruptly at its `endTick` and pianos
sound choppy. This is the single biggest fidelity loss for
piano-centric files.

**How**: parser already captures CC events (`ccCount` field), but
discards them. Add a per-channel sustain-state walker:

1. During parse, collect `(tick, channel, value)` for CC 64.
2. During `midiToSong` note collection, when a note ends, check if
   sustain is *on* on its channel. If so, extend `endTick` until
   sustain turns *off* on that channel (or the next sustain-off
   event after endTick).
3. Cap extended duration at some max (e.g., 8 seconds) so a stuck
   sustain doesn't hold notes forever.

**Edge cases**: half-pedal (CC 64 values 1-63 are a grey zone in MIDI
spec). Treat ≥ 64 as on, < 64 as off — standard convention.

**Estimate**: ~40 LOC across `midi.js` (parser + converter), ~6 turns.

### 3. Drum track support (channel 10) ✅ SHIPPED

**Why**: GM channel 10 is the conventional drum channel; today it's
silently dropped by `defaultEnabled`. Drums are a big chunk of typical
MIDI and add rhythm. Currently the user gets melody/bass with no
percussion — feels lifeless.

**How**: introduce a small drum-mapping subroutine that runs alongside
note collection. Channel-10 notes route to a fixed handful of
"drum emitters" at the bottom of the bench (lowest 3-4 emitters):

| GM drum note | Role | Maps to |
|---|---|---|
| 35, 36 | Kick | bottom emitter, `noise` short env |
| 38, 40 | Snare | next emitter, `noise` |
| 42, 44, 46 | Hi-hat | upper emitter, `noise` (high register) |
| 49, 51, 57 | Cymbals | top of drum range, `noise` |
| (others) | Toms / perc | mid emitter, `noise` |

Use the existing `noise` carrier — short envelope already gives
percussive character. Stamp `carrier: 'noise'` on each drum note so
they don't compete with melodic timbres.

Default-enabled gate: keep skipping channel-10 unless the new
**Include drums** checkbox in the picker is on.

**Estimate**: ~50 LOC, ~7 turns. Adds a UI checkbox to the MIDI picker.

### 4. Track-name regex polish ✅ SHIPPED

**Why**: current `_PIANO_RE` / `_STRING_RE` miss common abbreviations
(`pno`, `gtr`, `bs`, `drm`, `vox`, `ld`, `pad`, `epiano`, `arp`,
`synth`, `lead`). Many DAW exports use these short names. Track names
are more reliable than program numbers (some files set generic
program 0 but expressive names).

**How**: extend each regex with abbreviations and add new mappings
for synth-lead, pad, voice. `trackCarrier` regex chain order matters
— check most specific first (e.g. `vox`/`voice` → `vocoder` if we
re-introduce it as a niche choice; otherwise `supersaw`).

**Estimate**: ~10 LOC, ~2 turns.

## Tier 2 — good follow-ups (medium impact, more invasive)

### 5. Bass/melody emitter range separation ❌ TRIED AND REVERTED

**Why reverted**: the bench's chromatic ladder is anchored on a
single `base` Hz; emitter `k` plays at `base × 2^(k/12)`. When bass
and melody have a pitch gap (e.g., bass MIDI 31–41, melody MIDI 48–84
in the Jean-Michel Jarre Oxygene file), placing them in adjacent
emitter sections with different `baseMidi` values means the melody
section's emitters play 6+ semitones flat — the ladder is monotonic
but the song's actual pitches skip the gap. Result: melody at the
wrong absolute pitch, sounds harmonically wrong.

A correct fix would require a non-monotonic chromatic ladder (skip
emitters in the gap), but that breaks the "bench is a continuous
spectrum" model and the synth's frequency mapping. Ruled out.

The original problem this was trying to solve — wasted emitter
range when bass and melody have a wide pitch gap — is real, but the
right answer is probably "let the gap be empty emitters" (small
visual cost, no audio cost). Today's mapping already does this.

**Why**: today every track shares `[baseMidi, baseMidi + emitterCount - 1]`.
A song with bass at MIDI 30-55 and melody at 60-90 forces an 60-
emitter range — half the bench wasted on low octaves where notes
rarely happen.

**How**: detect track role (lowest-octave-only → bass; broad / upper
range → melody / harmony). Allocate emitters proportionally — e.g.,
bass gets the bottom 25% (lowest wavelengths), melody gets the top
75%. Per-track `baseMidi` and emitter offset.

Heuristic risk: misclassifying a track loses notes. Make this opt-in
via the picker checkbox **Split bass/melody**, default off.

**Estimate**: ~80 LOC, ~10 turns. Touches the emitter-allocation
section of `midiToSong` significantly.

### 6. Per-track velocity normalization

**Why**: some MIDI files have one track at vel 30-60 and another at
90-127. The loud track dominates; the quiet one is barely audible.

**How**: per track, find the 95th-percentile velocity. Scale that to
1.0; rescale all the track's notes by the same ratio. Existing
`vel * 0.9 + 0.1` floor still applies after normalization.

**Estimate**: ~15 LOC, ~3 turns.

### 7. Velocity curve perceptual reshape ✅ SHIPPED

**Why**: linear `vel * 0.9 + 0.1` doesn't match perceived loudness.
Acoustic instruments (especially piano) have a non-linear velocity
response.

**How**: replace `vel * 0.9 + 0.1` with `pow(vel, 1/2.4) * 0.85 + 0.15`.
Subtle but preserves dynamics in soft passages.

**Estimate**: ~5 LOC, ~1 turn.

### 8. Mid-track program changes ✅ SHIPPED

**Why**: parser keeps only the FIRST program-change event per track
(`track.program`). Some files reuse a track for multiple instruments
via mid-track program changes.

**How**: store `programChanges: [{tick, program}]` per track.
`midiToSong`'s note loop tracks the active program at each note's
`startTick` and resolves the carrier at that point.

**Estimate**: ~30 LOC across parser + converter, ~5 turns.

## Tier 3 — diminishing returns

### 9. Track grouping for shared carrier

Three string tracks all mapping to `supersaw` pile onto the same
emitter range and saturate. A "merge same-carrier tracks" preprocessing
step before per-emitter normalization would help. ~30 LOC.

### 10. Per-emitter polyphony cap

Heavy orchestral MIDI puts > 5 simultaneous notes on the same emitter.
They sum and clip. Cap to `top-3 by velocity` per (emitter, time
window). ~15 LOC.

## Tier 4 — niche / questionable

- **CC 7 channel volume** → per-track volume scaling. Easy but most
  files don't use it expressively.
- **CC 11 expression** → per-note velocity multiplier. Used in
  expressive scores but rare in casual MIDI.
- **CC 1 modulation** → some carrier-specific parameter. Too noisy
  to apply uniformly.
- **Pitch bend** → per-note `wl` offset. Complex; the current
  per-emitter `wl` slot is a pitch *override*, not a real-time bend.
- **GM-2 / GS extensions** → niche, low payoff.

## Recommendation

**Phase 1**: ship #1, #2, #3, #4 in one pass. Each is independent,
small, and addresses a different common pain point (instrument
variety, piano sustain, percussion, name recognition).

**Phase 2**: add #5, #6, #7, #8 as separate iterations once Phase 1
is in users' hands and we see which gaps remain most often.

**Phase 3**: anything in Tier 3 / 4 only if specifically requested
or if a particular MIDI file demonstrates the gap.

## Where the changes land

All Tier 1 changes are in `docs/js/midi.js` (parser + converter) plus
a small UI addition in the MIDI picker (`docs/js/main.js` + small
HTML in `docs/play.html`) for the **Include drums** checkbox.

Tier 2 changes are also mostly `midi.js`, with one new picker
checkbox each.

No changes needed in the synth, tracer, or scene layer — all of this
is upstream of the per-ray-carrier pipeline that already shipped.

## Cross-references

- `agent_docs/plan-per-ray-carrier.md` — the per-ray carrier
  feature (already shipped through Stage 4 partial); MIDI mapping
  is the data feeding it.
- `agent_docs/design-song-format.md` — note format the converter
  emits; new behaviors (carrier per note, drum carrier, etc.)
  remain compatible with the current schema.
