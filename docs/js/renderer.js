// WebGL2 renderer. Three passes:
//   1. Rays rendered into an FBO as instanced SDF quads (additive).
//   2. Screen is cleared and the FBO is blitted via a fullscreen quad; then
//      each element interior is drawn with a polygon-SDF fragment shader
//      that samples the FBO with a per-pixel offset to distort the rays
//      underneath (refractive glass look). Material parameters differ per
//      material — sharp edges for diamond, softer for crown, opaque tint
//      for mirrors, etc.
//   3. Overlay lines on top (bench outline, emitter/sensor ticks, element
//      outlines, selection handle). Alpha blend.

import { worldEdges, localPolygon } from './scene.js';
import { wavelengthToRGB, MATERIALS } from './spectrum.js';

const MAX_EDGES = 128;
// Smoke displacement sources. Mirrors the #define in SMOKE_FS — keep in sync.
// 48 sources × 2 vec4s = 96 vec4 uniform slots; WebGL2 guarantees ≥ 224.
const MAX_SMOKE_SOURCES = 48;
const PTR_FADE_SEC = 0.35;
const PTR_RISE_SEC = 0.15; // exponential ramp-in when a finger touches down
const PTR_RADIUS_BENCH = 120;
const K_ELEM_STRENGTH = 2.2; // push strength per element source (bench units, pre-normalization)
const K_SPIN_SWIRL = 7.0;    // swirl strength per rad/s of element angular velocity
const K_PTR_STRENGTH = 3.2;  // swirl strength per pointer source

const RAY_VS = `#version 300 es
in vec2 aCorner;
in vec4 aSeg;
in vec4 aCol1;
in vec4 aCol2;
uniform vec2 uBench;
uniform float uWidth;
out float vAlong;
out float vSide;
out vec4 vCol1;
out vec4 vCol2;
void main() {
  vec2 p1 = aSeg.xy;
  vec2 p2 = aSeg.zw;
  vec2 dir = p2 - p1;
  float len = max(length(dir), 1e-6);
  vec2 u = dir / len;
  vec2 n = vec2(-u.y, u.x);
  vec2 center = mix(p1, p2, aCorner.x);
  vec2 pos = center + n * uWidth * aCorner.y;
  vec2 nd = pos / uBench;
  nd.y = 1.0 - nd.y;
  gl_Position = vec4(nd * 2.0 - 1.0, 0.0, 1.0);
  vAlong = aCorner.x;
  vSide = aCorner.y;
  vCol1 = aCol1;
  vCol2 = aCol2;
}`;

const RAY_FS = `#version 300 es
precision highp float;
in float vAlong;
in float vSide;
in vec4 vCol1;
in vec4 vCol2;
out vec4 outColor;
void main() {
  float d = abs(vSide);
  float amp = 1.0 - smoothstep(0.0, 1.0, d);
  vec4 c = mix(vCol1, vCol2, vAlong);
  outColor = vec4(c.rgb * amp, c.a * amp);
}`;

