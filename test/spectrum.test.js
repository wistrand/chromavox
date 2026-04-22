import { test, assert, assertClose } from './run.js';
import {
  wavelengthToRGB, sellmeierN, cauchyN, materialN, materialAbsorption,
  materialDelay, elementDelay, elementAbsorption, elementReflectance,
  hexToRgb, scaleFreq, mirrorReflectance, SCALES, MATERIALS,
} from '../docs/js/spectrum.js';

// --- wavelengthToRGB ---

test('wavelengthToRGB: red at 650nm', () => {
  const [r, g, b] = wavelengthToRGB(650);
  assert(r > 0.5, 'red channel should be high');
  assert(g < 0.15, 'green channel should be low');
  assert(b < 0.01, 'blue channel should be near zero');
});

test('wavelengthToRGB: green at 530nm', () => {
  const [r, g, b] = wavelengthToRGB(530);
  assert(g > 0.5, 'green channel should be dominant');
});

test('wavelengthToRGB: blue at 460nm', () => {
  const [r, g, b] = wavelengthToRGB(460);
  assert(b > 0.5, 'blue channel should be dominant');
});

test('wavelengthToRGB: 780nm boundary is pure red', () => {
  const [r, g, b] = wavelengthToRGB(780);
  assert(r > 0 && g === 0 && b === 0, '780nm should be dim red');
});

test('wavelengthToRGB: returns 3-element array', () => {
  const rgb = wavelengthToRGB(550);
  assert(rgb.length === 3, 'should return [r, g, b]');
  assert(rgb.every(c => c >= 0 && c <= 1), 'channels in [0,1]');
});

// --- Sellmeier / Cauchy ---

test('sellmeierN: BK7 at 589nm ≈ 1.5168', () => {
  const n = sellmeierN(MATERIALS.crown.sellmeier, 589);
  assertClose(n, 1.5168, 0.002);
});

test('cauchyN: basic formula', () => {
  const n = cauchyN(1.5, 0.004, 550);
  const expected = 1.5 + 0.004 / (0.55 * 0.55);
  assertClose(n, expected, 1e-6);
});

test('materialN: dispatches to sellmeier for crown', () => {
  const n = materialN(MATERIALS.crown, 550);
  assert(n > 1.4 && n < 1.7, `crown n(550)=${n} should be ~1.5`);
});

test('materialN: dispatches to cauchy for water', () => {
  const n = materialN(MATERIALS.water, 550);
  assert(n > 1.3 && n < 1.4, `water n(550)=${n} should be ~1.33`);
});

test('materialN: null material returns 1', () => {
  assertClose(materialN(null, 550), 1);
});

// --- Dispersion: n varies with wavelength ---

test('dispersion: crown n(400) > n(700)', () => {
  const n400 = materialN(MATERIALS.crown, 400);
  const n700 = materialN(MATERIALS.crown, 700);
  assert(n400 > n700, 'shorter wavelength should have higher n');
});

// --- Beer-Lambert absorption ---

test('materialAbsorption: crown has low base absorption', () => {
  const a = materialAbsorption(MATERIALS.crown, 550);
  assert(a > 0 && a < 0.001, 'crown base α should be small');
});

test('materialAbsorption: flint has Gaussian peak near 460nm', () => {
  const aPeak = materialAbsorption(MATERIALS.flint, 460);
  const aFar = materialAbsorption(MATERIALS.flint, 700);
  assert(aPeak > aFar * 2, 'absorption at peak center > far from it');
});

test('materialAbsorption: null material returns 0', () => {
  assertClose(materialAbsorption(null, 550), 0);
});

// --- Delay ---

test('materialDelay: slowGlass has delayK', () => {
  const d = materialDelay(MATERIALS.slowGlass);
  assertClose(d, 0.002);
});

test('materialDelay: crown has no delay', () => {
  assertClose(materialDelay(MATERIALS.crown), 0);
});

test('elementDelay: per-element override wins', () => {
  const el = { delayK: 0.005 };
  assertClose(elementDelay(el, MATERIALS.crown), 0.005);
});

test('elementDelay: falls back to material', () => {
  assertClose(elementDelay({}, MATERIALS.slowGlass), 0.002);
});

test('elementDelay: el.delayK = 0 means zero', () => {
  assertClose(elementDelay({ delayK: 0 }, MATERIALS.slowGlass), 0);
});

// --- elementAbsorption with color filter ---

test('elementAbsorption: color override derives α from RGB', () => {
  const el = { color: '#ff0000' };
  const aRed = elementAbsorption(el, MATERIALS.crown, 650);
  const aBlue = elementAbsorption(el, MATERIALS.crown, 460);
  assert(aRed < aBlue, 'red filter should transmit 650nm better than 460nm');
});

// --- Mirror reflectance ---

test('mirrorReflectance: neutral mirror ≈ 0.98', () => {
  assertClose(mirrorReflectance(MATERIALS.mirror, 550), 0.98, 0.01);
});

test('mirrorReflectance: dichroic red peaks at 650nm', () => {
  const rPeak = mirrorReflectance(MATERIALS['mirror-red'], 650);
  const rFar = mirrorReflectance(MATERIALS['mirror-red'], 460);
  assert(rPeak > rFar * 3, 'red dichroic should reflect 650 much more than 460');
});

test('elementReflectance: color override makes it wavelength-selective', () => {
  const el = { color: '#00ff00' };
  const rGreen = elementReflectance(el, MATERIALS.mirror, 530);
  const rRed = elementReflectance(el, MATERIALS.mirror, 650);
  assert(rGreen > rRed, 'green mirror should reflect 530nm more than 650nm');
});

// --- hexToRgb ---

test('hexToRgb: parses #ff0000', () => {
  const [r, g, b] = hexToRgb('#ff0000');
  assertClose(r, 1); assertClose(g, 0); assertClose(b, 0);
});

test('hexToRgb: parses without hash', () => {
  const [r, g, b] = hexToRgb('00ff00');
  assertClose(r, 0); assertClose(g, 1); assertClose(b, 0);
});

test('hexToRgb: invalid returns white', () => {
  const [r, g, b] = hexToRgb('xyz');
  assert(r === 1 && g === 1 && b === 1);
});

// --- Scales and scaleFreq ---

test('SCALES: chromatic has 12 degrees', () => {
  assert(SCALES.chromatic.length === 12);
});

test('SCALES: major has 7 degrees', () => {
  assert(SCALES.major.length === 7);
});

test('scaleFreq: chromatic i=12 is one octave up', () => {
  const base = 261.63;
  const f12 = scaleFreq(base, 'chromatic', 12);
  assertClose(f12, base * 2, 0.01);
});

test('scaleFreq: major i=7 is one octave up', () => {
  const base = 261.63;
  const f7 = scaleFreq(base, 'major', 7);
  assertClose(f7, base * 2, 0.01);
});

test('scaleFreq: stepDeg=2 doubles the step', () => {
  const base = 130.81;
  const f1 = scaleFreq(base, 'chromatic', 1, 2);
  const f2 = scaleFreq(base, 'chromatic', 2, 1);
  assertClose(f1, f2, 0.01);
});

// --- MATERIALS table ---

test('MATERIALS: slowGlass is a dielectric with delayK', () => {
  const m = MATERIALS.slowGlass;
  assert(m.type === 'dielectric');
  assert(m.delayK > 0);
});

test('MATERIALS: diamond has very high n', () => {
  const n = materialN(MATERIALS.diamond, 550);
  assert(n > 2.3, `diamond n(550)=${n} should exceed 2.3`);
});
