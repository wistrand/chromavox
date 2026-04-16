// Wavelength <-> RGB, dispersion, absorption, mirror reflectance.
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
  let f = 1;
  if (wl < 420) f = 0.3 + 0.7 * (wl - 380) / 40;
  else if (wl > 700) f = 0.3 + 0.7 * (780 - wl) / 80;
  const gamma = 0.8;
  return [Math.pow(r * f, gamma), Math.pow(g * f, gamma), Math.pow(b * f, gamma)];
}

// Sellmeier 3-term (or 2-term): n²(λ) = 1 + Σ B_i · λ² / (λ² − C_i). λ in µm.
// Coeffs as flat array [B1, C1, B2, C2, ...].
export function sellmeierN(coeffs, wlNm) {
  const um = wlNm / 1000;
  const um2 = um * um;
  let n2 = 1;
  for (let i = 0; i + 1 < coeffs.length; i += 2) {
    const B = coeffs[i], C = coeffs[i + 1];
    n2 += B * um2 / (um2 - C);
  }
  return Math.sqrt(Math.max(1, n2));
}

// Cauchy fallback for synthetic materials: n(λ) = A + B/λ². λ in µm.
export function cauchyN(A, B, wlNm) {
  const um = wlNm / 1000;
  return A + B / (um * um);
}

// Dispatch on whichever dispersion data the material provides.
export function materialN(mat, wlNm) {
  if (!mat) return 1;
  if (mat.sellmeier) return sellmeierN(mat.sellmeier, wlNm);
  return cauchyN(mat.A ?? 1, mat.B ?? 0, wlNm);
}

// Beer-Lambert absorption coefficient α(λ), per bench unit. Parametric:
// base (neutral tint) + a Gaussian absorption band.
export function materialAbsorption(mat, wlNm) {
  const a = mat && mat.absorb;
  if (!a) return 0;
  const base = a.base ?? 0;
  if (!a.peak) return base;
  const d = (wlNm - a.center) / a.sigma;
  return base + a.peak * Math.exp(-d * d);
}

// Dichroic mirror reflectance R(λ) in [0,1]. Neutral mirrors have a flat base.
export function mirrorReflectance(mat, wlNm) {
  const r = mat && mat.reflect;
  if (!r) return 0.98;
  const base = r.base ?? 0;
  if (!r.peak) return base;
  const d = (wlNm - r.center) / r.sigma;
  return Math.min(1, base + r.peak * Math.exp(-d * d));
}

// Sellmeier coefficients sourced from Schott / refractiveindex.info for real
// materials; synthetic ones stay on Cauchy for simplicity.
// Absorption α scales are per bench unit; a path of 200 units at the peak
// wavelength attenuates to exp(−200·peak), so peak ≈ 0.004 drops to ~0.45.
export const MATERIALS = {
  crown: {
    type: 'dielectric',
    sellmeier: [1.03961212, 0.00600069867, 0.231792344, 0.0200179144, 1.01046945, 103.560653], // N-BK7
    absorb: { base: 0.00005 },
  },
  flint: {
    type: 'dielectric',
    sellmeier: [1.73759695, 0.013188707, 0.313747346, 0.0623068142, 1.89878101, 155.23629], // N-SF11
    absorb: { base: 0.0002, peak: 0.004, center: 460, sigma: 70 }, // rose-tinted: absorbs blue/violet
  },
  fused: {
    type: 'dielectric',
    sellmeier: [0.6961663, 0.0046791483, 0.4079426, 0.013512063, 0.8974794, 97.93400], // fused silica
    absorb: { base: 0.00003 },
  },
  water: {
    type: 'dielectric',
    A: 1.3240, B: 0.00308,
    absorb: { base: 0.00015, peak: 0.0025, center: 660, sigma: 90 }, // cyan/blue: absorbs red
  },
  diamond: {
    type: 'dielectric',
    sellmeier: [4.3356, 0.011236, 0.3306, 0.030625],
    absorb: { base: 0.00002 },
  },
  hyper: {
    type: 'dielectric',
    A: 1.5000, B: 0.03000,
    absorb: { base: 0.0002, peak: 0.005, center: 540, sigma: 55 }, // magenta: absorbs green
  },

  // Mirrors. Silver is neutral; dichroics reflect a narrow band and absorb the rest.
  mirror:         { type: 'mirror', reflect: { base: 0.98 } },
  'mirror-red':   { type: 'mirror', reflect: { base: 0.04, peak: 0.92, center: 650, sigma: 40 } },
  'mirror-green': { type: 'mirror', reflect: { base: 0.04, peak: 0.92, center: 540, sigma: 40 } },
  'mirror-blue':  { type: 'mirror', reflect: { base: 0.04, peak: 0.92, center: 460, sigma: 40 } },
};