const BLIT_VS = `#version 300 es
in vec2 aCorner;
out vec2 vUV;
void main() {
  vUV = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

// Animated 2D simplex-noise smoke drawn into the HDR ray FBO *before*
// the ray pass. Rays then additively accumulate on top, so the smoke
// reads as a faint drifting backdrop rather than a foreground effect.
// Implementation: Ashima Arts simplex noise + 3-octave FBM with a
// horizontal drift velocity modulated by time.
const SMOKE_VS = `#version 300 es
in vec2 aCorner;
out vec2 vUV;
void main() {
  vUV = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

const SMOKE_FS = `#version 300 es
precision highp float;
#define MAX_SOURCES 48
in vec2 vUV;
uniform float uTime;
uniform vec2 uAspect;    // (bench.w, bench.h)
uniform float uIntensity;
uniform float uHue;      // smoke "hi" color hue in degrees (0..360)

// Smoke displacement sources. Each source is two vec4s:
//   s0 = (cx, cy, invRx, invRy)   center in bench units + local-axis inverse radii
//   s1 = (cosA, sinA, pushK, swirlK)
//        cosA/sinA: element rotation (for anisotropic falloff)
//        pushK: radial push magnitude (≥ 0 for elements, 0 for pointers)
//        swirlK: tangential swirl magnitude (signed: +CCW, −CW)
// A source can mix push + swirl freely — e.g. a spinning element gets
// both a push from its presence and a swirl proportional to el.spin.
// WebGL2 min MAX_FRAGMENT_UNIFORM_VECTORS is 224, so 96 vec4s here is
// safe on every conformant implementation. Bump MAX_SOURCES with care.
uniform int uSourceCount;
uniform vec4 uSources[MAX_SOURCES * 2];

out vec4 outColor;

// HSV to linear RGB. h in [0,1], s, v in [0,1].
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// Ashima Arts simplex noise (2D). Output ~[-1, 1].
vec3 _perm(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = _perm(_perm(i.y + vec3(0.0, i1.y, 1.0))
                     + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                          dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// FBM with a tiny per-octave drift. Kept slow so layers don't slide
// against each other fast enough to read as chop or ripples.
float fbm(vec2 p, float t) {
  float v = 0.0;
  float a = 0.5;
  vec2 shift = vec2(0.0);
  float dir = 1.0;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p + shift);
    p *= 2.03;
    a *= 0.5;
    shift += dir * vec2(t * 0.012, -t * 0.008);
    dir = -dir;
  }
  return v;
}

void main() {
  // Large feature size — plumes fill a good fraction of the bench so
  // the smoke reads as diffuse haze rather than small churning detail.
  // Breathing modulator is slow (~110 s period) and gentle so the
  // field doesn't pulse visibly.
  float scaleMod = 1.0 + 0.25 * sin(uTime * 0.057);
  vec2 p0 = vUV * uAspect / (300.0 * scaleMod);

  // Extremely slow rotation — mostly to avoid the drift feeling like a
  // conveyor belt, not to make the field visibly spin.
  float ang = uTime * 0.008;
  float cs = cos(ang), sn = sin(ang);
  vec2 p = mat2(cs, -sn, sn, cs) * p0;

  // Gentle drift. Both axes modulated by their own slow sines so the
  // motion is never a steady vector. Faster numbers made it feel like
  // water currents; these are 4× slower.
  p.x += uTime * 0.018 * (1.0 + 0.4 * sin(uTime * 0.05));
  p.y += uTime * 0.011 * (1.0 + 0.5 * sin(uTime * 0.07 + 1.3));

  // Domain warp using off-axis offsets, keeping the warp direction
  // unaligned with the noise grid so we don't get the straight edges
  // that axis-aligned warps produce. Amplitude dropped (0.85 → 0.3) so
  // the warp nudges the field rather than stretching it into rivers.
  float wt = uTime * 0.045;
  vec2 warp = vec2(
    snoise(p * 1.4 + vec2( wt * 0.8,  wt * 0.4)),
    snoise(p * 1.4 + vec2(-wt * 0.3,  wt * 0.9) + 17.3)
  );

  // --- Source displacement ---
  // Object sources push smoke radially; pointer sources swirl it. The
  // anisotropic elliptic falloff lets a long mirror have a long wake
  // without anisotropizing the push direction. Accumulated in bench
  // space, then scaled into FBM-input space (same 300 times scaleMod
  // divisor as p0) and added to the ambient turbulence warp. The
  // per-source strength constant is tuned low so the ambient
  // turbulence dominates and the sources just nudge the field.
  vec2 sourceWarp = vec2(0.0);
  if (uSourceCount > 0) {
    // Bench y runs TOP→DOWN (y=0 is top, y=bench.h is bottom) while vUV
    // has y=0 at the bottom of the quad. Flip Y so sources in bench
    // coords line up with the on-screen position of each fragment.
    vec2 pBench = vec2(vUV.x, 1.0 - vUV.y) * uAspect;
    for (int i = 0; i < MAX_SOURCES; i++) {
      if (i >= uSourceCount) break;
      vec4 s0 = uSources[i * 2];
      vec4 s1 = uSources[i * 2 + 1];
      vec2 d = pBench - s0.xy;
      // Rotate d into the source's local frame (for anisotropic falloff).
      vec2 lx = vec2( s1.x * d.x + s1.y * d.y,
                     -s1.y * d.x + s1.x * d.y);
      vec2 e = lx * s0.zw;
      // Squared elliptic falloff: 1/(e²+1)² drops off ~quadratically
      // so the influence stays localized. Plain 1/(e²+1) combined with
      // dir = d (magnitude grows linearly with distance) kept roughly
      // 30% of peak force at 3× the radius.
      float fall = 1.0 / (dot(e, e) + 1.0);
      fall *= fall;
      // Independent push (radial) and swirl (tangential) contributions.
      // A stationary element gives pure push; a spinning one adds
      // swirl proportional to its angular velocity; a pointer is pure
      // swirl with zero push.
      vec2 rad = d;
      vec2 tng = vec2(-d.y, d.x);
      sourceWarp += (rad * s1.z + tng * s1.w) * fall;
    }
    // Convert to FBM-input space. Same 300 * scaleMod divisor as p0,
    // and flip Y because the warp is computed in bench coords (y down)
    // while p lives in vUV coords (y up).
    sourceWarp.x /=  (300.0 * scaleMod);
    sourceWarp.y /= -(300.0 * scaleMod);
  }

  float n = fbm(p + warp * 0.30 + sourceWarp, uTime);

  // Soft, wide smoothstep — no hard plume edges. This is the main
  // "faded smoke" lever: the wider the range, the more washed-out the
  // result looks.
  float m = smoothstep(-0.6, 0.95, n);

  // Lightly tinted grey. Both endpoints are darker and closer
  // together than before so the smoke sits as a backdrop, never
  // competing with the rays.
  // Hue-driven plume color. The "hi" is HSV with low saturation (0.45)
  // and modest value (0.18) — a cool dusty tone at any hue. The "lo"
  // is a tiny tint of the same hue so dense and sparse regions read as
  // the same fog rather than two unrelated colors.
  vec3 hi = hsv2rgb(vec3(uHue / 360.0, 0.45, 0.18));
  vec3 lo = hi * 0.12;
  vec3 col = mix(lo, hi, m);
  // RGB = smoke color; A = normalized density [0,1] used as the
  // "how visible are rays here" mask in the blit + element passes.
  outColor = vec4(col * uIntensity, m);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uSmoke;
uniform sampler2D uBloom; // half-res separable-Gaussian blur of rays (HDR)
uniform int uUseSmoke;    // 1 = smoke backdrop + density-gated bloom, 0 = pass-through
out vec4 outColor;

vec3 reinhard(vec3 c) { return c / (1.0 + c); }

void main() {
  vec3 raysSharp = reinhard(texture(uTex, vUV).rgb);
  if (uUseSmoke == 1) {
    vec4 s = texture(uSmoke, vUV);
    float d = s.a;
    // Bloom comes from the separately-blurred half-res ray buffer —
    // proper smooth Gaussian halo, no mipmap box artifacts. Density
    // scales opacity; the kernel is fixed-radius, a consistent soft
    // "laser in fog" halo regardless of smoke thickness.
    vec3 bloom = reinhard(texture(uBloom, vUV).rgb) * d;
    float gain = mix(0.5, 1.0, d);
    outColor = vec4(s.rgb + raysSharp * gain + bloom, 1.0);
  } else {
    outColor = vec4(raysSharp, 1.0);
  }
}`;

// Element shader: draws a bounding quad in world space, discards pixels
// outside the polygon (SDF), and inside the polygon samples the FBO with
// an offset driven by distance from the nearest edge — so the ray image
// underneath distorts as if bent by a lens.
const ELEM_VS = `#version 300 es
in vec2 aCorner;
uniform vec2 uAabbMin;
uniform vec2 uAabbMax;
uniform vec2 uBench;
out vec2 vBench;
out vec2 vUV;
void main() {
  vBench = mix(uAabbMin, uAabbMax, aCorner);
  vec2 nd = vBench / uBench;
  nd.y = 1.0 - nd.y;
  vUV = vec2(nd.x, nd.y);
  gl_Position = vec4(nd * 2.0 - 1.0, 0.0, 1.0);
}`;

const ELEM_FS = `#version 300 es
precision highp float;
#define MAX_EDGES ${MAX_EDGES}
in vec2 vBench;
in vec2 vUV;
uniform vec2 uAabbMin;
uniform vec2 uAabbMax;
uniform int uEdgeCount;
uniform vec4 uEdges[MAX_EDGES];
uniform vec3 uTint;
uniform float uTintStrength;
uniform float uMagnitude;
uniform float uFalloff;
uniform vec3 uEdgeGlow;
uniform float uEdgeGlowAmp;
uniform float uEdgeWidth;
uniform float uOpaque;       // 1.0 → ignore FBO (opaque tint); 0.0 → refractive sample
uniform vec2 uBench;
uniform sampler2D uFbo;
uniform sampler2D uSmoke;
uniform sampler2D uBloom;
uniform int uUseSmoke;       // 1 → modulate ray sample by smoke density + bloom at the refracted UV
out vec4 outColor;

void main() {
  // Polygon SDF via loop over edges. Also tracks the closest edge point so
  // we can derive a distortion direction.
  float minDist2 = 1e18;
  vec2 nearest = vec2(0.0);
  bool inside = false;
  for (int i = 0; i < MAX_EDGES; i++) {
    if (i >= uEdgeCount) break;
    vec2 a = uEdges[i].xy;
    vec2 b = uEdges[i].zw;
    vec2 ba = b - a;
    vec2 pa = vBench - a;
    float denom = max(dot(ba, ba), 1e-12);
    float h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
    vec2 q = a + ba * h;
    vec2 diff = vBench - q;
    float d2 = dot(diff, diff);
    if (d2 < minDist2) { minDist2 = d2; nearest = q; }
    // Point-in-polygon crossing test (even-odd rule).
    if (abs(b.y - a.y) > 1e-9) {
      bool crossY = (a.y > vBench.y) != (b.y > vBench.y);
      if (crossY) {
        float xCross = a.x + (vBench.y - a.y) * (b.x - a.x) / (b.y - a.y);
        if (vBench.x < xCross) inside = !inside;
      }
    }
  }
  if (!inside) discard;

  float dist = sqrt(minDist2);

  // Shared light-facing factor: edges whose outward normal faces the
  // upper-left light (Y is down, so upper-left = (-1, -1)) are both
  // brighter (rim glint) AND refract more strongly (distortion).
  vec2 light = normalize(vec2(-1.0, -1.0));
  vec2 outward = normalize(nearest - vBench + vec2(1e-5));
  float facing = dot(outward, light);          // -1..+1
  float facingT = clamp(facing * 0.5 + 0.5, 0.0, 1.0);  // 0..1

  // Base sample from the FBO (HDR ray image). The distortion direction
  // is taken from the polygon centroid, not the nearest edge, to avoid
  // the medial-axis discontinuity. Reinhard tone-mapped to [0,1] before
  // mixing so additive ray pile-ups become smooth bright colors instead
  // of clamping to white.
  vec3 baseRgb;
  if (uOpaque < 0.5) {
    vec2 center = 0.5 * (uAabbMin + uAabbMax);
    vec2 centerDir = normalize(vBench - center + vec2(1e-5));
    float edgeT = 1.0 - smoothstep(0.0, uFalloff, dist);
    float distortScale = mix(0.35, 1.0, facingT);
    vec2 offsetBench = -centerDir * uMagnitude * edgeT * distortScale;
    vec2 offsetUV = offsetBench / uBench;
    offsetUV.y = -offsetUV.y;
    vec2 uv = clamp(vUV + offsetUV, vec2(0.0), vec2(1.0));
    vec3 hdr = texture(uFbo, uv).rgb;
    baseRgb = hdr / (1.0 + hdr);
    // Smoke + bloom are intentionally NOT applied inside the element:
    // the glass reads as a clean light pipe, not as a window into the
    // haze. The mental model is that the element's interior has no
    // atmosphere, so rays don't scatter off anything (no halo) and
    // there's no fog to show through the body.
  } else {
    baseRgb = vec3(0.0);
  }

  // Tint + edge glow. Apply the tint both multiplicatively (rays through
  // glass pick up its color, colored-glass filter look) and additively
  // (body is visible even where no rays reach).
  vec3 filtered = mix(baseRgb, baseRgb * uTint, uTintStrength * 0.8);
  vec3 tinted = filtered + uTint * uTintStrength;
  float glowT = 1.0 - smoothstep(0.0, uEdgeWidth, dist);
  vec3 glow = uEdgeGlow * uEdgeGlowAmp * glowT;
  vec3 rgb = tinted + glow;

  // Rim highlight: same light direction; peaks where the edge faces the light.
  float rimFacing = max(0.0, facing);
  float rimBand = 1.0 - smoothstep(0.0, uEdgeWidth * 2.0, dist);
  float rim = pow(rimFacing, 3.0) * rimBand * 0.6;

  // Opaque materials use the tint as body color; refractive overlay composites.
  if (uOpaque > 0.5) {
    outColor = vec4(uTint + glow + vec3(1.0) * rim, 1.0);
  } else {
    outColor = vec4(rgb + vec3(1.0) * rim, 1.0);
  }
}`;

// Separable Gaussian blur program — one pass horizontal, one vertical.
// `uTexel` carries the step direction + magnitude (one texel in that
// direction, multiplied outside by 1.0 for the pure texel spacing).
// 9-tap kernel, sigma ≈ 2 half-res pixels; weights sum to 1.0.
const BLUR_VS = `#version 300 es
in vec2 aCorner;
out vec2 vUV;
void main() {
  vUV = aCorner;
  gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uTexel;   // one texel offset in the current pass's direction
uniform float uSpread; // tap spacing multiplier — slider-controlled
out vec4 outColor;
void main() {
  // 9-tap normalized Gaussian. Spread multiplier controls kernel width:
  // 1.0 → ~8 px full-res halo, 2.5 → ~32 px, 4.0 → ~50 px. Past ~4.5
  // the finite tap count shows banding, so clamp the UI slider there.
  vec2 d = uTexel * uSpread;
  vec3 acc = texture(uTex, vUV).rgb * 0.227027;
  acc += texture(uTex, vUV + d * 1.0).rgb * 0.1945946;
  acc += texture(uTex, vUV - d * 1.0).rgb * 0.1945946;
  acc += texture(uTex, vUV + d * 2.0).rgb * 0.1216216;
  acc += texture(uTex, vUV - d * 2.0).rgb * 0.1216216;
  acc += texture(uTex, vUV + d * 3.0).rgb * 0.054054;
  acc += texture(uTex, vUV - d * 3.0).rgb * 0.054054;
  acc += texture(uTex, vUV + d * 4.0).rgb * 0.016216;
  acc += texture(uTex, vUV - d * 4.0).rgb * 0.016216;
  outColor = vec4(acc, 1.0);
}`;

const OVERLAY_VS = `#version 300 es
in vec2 aPos;
in vec4 aColor;
uniform vec2 uBench;
out vec4 vColor;
void main() {
  vec2 p = aPos / uBench;
  p.y = 1.0 - p.y;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  vColor = aColor;
}`;

const OVERLAY_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

// Per-material visual parameters for the element pass.
const LOOK = {
  crown:         { tint: [0.55, 0.80, 1.00], tintStrength: 0.08, magnitude: 5,  falloff: 40, edgeGlow: [0.7, 0.9, 1.0], edgeGlowAmp: 0.35, edgeWidth: 4,  opaque: false },
  flint:         { tint: [1.00, 0.70, 0.80], tintStrength: 0.08, magnitude: 7,  falloff: 40, edgeGlow: [1.0, 0.7, 0.8], edgeGlowAmp: 0.35, edgeWidth: 4,  opaque: false },
  fused:         { tint: [0.85, 1.00, 0.95], tintStrength: 0.05, magnitude: 3,  falloff: 35, edgeGlow: [0.8, 1.0, 0.9], edgeGlowAmp: 0.25, edgeWidth: 3,  opaque: false },
  water:         { tint: [0.50, 0.75, 1.00], tintStrength: 0.10, magnitude: 4,  falloff: 55, edgeGlow: [0.5, 0.7, 1.0], edgeGlowAmp: 0.30, edgeWidth: 5,  opaque: false },
  diamond:       { tint: [1.00, 1.00, 0.90], tintStrength: 0.04, magnitude: 13, falloff: 22, edgeGlow: [1.0, 1.0, 0.8], edgeGlowAmp: 0.80, edgeWidth: 2,  opaque: false },
  hyper:         { tint: [1.00, 0.50, 1.00], tintStrength: 0.12, magnitude: 15, falloff: 30, edgeGlow: [1.0, 0.5, 1.0], edgeGlowAmp: 0.45, edgeWidth: 3,  opaque: false },
  slowGlass:     { tint: [0.55, 0.45, 0.95], tintStrength: 0.18, magnitude: 9,  falloff: 50, edgeGlow: [0.7, 0.6, 1.0], edgeGlowAmp: 0.45, edgeWidth: 4,  opaque: false },
  mirror:        { tint: [0.75, 0.80, 0.95], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [1.0, 1.0, 1.0], edgeGlowAmp: 0.70, edgeWidth: 2,  opaque: true },
  'mirror-red':  { tint: [0.95, 0.25, 0.25], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [1.0, 0.6, 0.6], edgeGlowAmp: 0.65, edgeWidth: 2,  opaque: true },
  'mirror-green':{ tint: [0.25, 0.90, 0.40], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [0.6, 1.0, 0.7], edgeGlowAmp: 0.65, edgeWidth: 2,  opaque: true },
  'mirror-blue': { tint: [0.25, 0.40, 1.00], tintStrength: 1.0,  magnitude: 0,  falloff: 1,  edgeGlow: [0.6, 0.7, 1.0], edgeGlowAmp: 0.65, edgeWidth: 2,  opaque: true },
};
const DEFAULT_LOOK = LOOK.crown;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    // HDR float framebuffer for rays — required so additive blending can
    // accumulate past 1.0 without clamping. Tone-mapping happens in the
    // blit and element fragment shaders. Falls back to RGBA8 if the
    // extension is unavailable (older mobile GPUs).
    this.hdrEnabled = !!gl.getExtension('EXT_color_buffer_float');

    // --- Programs ---
    this.rayProgram = buildProgram(gl, RAY_VS, RAY_FS);
    this.ray = {
      aCorner: gl.getAttribLocation(this.rayProgram, 'aCorner'),
      aSeg:    gl.getAttribLocation(this.rayProgram, 'aSeg'),
      aCol1:   gl.getAttribLocation(this.rayProgram, 'aCol1'),
      aCol2:   gl.getAttribLocation(this.rayProgram, 'aCol2'),
      uBench:  gl.getUniformLocation(this.rayProgram, 'uBench'),
      uWidth:  gl.getUniformLocation(this.rayProgram, 'uWidth'),
    };

    this.blitProgram = buildProgram(gl, BLIT_VS, BLIT_FS);
    this.blit = {
      aCorner:    gl.getAttribLocation(this.blitProgram, 'aCorner'),
      uTex:       gl.getUniformLocation(this.blitProgram, 'uTex'),
      uSmoke:     gl.getUniformLocation(this.blitProgram, 'uSmoke'),
      uBloom:     gl.getUniformLocation(this.blitProgram, 'uBloom'),
      uUseSmoke:  gl.getUniformLocation(this.blitProgram, 'uUseSmoke'),
    };

    this.smokeProgram = buildProgram(gl, SMOKE_VS, SMOKE_FS);
    this.smoke = {
      aCorner:      gl.getAttribLocation(this.smokeProgram, 'aCorner'),
      uTime:        gl.getUniformLocation(this.smokeProgram, 'uTime'),
      uAspect:      gl.getUniformLocation(this.smokeProgram, 'uAspect'),
      uIntensity:   gl.getUniformLocation(this.smokeProgram, 'uIntensity'),
      uHue:         gl.getUniformLocation(this.smokeProgram, 'uHue'),
      uSourceCount: gl.getUniformLocation(this.smokeProgram, 'uSourceCount'),
      uSources:     gl.getUniformLocation(this.smokeProgram, 'uSources[0]'),
    };
    this.smokeEnabled = false;
    this.smokeIntensity = 1.0;
    this.smokeHue = 220; // cool blue-grey by default — the original look
    this.showTicks = true; // emitter + sensor wall markers

    // Smoke source state. `_sourceData` is a pooled Float32Array packed
    // per-frame in updateSources(); `_pointerSources` is a fixed-size
    // ring where rapid taps overwrite the oldest entry. Zero GC on
    // the hot path.
    this._sourceData = new Float32Array(MAX_SMOKE_SOURCES * 8);
    this._sourceCount = 0;
    this._pointerSources = [];
    for (let i = 0; i < 16; i++) {
      this._pointerSources.push({
        id: -1, x: 0, y: 0,
        tPress: 0,       // touchdown time — drives exponential ramp-in
        tRelease: 0,
        active: false,   // slot in use
        released: false, // pointer has been lifted; fade from tRelease
      });
    }
    this._hasActivePointers = false;

    // Separate FBO for the smoke pre-pass. RGBA8 is plenty — RGB holds
    // the cool-grey haze color, alpha holds normalized density used as
    // the ray-visibility mask by the blit + element passes.
    this.smokeFbo = gl.createFramebuffer();
    this.smokeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.smokeTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Blur program + bloom ping-pong pair for the smoke-gated bloom.
    // bloomTexA stores the horizontal-blur result, bloomTexB the final
    // horizontal+vertical Gaussian that the blit/elem shaders sample.
    this.blurProgram = buildProgram(gl, BLUR_VS, BLUR_FS);
    this.blur = {
      aCorner: gl.getAttribLocation(this.blurProgram, 'aCorner'),
      uTex:    gl.getUniformLocation(this.blurProgram, 'uTex'),
      uTexel:  gl.getUniformLocation(this.blurProgram, 'uTexel'),
      uSpread: gl.getUniformLocation(this.blurProgram, 'uSpread'),
    };
    this.bloomSpread = 1.6;
    this.bloomFboA = gl.createFramebuffer();
    this.bloomFboB = gl.createFramebuffer();
    this.bloomTexA = gl.createTexture();
    this.bloomTexB = gl.createTexture();
    for (const t of [this.bloomTexA, this.bloomTexB]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this._bloomW = 2;
    this._bloomH = 2;

    this.elemProgram = buildProgram(gl, ELEM_VS, ELEM_FS);
    this.elem = {
      aCorner:       gl.getAttribLocation(this.elemProgram, 'aCorner'),
      uAabbMin:      gl.getUniformLocation(this.elemProgram, 'uAabbMin'),
      uAabbMax:      gl.getUniformLocation(this.elemProgram, 'uAabbMax'),
      uBench:        gl.getUniformLocation(this.elemProgram, 'uBench'),
      uEdgeCount:    gl.getUniformLocation(this.elemProgram, 'uEdgeCount'),
      uEdges:        gl.getUniformLocation(this.elemProgram, 'uEdges[0]'),
      uTint:         gl.getUniformLocation(this.elemProgram, 'uTint'),
      uTintStrength: gl.getUniformLocation(this.elemProgram, 'uTintStrength'),
      uMagnitude:    gl.getUniformLocation(this.elemProgram, 'uMagnitude'),
      uFalloff:      gl.getUniformLocation(this.elemProgram, 'uFalloff'),
      uEdgeGlow:     gl.getUniformLocation(this.elemProgram, 'uEdgeGlow'),
      uEdgeGlowAmp:  gl.getUniformLocation(this.elemProgram, 'uEdgeGlowAmp'),
      uEdgeWidth:    gl.getUniformLocation(this.elemProgram, 'uEdgeWidth'),
      uOpaque:       gl.getUniformLocation(this.elemProgram, 'uOpaque'),
      uFbo:          gl.getUniformLocation(this.elemProgram, 'uFbo'),
      uSmoke:        gl.getUniformLocation(this.elemProgram, 'uSmoke'),
      uBloom:        gl.getUniformLocation(this.elemProgram, 'uBloom'),
      uUseSmoke:     gl.getUniformLocation(this.elemProgram, 'uUseSmoke'),
    };

    this.overlayProgram = buildProgram(gl, OVERLAY_VS, OVERLAY_FS);
    this.overlay = {
      aPos:   gl.getAttribLocation(this.overlayProgram, 'aPos'),
      aColor: gl.getAttribLocation(this.overlayProgram, 'aColor'),
      uBench: gl.getUniformLocation(this.overlayProgram, 'uBench'),
    };

    // --- Static geometry ---
    // Ray quad corners: triangle strip (along, side).
    this.rayCornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rayCornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, -1,  0, 1,  1, -1,  1, 1,
    ]), gl.STATIC_DRAW);
    // Unit quad corners for blit and element programs: triangle strip (0..1).
    this.unitQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0,  1, 0,  0, 1,  1, 1,
    ]), gl.STATIC_DRAW);

    // --- Dynamic buffers ---
    this.segBuf = gl.createBuffer();
    this.overlayBuf = gl.createBuffer();
    this.overlayData = new Float32Array(0);
    this.overlayCount = 0;

    // --- Framebuffer for ray image ---
    this.fbo = gl.createFramebuffer();
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Scratch for per-element edge uploads.
    this._edgeData = new Float32Array(MAX_EDGES * 4);

    // Width of rays in bench units. 2–3 is a nice range for a 900-tall bench.
    this.rayWidth = 2.5;

    // Refractive distortion through glass is optional; the rim glint and
    // tint stay on regardless.
    this.distortEnabled = false;

    // Sensor readout smoothing state. Lives on the renderer so
    // resetReadout() can flush it without a separate callback chain.
    this._displayBins = new Float32Array(0);
    this._peakMax = 1e-6;
    this._blurBuf = new Float32Array(0);

    this._benchW = 556;
    this._benchH = 900;

    // Adaptive quality: progressively reduce visual fidelity when FPS
    // drops, restore when it recovers. Tier 0 = full quality.
    this.qualityTier = 0;
    this._qFrameTimes = []; // rolling window of frame durations (ms)
    this._qLastTime = 0;
    this._qCheckInterval = 500; // ms between tier evaluations
    this._qLastCheck = 0;
    this._userRaysPer = 0; // original user-set raysPerSource (0 = not capped)

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // Call at the start of each frame with the scene to update quality tier.
  updateQuality(scene) {
    const now = performance.now();
    if (this._qLastTime > 0) {
      // Clamp idle-wake gaps. Chromavox's RAF loop stops when nothing
      // is happening; the first frame after resumption (user edit,
      // mic enable, tab refocus) would otherwise register a multi-
      // second "frame" and tank the rolling average. 200 ms caps the
      // metric at ~5 FPS, already deep in the tier-5 region — any
      // genuine render that slow still maxes out the tier ladder.
      const delta = Math.min(200, now - this._qLastTime);
      this._qFrameTimes.push(delta);
      if (this._qFrameTimes.length > 30) this._qFrameTimes.shift();
    }
    this._qLastTime = now;

    if (now - this._qLastCheck < this._qCheckInterval) return;
    this._qLastCheck = now;
    if (this._qFrameTimes.length < 5) return;

    // Rolling average FPS from frame times.
    const avgMs = this._qFrameTimes.reduce((a, b) => a + b, 0) / this._qFrameTimes.length;
    const fps = 1000 / avgMs;

    const prev = this.qualityTier;
    // Hysteresis: enter at threshold, exit at threshold + 10fps.
    if (fps < 10)      this.qualityTier = Math.max(this.qualityTier, 5);
    else if (fps < 15)  this.qualityTier = Math.max(this.qualityTier, 4);
    else if (fps < 20)  this.qualityTier = Math.max(this.qualityTier, 3);
    else if (fps < 30)  this.qualityTier = Math.max(this.qualityTier, 2);
    else if (fps < 45)  this.qualityTier = Math.max(this.qualityTier, 1);
    // Recovery: drop tier when fps is well above the entry threshold.
    if (fps > 55 && this.qualityTier >= 1) this.qualityTier = 0;
    else if (fps > 40 && this.qualityTier >= 2) this.qualityTier = 1;
    else if (fps > 30 && this.qualityTier >= 3) this.qualityTier = 2;
    else if (fps > 25 && this.qualityTier >= 4) this.qualityTier = 3;
    else if (fps > 20 && this.qualityTier >= 5) this.qualityTier = 4;

    // Apply tier changes.
    if (this.qualityTier !== prev) {
      // Drop the rolling window so the next evaluation is based on
      // fresh data at the new tier. Avoids tier bouncing when a stale
      // outlier from the previous tier is still in the window.
      this._qFrameTimes.length = 0;
      // Tier 3+: DPR = 1.
      if (this.qualityTier >= 3 || (prev >= 3 && this.qualityTier < 3)) {
        this.resize();
      }
      // Tier 4/5: cap raysPerSource.
      if (this.qualityTier >= 4 && !this._userRaysPer) {
        this._userRaysPer = scene.emitter.raysPerSource;
      }
      if (this.qualityTier >= 5) {
        scene.emitter.raysPerSource = Math.min(scene.emitter.raysPerSource, 48);
      } else if (this.qualityTier >= 4) {
        scene.emitter.raysPerSource = Math.min(scene.emitter.raysPerSource, 128);
      } else if (this._userRaysPer && this.qualityTier < 4) {
        scene.emitter.raysPerSource = this._userRaysPer;
        this._userRaysPer = 0;
      }
    }
  }

  setBenchSize(bw, bh) {
    this._benchW = bw;
    this._benchH = bh;
    this.resize();
  }

  resize() {
    const vp = this.canvas.parentElement;
    const stage = vp.parentElement;
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    const ASPECT = this._benchW / this._benchH;
    let w = stageH * ASPECT;
    let h = stageH;
    if (w > stageW) { w = stageW; h = stageW / ASPECT; }
    vp.style.width  = Math.floor(w) + 'px';
    vp.style.height = Math.floor(h) + 'px';
    // Sync sensor readout height to bench viewport so bars align
    // with sensor positions on the canvas (not the full panel height).
    const readout = document.getElementById('sensor-readout');
    if (readout) {
      readout.style.height = Math.floor(h) + 'px';
      readout.style.marginTop = Math.floor((stageH - h) / 2) + 'px';
    }

    const dpr = this.qualityTier >= 3 ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(2, Math.floor(w * dpr));
    this.canvas.height = Math.max(2, Math.floor(h * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // Reallocate the FBO color attachment as RGBA16F when supported so the
    // ray pass can accumulate beyond 1.0 in linear HDR space.
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    if (this.hdrEnabled) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.canvas.width, this.canvas.height, 0,
        gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);

    // Smoke density texture (separate from the HDR FBO so rays can be
    // modulated by smoke without having to disentangle them later).
    gl.bindTexture(gl.TEXTURE_2D, this.smokeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.smokeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.smokeTex, 0);

    // Half-res bloom ping-pong targets. RGBA16F so HDR ray brightness
    // survives the blur pair; bloom is then Reinhard-tonemapped in the
    // blit/elem shaders alongside the rays.
    const bw = Math.max(2, Math.floor(this.canvas.width / 2));
    const bh = Math.max(2, Math.floor(this.canvas.height / 2));
    this._bloomW = bw;
    this._bloomH = bh;
    const bloomInternal = this.hdrEnabled ? gl.RGBA16F : gl.RGBA;
    const bloomType = this.hdrEnabled ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    for (const [tex, fbo] of [
      [this.bloomTexA, this.bloomFboA],
      [this.bloomTexB, this.bloomFboB],
    ]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, bloomInternal, bw, bh, 0,
        gl.RGBA, bloomType, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  benchSize() {
    return { w: this._benchW, h: this._benchH };
  }

  // Register / move / release a pointer-driven swirl source at bench
  // coordinates. Sources are keyed by `id` (pointer ID) so the swirl
  // follows the finger live: pointerdown → push, pointermove → push
  // again with the same id (updates position in place), pointerup →
  // release. Released sources fade over PTR_FADE_SEC. No-op when
  // smoke is disabled — without updateSources() to run the fade, a
  // live pointer would pin `_hasActivePointers` forever.
  pushPointerSource(id, x, y) {
    if (!this.smokeEnabled) return;
    // Update existing active slot for this id if one exists.
    for (const p of this._pointerSources) {
      if (p.active && !p.released && p.id === id) {
        p.x = x; p.y = y;
        this._hasActivePointers = true;
        return;
      }
    }
    // Otherwise take an unused slot, then the oldest released one,
    // then (last resort) the oldest active one.
    let slot = -1;
    let oldestReleasedT = Infinity;
    let oldestActiveT = Infinity;
    let bestReleased = -1;
    let bestActive = -1;
    for (let i = 0; i < this._pointerSources.length; i++) {
      const p = this._pointerSources[i];
      if (!p.active) { slot = i; break; }
      if (p.released) {
        if (p.tRelease < oldestReleasedT) {
          oldestReleasedT = p.tRelease;
          bestReleased = i;
        }
      } else if (p.tRelease < oldestActiveT) {
        oldestActiveT = p.tRelease;
        bestActive = i;
      }
    }
    if (slot < 0) slot = bestReleased >= 0 ? bestReleased : bestActive;
    if (slot < 0) return;
    const p = this._pointerSources[slot];
    p.id = id;
    p.x = x;
    p.y = y;
    p.tPress = performance.now() / 1000;
    p.tRelease = 0;
    p.active = true;
    p.released = false;
    this._hasActivePointers = true;
  }

  // Pointer lifted: flip the slot to released mode so its fade timer
  // starts. Identified by the same `id` used at push time.
  releasePointerSource(id) {
    const now = performance.now() / 1000;
    for (const p of this._pointerSources) {
      if (p.active && !p.released && p.id === id) {
        p.released = true;
        p.tRelease = now;
        return;
      }
    }
  }

  // True while any pointer source has non-negligible fade remaining.
  // main.js folds this into `needsFrame` so swirls decay smoothly
  // after release. Short-circuits to false when smoke is off: in that
  // state `updateSources` doesn't run, so pointer slots never retire
  // and the flag would otherwise pin the RAF loop awake forever.
  get hasActivePointers() {
    return this.smokeEnabled && this._hasActivePointers;
  }

  // Populate `_sourceData` from the scene's elements + active pointer
  // sources. Zero-GC: reuses the pooled array and ring buffer.
  // Source order: pointers first (preserved under overflow), then
  // elements. Elongated elements get 2 or 3 along-axis sources so the
  // carved wake stretches along the shape's long direction.
  updateSources(scene) {
    const data = this._sourceData;
    data.fill(0);
    const now = performance.now() / 1000;
    let idx = 0;
    let anyActivePtr = false;

    // Pointer sources — isotropic swirl. Held pointers ramp in from 0
    // over PTR_RISE_SEC after touchdown (so the swirl lerps in instead
    // of popping), then stay at full strength for as long as the
    // finger is down. Released ones decay from their release time so
    // the swirl trails off when the finger lifts.
    const invRptr = 1 / PTR_RADIUS_BENCH;
    for (const p of this._pointerSources) {
      if (!p.active) continue;
      let fade;
      if (p.released) {
        fade = Math.exp(-(now - p.tRelease) / PTR_FADE_SEC);
        if (fade < 0.02) { p.active = false; p.released = false; continue; }
      } else {
        fade = 1.0 - Math.exp(-(now - p.tPress) / PTR_RISE_SEC);
      }
      anyActivePtr = true;
      if (idx >= MAX_SMOKE_SOURCES) continue;
      const o = idx * 8;
      data[o    ] = p.x;
      data[o + 1] = p.y;
      data[o + 2] = invRptr;
      data[o + 3] = invRptr;
      data[o + 4] = 1;                      // cosA = 1 (isotropic)
      data[o + 5] = 0;                      // sinA = 0
      data[o + 6] = 0;                      // pushK = 0
      data[o + 7] = K_PTR_STRENGTH * fade;  // swirlK = tangential CCW
      idx++;
    }
    this._hasActivePointers = anyActivePtr;

    // Element sources.
    for (const el of scene.elements) {
      if (idx >= MAX_SMOKE_SOURCES) break;
      // Local-space polygon bounds → unbiased by rotation.
      const poly = localPolygon(el);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of poly) {
        if (q.x < minX) minX = q.x;
        if (q.y < minY) minY = q.y;
        if (q.x > maxX) maxX = q.x;
        if (q.y > maxY) maxY = q.y;
      }
      const w = Math.max(1, maxX - minX);
      const h = Math.max(1, maxY - minY);
      const longLen = Math.max(w, h);
      const shortLen = Math.min(w, h);
      const ar = longLen / shortLen;
      // Always ≥ 2 sources so rotation visibly orbits them, even for
      // near-square shapes (AR < 1.5). A single centered source at the
      // element's centroid has no orientation and reads as "nothing
      // happened" when the element spins.
      const n = ar < 1.5 ? 2 : ar < 3 ? 2 : 3;
      const invRlong = 2 / longLen;
      const invRshort = 2 / shortLen;
      const pushK = K_ELEM_STRENGTH / Math.sqrt(n);
      // Spin generates swirl. Signed so CCW spin stirs CCW and CW stirs
      // CW; normalized by √N so splitting into more sources doesn't
      // amplify the total torque.
      const swirlK = (el.spin || 0) * K_SPIN_SWIRL / Math.sqrt(n);
      const rot = el.rot || 0;
      const cs = Math.cos(rot);
      const sn = Math.sin(rot);
      // Along-axis offsets in local space, scaling with aspect ratio:
      // near-square gets a modest spread, elongated gets sources spread
      // further along the long axis.
      const OFFS = ar < 1.5 ? [-1/5, 1/5]
                 : ar < 3   ? [-1/4, 1/4]
                 :            [-1/3, 0, 1/3];
      const longAlongX = w >= h;
      // In source-local frame, "long axis" is whichever direction has
      // the larger invR (smaller value since invR = 2/len). Set s0.zw
      // so the first component aligns with the long axis.
      const sInvX = longAlongX ? invRlong : invRshort;
      const sInvY = longAlongX ? invRshort : invRlong;
      for (const t of OFFS) {
        if (idx >= MAX_SMOKE_SOURCES) break;
        const offLocal = t * longLen;
        const dxLocal = longAlongX ? offLocal : 0;
        const dyLocal = longAlongX ? 0 : offLocal;
        // Rotate offset into world.
        const rx = dxLocal * cs - dyLocal * sn;
        const ry = dxLocal * sn + dyLocal * cs;
        const o = idx * 8;
        data[o    ] = el.x + rx;
        data[o + 1] = el.y + ry;
        data[o + 2] = sInvX;
        data[o + 3] = sInvY;
        data[o + 4] = cs;
        data[o + 5] = sn;
        data[o + 6] = pushK;
        data[o + 7] = swirlK;
        idx++;
      }
    }

    this._sourceCount = idx;
  }

  draw(scene, tracer) {
    const gl = this.gl;

    // --- Pass 0: smoke → smokeFbo (when enabled) ---
    // Renders the animated smoke into its own RGBA8 texture so the HDR
    // ray FBO stays "rays only". Density is written to alpha; blit and
    // elem shaders multiply rays by mix(0.5, 1.0, density) to simulate
    // particulate-lit rays.
    if (this.smokeEnabled) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.smokeFbo);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.BLEND);
      // Smoke is on — pack elements + pointer sources and upload.
      // When smoke is off we skip this work entirely (per design).
      this.updateSources(scene);
      gl.useProgram(this.smokeProgram);
      gl.uniform1f(this.smoke.uTime, performance.now() / 1000);
      gl.uniform2f(this.smoke.uAspect, scene.bench.w, scene.bench.h);
      gl.uniform1f(this.smoke.uIntensity, this.smokeIntensity);
      gl.uniform1f(this.smoke.uHue, this.smokeHue);
      gl.uniform1i(this.smoke.uSourceCount, this._sourceCount);
      // gl.uniform4fv uploads vec4s; total floats = MAX_SMOKE_SOURCES * 8
      // (= 2 vec4s per source × 4 floats per vec4). Unused slots are
      // zero-filled by updateSources() so stale data can't leak.
      gl.uniform4fv(this.smoke.uSources, this._sourceData);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
      gl.enableVertexAttribArray(this.smoke.aCorner);
      gl.vertexAttribPointer(this.smoke.aCorner, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(this.smoke.aCorner);
    }

    // --- Pass 1: rays → FBO ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.rayProgram);
    gl.uniform2f(this.ray.uBench, scene.bench.w, scene.bench.h);
    gl.uniform1f(this.ray.uWidth, this.rayWidth);
    // Segment buffer: use external GL buffer (GPU tracer) or upload
    // from CPU (CPU tracer). GPU buffer has a stride and byte offset
    // (segments are interleaved with ray state); CPU buffer is packed.
    let segBuf, segStride, segCount, segOffset;
    if (tracer.glSegmentBuffer) {
      segBuf = tracer.glSegmentBuffer;
      segStride = tracer.glSegmentStride;
      segCount = tracer.glSegmentCount;
      segOffset = tracer.glSegmentOffset || 0;
    } else {
      segBuf = this.segBuf;
      gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
      gl.bufferData(gl.ARRAY_BUFFER,
        tracer.segmentData.subarray(0, tracer.segmentCount * 12), gl.DYNAMIC_DRAW);
      segStride = 12 * 4;
      segCount = tracer.segmentCount;
      segOffset = 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
    gl.enableVertexAttribArray(this.ray.aSeg);
    gl.vertexAttribPointer(this.ray.aSeg, 4, gl.FLOAT, false, segStride, segOffset);
    gl.vertexAttribDivisor(this.ray.aSeg, 1);
    gl.enableVertexAttribArray(this.ray.aCol1);
    gl.vertexAttribPointer(this.ray.aCol1, 4, gl.FLOAT, false, segStride, segOffset + 4 * 4);
    gl.vertexAttribDivisor(this.ray.aCol1, 1);
    gl.enableVertexAttribArray(this.ray.aCol2);
    gl.vertexAttribPointer(this.ray.aCol2, 4, gl.FLOAT, false, segStride, segOffset + 8 * 4);
    gl.vertexAttribDivisor(this.ray.aCol2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rayCornerBuf);
    gl.enableVertexAttribArray(this.ray.aCorner);
    gl.vertexAttribPointer(this.ray.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(this.ray.aCorner, 0);
    if (segCount > 0) {
      // Cap instanced draw to prevent GPU timeout on complex scenes.
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.min(segCount, 500000));
    }
    gl.vertexAttribDivisor(this.ray.aSeg, 0);
    gl.vertexAttribDivisor(this.ray.aCol1, 0);
    gl.vertexAttribDivisor(this.ray.aCol2, 0);
    gl.disableVertexAttribArray(this.ray.aSeg);
    gl.disableVertexAttribArray(this.ray.aCol1);
    gl.disableVertexAttribArray(this.ray.aCol2);
    gl.disableVertexAttribArray(this.ray.aCorner);

    // --- Pass 1.5: two-pass Gaussian blur of rays → bloomTexB
    //     (only when smoke is enabled — otherwise nothing reads it).
    //     Half-resolution so the blur is smooth and cheap. HDR preserved
    //     end-to-end (RGBA16F) so bright pile-ups bloom in their true
    //     color instead of clipping to white before the Reinhard pass.
    if (this.smokeEnabled) {
      gl.disable(gl.BLEND);
      gl.useProgram(this.blurProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
      gl.enableVertexAttribArray(this.blur.aCorner);
      gl.vertexAttribPointer(this.blur.aCorner, 2, gl.FLOAT, false, 0, 0);

      const bw = this._bloomW, bh = this._bloomH;
      gl.uniform1f(this.blur.uSpread, this.bloomSpread);
      // Horizontal: fboTex (full res) → bloomTexA (half res).
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboA);
      gl.viewport(0, 0, bw, bh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.uniform1i(this.blur.uTex, 0);
      gl.uniform2f(this.blur.uTexel, 1.0 / this.canvas.width, 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // Vertical: bloomTexA → bloomTexB.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFboB);
      gl.viewport(0, 0, bw, bh);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomTexA);
      gl.uniform2f(this.blur.uTexel, 0.0, 1.0 / bh);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.disableVertexAttribArray(this.blur.aCorner);
    }

    // --- Pass 2a: blit FBO → screen ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(this.blitProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.uniform1i(this.blit.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.smokeTex);
    gl.uniform1i(this.blit.uSmoke, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomTexB);
    gl.uniform1i(this.blit.uBloom, 2);
    gl.uniform1i(this.blit.uUseSmoke, this.smokeEnabled ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
    gl.enableVertexAttribArray(this.blit.aCorner);
    gl.vertexAttribPointer(this.blit.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Pass 2b: element interiors (distortion sampling the FBO) ---
    // Tier 2+: skip SDF pass entirely (saves per-pixel polygon distance calc).
    if (this.qualityTier < 2) {
      gl.useProgram(this.elemProgram);
      gl.uniform2f(this.elem.uBench, scene.bench.w, scene.bench.h);
      gl.uniform1i(this.elem.uFbo, 0);
      gl.uniform1i(this.elem.uSmoke, 1);
      gl.uniform1i(this.elem.uBloom, 2);
      gl.uniform1i(this.elem.uUseSmoke, this.smokeEnabled ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuadBuf);
      gl.enableVertexAttribArray(this.elem.aCorner);
      gl.vertexAttribPointer(this.elem.aCorner, 2, gl.FLOAT, false, 0, 0);
      for (const el of scene.elements) {
        this.drawElement(el);
      }
    }
    gl.activeTexture(gl.TEXTURE0);

    // Hook for capturing the framebuffer before overlay ticks/lines.
    if (this.onPreOverlay) this.onPreOverlay();

    // --- Pass 3: overlay (alpha-blended lines) ---
    this.buildOverlay(scene, tracer);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.overlayProgram);
    gl.uniform2f(this.overlay.uBench, scene.bench.w, scene.bench.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.overlayBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
      this.overlayData.subarray(0, this.overlayCount * 6), gl.DYNAMIC_DRAW);
    const ovStride = 6 * 4;
    gl.enableVertexAttribArray(this.overlay.aPos);
    gl.vertexAttribPointer(this.overlay.aPos, 2, gl.FLOAT, false, ovStride, 0);
    gl.enableVertexAttribArray(this.overlay.aColor);
    gl.vertexAttribPointer(this.overlay.aColor, 4, gl.FLOAT, false, ovStride, 2 * 4);
    gl.drawArrays(gl.LINES, 0, this.overlayCount);
  }

  drawElement(el) {
    const gl = this.gl;
    const { polygon } = worldEdges(el);
    const n = Math.min(polygon.length, MAX_EDGES);
    const look = LOOK[el.material] || DEFAULT_LOOK;

    // Fill edge uniform buffer.
    const ed = this._edgeData;
    for (let i = 0; i < n; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      ed[i * 4    ] = a.x;
      ed[i * 4 + 1] = a.y;
      ed[i * 4 + 2] = b.x;
      ed[i * 4 + 3] = b.y;
    }
    // Zero out unused edges to keep the fragment loop a no-op past uEdgeCount.
    for (let i = n * 4; i < ed.length; i++) ed[i] = 0;

    // AABB of polygon, padded so the distortion reach stays inside the quad.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = Math.max(look.falloff, look.edgeWidth) + 4;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    gl.uniform1i(this.elem.uEdgeCount, n);
    gl.uniform4fv(this.elem.uEdges, ed);
    gl.uniform2f(this.elem.uAabbMin, minX, minY);
    gl.uniform2f(this.elem.uAabbMax, maxX, maxY);
    // Per-element color override takes precedence over the material's tint.
    // Overridden colors also get a much stronger mix so the body reads as
    // that color, not just as a faint sheen.
    let tint = look.tint, edgeGlow = look.edgeGlow;
    let tintStrength = look.tintStrength;
    if (el.color) {
      const rgb = hexToRgb(el.color);
      tint = rgb;
      edgeGlow = rgb;
      tintStrength = 0.45;
    }
    // Delay haze: elements with delayK get a stronger tint fill so
    // they look visibly "foggy" even when no particles are in flight.
    const matDelay = MATERIALS[el.material]?.delayK ?? 0;
    const elDelay = typeof el.delayK === 'number' ? el.delayK : matDelay;
    if (elDelay > 0) {
      tintStrength = Math.min(0.5, tintStrength + elDelay * 80);
    }
    // Song-player fade-in/fade-out: elements carry `_opacity` in [0, 1]
    // between keyframes. Scale the element-pass tint + glow so the
    // body fades rather than snapping in/out at keyframe boundaries.
    const opacity = typeof el._opacity === 'number' ? el._opacity : 1;
    gl.uniform3fv(this.elem.uTint, tint);
    gl.uniform1f(this.elem.uTintStrength, tintStrength * opacity);
    gl.uniform1f(this.elem.uMagnitude, (this.distortEnabled ? look.magnitude : 0) * opacity);
    gl.uniform1f(this.elem.uFalloff, look.falloff);
    gl.uniform3fv(this.elem.uEdgeGlow, edgeGlow);
    gl.uniform1f(this.elem.uEdgeGlowAmp, look.edgeGlowAmp * opacity);
    gl.uniform1f(this.elem.uEdgeWidth, look.edgeWidth);
    gl.uniform1f(this.elem.uOpaque, look.opaque ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  ensureOverlayCapacity(nVerts) {
    const needed = nVerts * 6;
    if (this.overlayData.length < needed) {
      this.overlayData = new Float32Array(Math.max(needed, this.overlayData.length * 2 || 2048));
    }
  }

  pushOverlayVertex(x, y, r, g, b, a) {
    const i = this.overlayCount * 6;
    this.overlayData[i] = x;
    this.overlayData[i + 1] = y;
    this.overlayData[i + 2] = r;
    this.overlayData[i + 3] = g;
    this.overlayData[i + 4] = b;
    this.overlayData[i + 5] = a;
    this.overlayCount++;
  }

  buildOverlay(scene, tracer) {
    this.overlayCount = 0;
    const binCount = tracer?.binCount ?? 64;
    // Per-sensor mini-spectrum is 64 bins × 6 stacked lines × 2 verts per line.
    let estimate = 8 + scene.emitter.count * 2 + scene.sensorCount * (2 + binCount * 6);
    for (const el of scene.elements) estimate += 100;
    this.ensureOverlayCapacity(estimate * 2);

    const { bench } = scene;
    this.rect(0, 0, bench.w, bench.h, 0.35, 0.4, 0.5, 0.6);

    const levels = scene.runtime.micLevels;
    const disabled = scene.emitter.disabled;
    const srcStripH = bench.h / scene.emitter.count;
    if (this.showTicks) {
      for (let s = 0; s < scene.emitter.count; s++) {
        const y = (scene.emitter.count - 1 - s + 0.5) * srcStripH;
        const off = disabled && disabled.has(s);
        const a = off ? 0.3 : 1.0;
        this.line(0, y, 14, y, 1, 1, 0.7, a);
        if (!off && levels && levels[s] > 0.02) {
          const v = Math.min(1, levels[s]);
          const len = 10 + v * 50;
          this.line(16, y, 16 + len, y, 1, 0.85, 0.4, 0.4 + 0.6 * v);
        }
      }
    }
    const senStripH = bench.h / scene.sensorCount;

    // Mini-spectrum is drawn directly on the right wall (overlapping the
    // sensor tick area) only when the right side-panel readout isn't on
    // screen — e.g. mobile drawer closed, or panel scrolled off.
    const rp = (typeof document !== 'undefined') ? document.getElementById('right-panel') : null;
    let showMini = false;
    if (rp) {
      const rr = rp.getBoundingClientRect();
      showMini = rr.width === 0 || rr.left >= window.innerWidth - 1;
    }

    // Sensor markers (mini-spectrum or plain tick) live behind the
    // single showTicks gate so the toggle hides everything on the
    // right wall in one shot.
    if (this.showTicks) {
      if (showMini && this.qualityTier < 1 && tracer && tracer.sensorBins && tracer.sensorCount === scene.sensorCount) {
        const stripW = Math.min(72, bench.w * 0.06);
        const stripH = Math.min(6, senStripH * 0.45);
        const x0 = bench.w - 2 - stripW;
        const binW = stripW / binCount;
        for (let s = 0; s < scene.sensorCount; s++) {
          const y = (scene.sensorCount - 1 - s + 0.5) * senStripH;
          let maxVal = 1e-6;
          for (let b = 0; b < binCount; b++) {
            const v = tracer.sensorBins[s * binCount + b];
            if (v > maxVal) maxVal = v;
          }
          for (let b = 0; b < binCount; b++) {
            const v = tracer.sensorBins[s * binCount + b] / maxVal;
            if (v < 0.02) continue;
            const wl = 380 + (b + 0.5) / binCount * 400;
            const rgb = wavelengthToRGB(wl);
            const r = rgb[0] * v, g = rgb[1] * v, bl = rgb[2] * v;
            const bx = x0 + b * binW;
            for (let dy = -stripH * 0.5; dy <= stripH * 0.5; dy += 1) {
              this.line(bx, y + dy, bx + binW + 0.5, y + dy, r, g, bl, 0.95);
            }
          }
        }
      } else {
        // Plain ticks when the side-panel readout is taking the role.
        for (let s = 0; s < scene.sensorCount; s++) {
          const y = (scene.sensorCount - 1 - s + 0.5) * senStripH;
          this.line(bench.w - 20, y, bench.w - 2, y, 0.6, 1, 0.9, 0.9);
        }
      }
    }

    for (const el of scene.elements) {
      const { polygon } = worldEdges(el);
      const col = elementOutlineColor(el);
      // Fade outline alpha with song-player fade-in/fade-out opacity.
      const elOpacity = typeof el._opacity === 'number' ? el._opacity : 1;
      this.polyOutline(polygon, col[0], col[1], col[2], col[3] * elOpacity);
      if (el._selected) {
        this._selectedForLabel = el;
        // Center dot (small diamond).
        const cx = el.x, cy = el.y, d = 4;
        this.line(cx - d, cy, cx, cy - d, 1, 1, 1, 0.8);
        this.line(cx, cy - d, cx + d, cy, 1, 1, 1, 0.8);
        this.line(cx + d, cy, cx, cy + d, 1, 1, 1, 0.8);
        this.line(cx, cy + d, cx - d, cy, 1, 1, 1, 0.8);
        // Rotation indicator: line from center in the rotation direction.
        const rot = el.rot || 0;
        const len = 20;
        const rx = cx + Math.cos(rot) * len;
        const ry = cy + Math.sin(rot) * len;
        this.line(cx, cy, rx, ry, 1, 0.8, 0.3, 0.9);
        // Small arc showing rotation angle, normalized to (-π, π].
        const arcR = 14;
        const steps = 8;
        let arcAngle = rot % (2 * Math.PI);
        if (arcAngle > Math.PI) arcAngle -= 2 * Math.PI;
        if (arcAngle < -Math.PI) arcAngle += 2 * Math.PI;
        const startA = 0;
        const endA = arcAngle;
        for (let i = 0; i < steps; i++) {
          const a1 = startA + (endA - startA) * (i / steps);
          const a2 = startA + (endA - startA) * ((i + 1) / steps);
          this.line(
            cx + Math.cos(a1) * arcR, cy + Math.sin(a1) * arcR,
            cx + Math.cos(a2) * arcR, cy + Math.sin(a2) * arcR,
            1, 0.8, 0.3, 0.6);
        }
      }
    }

    // Position the rotation label over the selected element.
    const rotLabel = document.getElementById('rotation-label');
    if (rotLabel) {
      const sel = this._selectedForLabel;
      this._selectedForLabel = null;
      if (sel) {
        const deg = ((sel.rot || 0) * 180 / Math.PI) % 360;
        // Anchor to the canvas rect (in viewport pixels) and convert to
        // the label's offsetParent-local coords. This stays correct
        // regardless of letterbox size or which ancestor happens to be
        // the positioning context.
        const cRect = this.canvas.getBoundingClientRect();
        const parent = rotLabel.offsetParent;
        const pRect = parent
          ? parent.getBoundingClientRect()
          : { left: 0, top: 0 };
        const sx = cRect.width / scene.bench.w;
        const sy = cRect.height / scene.bench.h;
        const rot = sel.rot || 0;
        const R = 26; // bench-units, past the 20-unit indicator tip
        const lx = sel.x + Math.cos(rot) * R;
        const ly = sel.y + Math.sin(rot) * R;
        rotLabel.textContent = `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`;
        rotLabel.style.left = ((cRect.left - pRect.left) + lx * sx) + 'px';
        rotLabel.style.top  = ((cRect.top  - pRect.top ) + ly * sy - 6) + 'px';
        rotLabel.hidden = false;
      } else {
        rotLabel.hidden = true;
      }
    }
  }

  line(x1, y1, x2, y2, r, g, b, a) {
    this.pushOverlayVertex(x1, y1, r, g, b, a);
    this.pushOverlayVertex(x2, y2, r, g, b, a);
  }
  rect(x, y, w, h, r, g, b, a) {
    this.line(x, y, x + w, y, r, g, b, a);
    this.line(x + w, y, x + w, y + h, r, g, b, a);
    this.line(x + w, y + h, x, y + h, r, g, b, a);
    this.line(x, y + h, x, y, r, g, b, a);
  }
  polyOutline(poly, r, g, b, a) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      this.line(p.x, p.y, q.x, q.y, r, g, b, a);
    }
  }

  // --- Sensor readout (right panel canvas bars) ---

  resetReadout() {
    this._displayBins = new Float32Array(0);
    this._peakMax = 1e-6;
    this._readoutImg = null;
    this._readoutCtx = null;
  }

  updateReadout(scene, tracer) {
    const host = document.getElementById('sensor-readout');
    if (!host) return;
    const CANVAS_W = 128;
    const sensorCount = scene.sensorCount;
    if (sensorCount <= 0) return;
    // Size rows to the actual panel height so extreme downscaling can't
    // hide sensor rows behind separator lines. Cap at 14 (the previous
    // fixed value) so tall panels don't allocate unreasonably large
    // ImageData. Minimum 1 row per sensor.
    const panelH = Math.max(sensorCount, host.clientHeight | 0);
    const ROW_H = Math.max(1, Math.min(14, (panelH / sensorCount) | 0));
    const wantH = sensorCount * ROW_H;
    let c = host.firstElementChild;
    // Rebuild if missing, wrong type, or size changed (sensor count or panel size).
    if (!c || c.tagName !== 'CANVAS' || c.height !== wantH || c.width !== CANVAS_W) {
      host.innerHTML = '';
      c = document.createElement('canvas');
      c.id = 'sensor-readout-canvas';
      c.width = CANVAS_W; c.height = wantH;
      host.appendChild(c);
      this._readoutImg = null; // force reallocation
      return;                  // draw next frame
    }
    if (!tracer.sensorBins) return;
    const binCount = tracer.binCount;
    const totalBins = sensorCount * binCount;

    if (this._displayBins.length !== totalBins) {
      this._displayBins = new Float32Array(totalBins);
      this._peakMax = 1e-6;
    }
    if (this._blurBuf.length < binCount) this._blurBuf = new Float32Array(binCount);
    // One Uint8ClampedArray for the entire stack. Reallocated only on
    // canvas-size change (sensor count or ROW_H).
    if (!this._readoutImg || this._readoutImg.width !== CANVAS_W || this._readoutImg.height !== wantH) {
      const ctx = c.getContext('2d');
      this._readoutImg = ctx.createImageData(CANVAS_W, wantH);
      this._readoutCtx = ctx;
    }
    // Per-bin wavelength → RGB lookup, only depends on binCount. Cache
    // and reuse across all sensors each frame.
    if (!this._readoutWlRgb || this._readoutWlRgb.length !== binCount * 3) {
      this._readoutWlRgb = new Float32Array(binCount * 3);
    }
    if (this._readoutWlRgbBins !== binCount) {
      const wlMin = 380, wlMax = 780;
      for (let b = 0; b < binCount; b++) {
        const wl = wlMin + (b + 0.5) / binCount * (wlMax - wlMin);
        const rgb = wavelengthToRGB(wl);
        this._readoutWlRgb[b * 3    ] = rgb[0];
        this._readoutWlRgb[b * 3 + 1] = rgb[1];
        this._readoutWlRgb[b * 3 + 2] = rgb[2];
      }
      this._readoutWlRgbBins = binCount;
    }

    // Temporal IIR: displayBins lerps toward sensorBins.
    const IIR = 0.3;
    const displayBins = this._displayBins;
    const rawBins = tracer.sensorBins;
    for (let i = 0; i < totalBins; i++) {
      displayBins[i] += (rawBins[i] - displayBins[i]) * IIR;
    }

    // Slow-decaying peak normalization.
    let curMax = 1e-6;
    for (let i = 0; i < totalBins; i++) {
      if (displayBins[i] > curMax) curMax = displayBins[i];
    }
    this._peakMax = Math.max(curMax, this._peakMax * 0.95);
    const invPeak = 1 / this._peakMax;

    const data = this._readoutImg.data;
    const blur = this._blurBuf;
    const wlRgb = this._readoutWlRgb;
    // Border color between sensor rows (matches old .sensor-bar border-top: var(--border) = #242a33).
    const borderR = 0x24, borderG = 0x2a, borderB = 0x33;

    for (let s = 0; s < sensorCount; s++) {
      // Flip: row 0 (top of canvas) = sensor N-1 (top of bench).
      const si = sensorCount - 1 - s;
      const rowStartY = s * ROW_H;

      // Gaussian blur across bins: [0.25, 0.5, 0.25] kernel.
      const base = si * binCount;
      for (let b = 0; b < binCount; b++) {
        const prev = b > 0 ? displayBins[base + b - 1] : displayBins[base + b];
        const cur  = displayBins[base + b];
        const next = b < binCount - 1 ? displayBins[base + b + 1] : cur;
        blur[b] = prev * 0.25 + cur * 0.5 + next * 0.25;
      }

      // Build one row of RGBA bytes for this sensor (128 px wide), then
      // copy it down for the full ROW_H. Color per pixel = bin's
      // wavelength color scaled by blur[b] / peak (black if zero).
      const rowOff = rowStartY * CANVAS_W * 4;
      const scale = CANVAS_W / binCount;
      for (let x = 0; x < CANVAS_W; x++) {
        const b = Math.min(binCount - 1, (x / scale) | 0);
        const v = blur[b] * invPeak;
        const a = v <= 0 ? 0 : (v >= 1 ? 1 : v);
        const r = (wlRgb[b * 3    ] * a * 255) | 0;
        const g = (wlRgb[b * 3 + 1] * a * 255) | 0;
        const bl = (wlRgb[b * 3 + 2] * a * 255) | 0;
        const o = rowOff + x * 4;
        data[o    ] = r;
        data[o + 1] = g;
        data[o + 2] = bl;
        data[o + 3] = 255;
      }
      // Copy the built row down to the remaining ROW_H-1 pixel rows.
      const rowBytes = CANVAS_W * 4;
      for (let y = 1; y < ROW_H; y++) {
        const dstOff = rowOff + y * rowBytes;
        data.copyWithin(dstOff, rowOff, rowOff + rowBytes);
      }
      // Separator line at the top of each sensor block (except the
      // first). Only when ROW_H >= 15 — at smaller sizes the 1-px line
      // consumes an outsized fraction of each row (≥ 17%) and the
      // divider grid fights the spectrum for attention instead of
      // separating it. Below that, color boundaries between adjacent
      // sensor rows do the separating.
      if (s > 0 && ROW_H >= 15) {
        for (let x = 0; x < CANVAS_W; x++) {
          const o = rowOff + x * 4;
          data[o] = borderR; data[o + 1] = borderG; data[o + 2] = borderB; data[o + 3] = 255;
        }
      }
    }

    this._readoutCtx.putImageData(this._readoutImg, 0, 0);
  }
}

// Overlay outline color per material. Interior colors are now handled by the
// element pass; this is just a faint edge stroke for selection feedback.
function elementOutlineColor(el) {
  switch (el.material) {
    case 'mirror':       return [0.85, 0.85, 1.0, 0.9];
    case 'mirror-red':   return [1.0, 0.4, 0.4, 0.9];
    case 'mirror-green': return [0.4, 1.0, 0.5, 0.9];
    case 'mirror-blue':  return [0.4, 0.5, 1.0, 0.9];
    case 'flint':        return [1.0, 0.7, 0.8, 0.6];
    case 'crown':        return [0.6, 0.9, 1.0, 0.6];
    case 'fused':        return [0.8, 1.0, 0.9, 0.6];
    case 'water':        return [0.6, 0.8, 1.0, 0.6];
    case 'diamond':      return [1.0, 1.0, 0.8, 0.7];
    case 'hyper':        return [1.0, 0.5, 1.0, 0.7];
    case 'slowGlass':    return [0.7, 0.6, 1.0, 0.7];
    default:             return [1, 1, 1, 0.6];
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

function buildProgram(gl, vs, fs) {
  const v = buildShader(gl, gl.VERTEX_SHADER, vs);
  const f = buildShader(gl, gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
  return p;
}
function buildShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
  return s;
}
