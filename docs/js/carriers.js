// Carrier parameter descriptors. Single source of truth for UI generation,
// persistence, automation routing, and worklet defaults.
//
// Each carrier entry has:
//   label:  display name in the dropdown
//   params: array of { id, label, min, max, default, step?, display? }
//     - id: matches the worklet message type and the synth.setParam key
//     - min/max: the logical range (slider maps to this)
//     - step: slider step (default 0.01)
//     - display: optional function(value) → string for the label

export const CARRIERS = {
  sine: {
    label: 'sine',
    params: [
      { id: 'partials', label: 'Partials', min: 1, max: 8, default: 6, step: 1,
        display: v => v.toFixed(0) },
    ],
  },
  noise: {
    label: 'noise',
    params: [
      { id: 'noiseQ', label: 'Q', min: 1, max: 50, default: 14, step: 1,
        display: v => v.toFixed(0) },
    ],
  },
  acid: {
    label: 'acid',
    params: [
      { id: 'acidRes',    label: 'Resonance',  min: 0, max: 1, default: 0.85 },
      { id: 'acidEnv',    label: 'Env amount',  min: 0, max: 1, default: 0.60 },
      { id: 'acidCutoff', label: 'Cutoff',      min: 0, max: 1, default: 0.50 },
      { id: 'acidDecay',  label: 'Decay',       min: 0, max: 1, default: 0.40 },
      { id: 'acidDrive',  label: 'Drive',       min: 0, max: 1, default: 0.60 },
    ],
  },
  fm: {
    label: 'FM',
    params: [
      { id: 'fmRatio', label: 'Ratio', min: 1, max: 8, default: 2.0, step: 0.1,
        display: v => v.toFixed(1) },
      { id: 'fmDepth', label: 'Depth', min: 0, max: 1, default: 0.50 },
    ],
  },
  supersaw: {
    label: 'supersaw',
    params: [
      { id: 'ssDetune', label: 'Detune', min: 0, max: 1, default: 0.30 },
    ],
  },
  pulse: {
    label: 'pulse',
    params: [
      { id: 'pulseWidth', label: 'Width', min: 0.05, max: 0.95, default: 0.50,
        display: v => v.toFixed(2) },
    ],
  },
  vocoder: {
    label: 'vocoder',
    params: [
      { id: 'vocExcite', label: 'Excite', min: 0, max: 1, default: 0.5,
        display: v => v < 0.33 ? 'noise' : v < 0.66 ? 'mix' : 'pulse' },
      { id: 'vocAttack', label: 'Attack', min: 1, max: 50, default: 5, step: 1,
        display: v => v.toFixed(0) + 'ms' },
      { id: 'vocRelease', label: 'Release', min: 5, max: 200, default: 20, step: 1,
        display: v => v.toFixed(0) + 'ms' },
    ],
  },
  karplus: {
    label: 'karplus',
    params: [
      { id: 'kpDamping', label: 'Damping', min: 0, max: 1, default: 0.40 },
      { id: 'kpExcite',  label: 'Excite',  min: 0, max: 1, default: 0.50 },
    ],
  },
  piano: {
    label: 'piano',
    params: [
      { id: 'pnoDecay',      label: 'Decay',      min: 0.2, max: 3.0, default: 1.0,
        display: v => v.toFixed(2) + 'x' },
      { id: 'pnoBrightness', label: 'Brightness', min: 0,   max: 1,   default: 0.55 },
      { id: 'pnoStretch',    label: 'Stretch',    min: 0,   max: 1,   default: 0.50 },
    ],
  },
  bell: {
    label: 'bell',
    params: [
      { id: 'bellDecay',      label: 'Decay',      min: 0.2, max: 3.0, default: 1.0,
        display: v => v.toFixed(2) + 'x' },
      { id: 'bellBrightness', label: 'Brightness', min: 0,   max: 1,   default: 0.60 },
    ],
  },
  brass: {
    label: 'brass',
    params: [
      { id: 'brsFormant', label: 'Formant', min: 0, max: 1, default: 0.5 },
      { id: 'brsBite',    label: 'Bite',    min: 0, max: 1, default: 0.5 },
    ],
  },
  bowed: {
    label: 'bowed',
    params: [
      { id: 'bowBright',  label: 'Brightness', min: 0, max: 1, default: 0.5 },
      { id: 'bowVibrato', label: 'Vibrato',    min: 0, max: 1, default: 0.5 },
    ],
  },
};

// All param IDs across all carriers (for persistence, automation).
export const ALL_PARAM_IDS = [];
for (const c of Object.values(CARRIERS)) {
  for (const p of c.params) {
    if (!ALL_PARAM_IDS.includes(p.id)) ALL_PARAM_IDS.push(p.id);
  }
}

// Default values keyed by param ID.
export const PARAM_DEFAULTS = {};
for (const c of Object.values(CARRIERS)) {
  for (const p of c.params) PARAM_DEFAULTS[p.id] = p.default;
}
