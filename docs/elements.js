// Element property schema. Single source of truth for per-kind defaults,
// slider ranges, resize/pinch behavior, material options, and labels.
//
// Consumers: makeElement (scene.js), property panel (ui.js), keyboard
// resize, pinch-scale, toolbar labels, serialization.

// --- Shared property templates ---

const SPIN = {
  label: 'Spin', min: -180, max: 180, default: 0, step: 1,
  toInternal: v => v * Math.PI / 180,
  fromInternal: v => v * 180 / Math.PI,
  resetable: true,
};

const ABSORB = {
  label: 'Absorb', min: 0, max: 50, default: 1, step: 0.1,
  display: v => v.toFixed(1) + '×',
};

const DELAY = {
  label: 'Delay', min: 0, max: 100, default: null, step: 1,
  // UI slider 0-100 maps to 0-DELAY_MAX (0.005 s/bench-unit).
  // Default null = inherit from material (slowGlass has delayK: 0.002).
  toInternal: v => v / 100 * 0.005,
  fromInternal: v => Math.round((v || 0) / 0.005 * 100),
  resetable: true,
};

const COLOR = { type: 'color', default: null };

// --- Element kinds ---

export const ELEMENTS = {
  prism: {
    label: 'Prism',
    material: 'flint',
    props: {
      rot:    { default: Math.PI / 6 },
      size:   { label: 'Size', min: 40, max: 300, default: 120, step: 1 },
      spin:   { ...SPIN },
      delayK: { ...DELAY },
      color:  { ...COLOR },
      absorb: { ...ABSORB },
    },
    resize: { keys: ['size'], min: { size: 20 } },
    pinch:  { keys: ['size'], min: { size: 20 } },
  },

  block: {
    label: 'Block',
    material: 'crown',
    props: {
      rot:    { default: Math.PI / 6 },
      w:      { label: 'Width',  min: 40, max: 400, default: 180, step: 1 },
      h:      { label: 'Height', min: 20, max: 300, default: 80,  step: 1 },
      spin:   { ...SPIN },
      delayK: { ...DELAY },
      color:  { ...COLOR },
      absorb: { ...ABSORB },
    },
    resize: { keys: ['w', 'h'], min: { w: 20, h: 10 }, scale: { h: 0.5 } },
    pinch:  { keys: ['w', 'h'], min: { w: 20, h: 10 } },
  },

  'lens-convex': {
    label: 'Convex Lens',
    material: 'crown',
    props: {
      rot:    { default: 0 },
      h:      { label: 'Height', min: 40,  max: 300,  default: 110, step: 1 },
      radius: { label: 'Radius', min: 80,  max: 1200, default: 220, step: 1 },
      spin:   { ...SPIN },
      delayK: { ...DELAY },
      color:  { ...COLOR },
      absorb: { ...ABSORB },
    },
    resize: { keys: ['h', 'radius'], min: { h: 40, radius: 80 } },
    pinch:  { keys: ['h', 'radius'], min: { h: 40, radius: 80 } },
  },

  'lens-concave': {
    label: 'Concave Lens',
    material: 'crown',
    props: {
      rot:    { default: 0 },
      w:      { label: 'Width',  min: 20,  max: 200, default: 30,  step: 1 },
      h:      { label: 'Height', min: 40,  max: 300, default: 110, step: 1 },
      radius: { label: 'Radius', min: 80,  max: 800, default: 220, step: 1 },
      spin:   { ...SPIN },
      delayK: { ...DELAY },
      color:  { ...COLOR },
      absorb: { ...ABSORB },
    },
    resize: { keys: ['h'], min: { h: 40 } },
    pinch:  { keys: ['h', 'radius'], min: { h: 40, radius: 80 } },
  },

  mirror: {
    label: 'Mirror',
    material: 'mirror',
    materials: ['mirror', 'mirror-red', 'mirror-green', 'mirror-blue'],
    props: {
      rot:    { default: Math.PI / 4 },
      w:      { label: 'Width',  min: 30, max: 400, default: 180, step: 1 },
      h:      { label: 'Height', min: 2,  max: 20,  default: 6,   step: 1 },
      spin:   { ...SPIN },
      color:  { ...COLOR },
    },
    resize: { keys: ['w'], min: { w: 20 } },
    pinch:  { keys: ['w'], min: { w: 20 } },
  },

  'mirror-concave': {
    label: 'Concave Mirror',
    material: 'mirror',
    materials: ['mirror', 'mirror-red', 'mirror-green', 'mirror-blue'],
    props: {
      rot:    { default: Math.PI },
      h:      { label: 'Height', min: 30,  max: 200, default: 80,  step: 1 },
      radius: { label: 'Radius', min: 80,  max: 800, default: 160, step: 1 },
      spin:   { ...SPIN },
      color:  { ...COLOR },
    },
    resize: { keys: ['h'], min: { h: 30 } },
    pinch:  { keys: ['h', 'radius'], min: { h: 30, radius: 80 } },
  },

  'mirror-convex': {
    label: 'Convex Mirror',
    material: 'mirror',
    materials: ['mirror', 'mirror-red', 'mirror-green', 'mirror-blue'],
    props: {
      rot:    { default: Math.PI },
      h:      { label: 'Height', min: 30,  max: 200, default: 80,  step: 1 },
      radius: { label: 'Radius', min: 80,  max: 800, default: 160, step: 1 },
      spin:   { ...SPIN },
      color:  { ...COLOR },
    },
    resize: { keys: ['h'], min: { h: 30 } },
    pinch:  { keys: ['h', 'radius'], min: { h: 30, radius: 80 } },
  },

  circle: {
    label: 'Circle',
    material: 'crown',
    props: {
      rot:    { default: 0 },
      radius: { label: 'Radius', min: 20, max: 300, default: 80, step: 1 },
      spin:   { ...SPIN },
      delayK: { ...DELAY },
      color:  { ...COLOR },
      absorb: { ...ABSORB },
    },
    resize: { keys: ['radius'], min: { radius: 15 } },
    pinch:  { keys: ['radius'], min: { radius: 15 } },
  },

  rabbit: {
    label: 'Rabbit',
    material: 'crown',
    props: {
      rot:    { default: 0 },
      size:   { label: 'Size', min: 60, max: 300, default: 140, step: 1 },
      spin:   { ...SPIN },
      delayK: { ...DELAY },
      color:  { ...COLOR },
      absorb: { ...ABSORB },
    },
    resize: { keys: ['size'], min: { size: 20 } },
    pinch:  { keys: ['size'], min: { size: 20 } },
  },
};

// All element kind names (for iteration / validation).
export const ELEMENT_KINDS = Object.keys(ELEMENTS);
