// Wavelength <-> RGB and dispersion helpers.
// Wavelengths are in nanometres.

// Dan Bruton's piecewise wavelength->RGB approximation, returns linear [0,1] triple.
export function wavelengthToRGB(wl) {
  let r = 0, g = 0, b = 0;
  if (wl >= 380 && wl < 440) { r = -(wl - 440) / 60; g = 0; b = 1; }
  else if (wl < 490)         { r = 0; g = (wl - 440) / 50; b = 1; }
  else if (wl < 510)         { r = 0; g = 1; b = -(wl - 510) / 20; }
  else if (wl < 580)         { r = (wl - 510) / 70; g = 1; b = 0; }
  else if (wl < 645)         { r = 1; g = -(wl - 645) / 65; b = 0; }
  else if (wl <= 780)        { r = 1; g = 0; b = 0; }
  // intensity fall-off at edges
  let f = 1;
  if (wl < 420) f = 0.3 + 0.7 * (wl - 380) / 40;
  else if (wl > 700) f = 0.3 + 0.7 * (780 - wl) / 80;
  const gamma = 0.8;
  return [Math.pow(r * f, gamma), Math.pow(g * f, gamma), Math.pow(b * f, gamma)];
}

// Cauchy dispersion: n(λ) = A + B/λ²  (λ in micrometres)
export function cauchyN(A, B, wlNm) {
  const um = wlNm / 1000;
  return A + B / (um * um);
}

// Preset glass materials (A, B for Cauchy, µm units)
export const MATERIALS = {
  crown:   { A: 1.5046, B: 0.00420 }, // BK7-ish
  flint:   { A: 1.6700, B: 0.00743 }, // dense flint, strong dispersion
  fused:   { A: 1.4580, B: 0.00354 }, // fused silica
  water:   { A: 1.3240, B: 0.00308 },
};
