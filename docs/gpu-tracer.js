// GPU ray tracer via WebGL2 transform feedback.
//
// Each input vertex represents a (ray, bounce) pair. The vertex shader
// traces the ray forward to that bounce and outputs the segment. Transform
// feedback captures segments directly into a buffer the renderer can bind
// as vertex data — zero CPU→GPU segment upload.
//
// Sensor accumulation: rays that hit the sensor wall are rendered as points
// to a binCount×sensorCount R32F FBO with additive blending, then read back
// via readPixels (~6 KB) for the audio path.
//
// Limitations vs CPU tracer:
//   - No delay/particle simulation (stays on CPU; main.js auto-switches)
//   - Fixed-size inside-element stack (max 4 deep; silent overflow)
//   - No secondary rays
//   - No initial containment check (elements overlapping emitter wall)
//
// The GLSL implements the same physics as castRay in raytracer.js:
// Snell refraction, TIR, Beer-Lambert absorption, wavelength-to-RGB.
//
// TODO: Known performance wins (not correctness blockers):
//   - Ping-pong bounce loop: trace one bounce per dispatch instead of
//     re-tracing the full prefix per vertex. ~16× trace cost reduction.
//     Requires two ray-state buffers and one TF pass per bounce.
//   - Spatial partition for edges: uniform 32×32 grid stored as a texture.
//     Reduces edge intersection from O(edges) to O(~4) per bounce.
//   - MAX_STACK overflow detection: currently silently drops nested
//     dielectrics beyond depth 4. Could discard the ray or fall back.
//   - Initial containment check: CPU tracer tests pointInPolygon at ray
//     origin to seed the inside-stack. GPU tracer skips this, causing
//     physics divergence for elements overlapping the left wall.

import { wavelengthToRGB, materialN, materialAbsorption, mirrorReflectance,
         elementAbsorption, elementReflectance, elementDelay, MATERIALS } from './spectrum.js';
import { worldEdges, materialOptics } from './scene.js';

const MAX_BOUNCES = 32;
const MAX_EDGES = 512;
const MAX_ELEMENTS = 64;
const SEG_FLOATS = 12;
const TF_FLOATS_PER_VERTEX = 16; // 12 segment + 4 meta (v_p + v_c1 + v_c2 + v_meta)
const ELEMENT_TEX_ROWS = 6;
const EPS = 1e-4;

// ── Vertex shader: traces one ray to bounce B, outputs that segment ──
const VS = `#version 300 es
precision highp float;

// Per-vertex input: which ray and which bounce
in float a_rayIndex;   // source * raysPerSource + k
in float a_bounceIndex;

// Edge data: packed as RGBA32F texture. Each texel = one edge.
// Row 0: (p1.x, p1.y, p2.x, p2.y)  — endpoints
// Row 1: (nx, ny, elementIdx, 0)    — outward normal + element index
uniform sampler2D u_edges;
uniform int u_edgeCount;

// Element data: packed as RGBA32F texture. Each texel = one element.
// Row 0: (type, n_A, n_B, 0)  — type: 0=dielectric, 1=mirror; Cauchy A,B
// Row 1: (absBase, absPeak, absCenter, absSigma)
// Row 2: (reflBase, reflPeak, reflCenter, reflSigma)
// Row 3: (delayK, colorR, colorG, colorB)
// Row 4: (hasSellmeier, s0, s1, s2) — first 3 Sellmeier coeffs
// Row 5: (s3, s4, s5, 0) — remaining Sellmeier coeffs
uniform sampler2D u_elements;
uniform int u_elementCount;

// Emitter setup
uniform float u_benchW;
uniform float u_benchH;
uniform int u_sourceCount;
uniform int u_raysPerSource;
uniform float u_wlMin;
uniform float u_wlMax;
uniform float u_apertureFactor;
uniform float u_spreadRad;
uniform float u_baseIntensity;

// Mic levels: 1D texture, one value per source
uniform sampler2D u_micLevels;

// Sensor setup
uniform int u_sensorCount;
uniform float u_sensorStripH;

// Transform feedback outputs: one segment
out vec4 v_p;       // p1.x, p1.y, p2.x, p2.y
out vec4 v_c1;      // r*I, g*I, b*I, I  at p1
out vec4 v_c2;      // r*I, g*I, b*I, I  at p2
out vec4 v_meta;    // wavelength, hitSensorWall, 0, 0

// Constants
const float PHI = 0.6180339887498949;
const float PSI = 0.7548776662466927;
const float PI = 3.141592653589793;
const float GLASS_LOSS = 0.998;
const int MAX_STACK = 4;

// ── Helpers ──

vec4 edgeEndpoints(int i) {
  return texelFetch(u_edges, ivec2(i, 0), 0);
}
vec3 edgeNormalAndEl(int i) {
  return texelFetch(u_edges, ivec2(i, 1), 0).xyz;
}
vec4 elRow(int i, int row) {
  return texelFetch(u_elements, ivec2(i, row), 0);
}

// Ray-segment intersection. Returns t > EPS or -1.
float raySeg(vec2 o, vec2 d, vec2 a, vec2 b) {
  vec2 s = b - a;
  float denom = d.x * s.y - d.y * s.x;
  if (abs(denom) < 1e-9) return -1.0;
  vec2 e = a - o;
  float t = (e.x * s.y - e.y * s.x) / denom;
  float u = (e.x * d.y - e.y * d.x) / denom;
  if (t <= ${EPS.toExponential()} || u < 0.0 || u > 1.0) return -1.0;
  return t;
}

// Wavelength to RGB (same piecewise as spectrum.js)
vec3 wlToRGB(float wl) {
  float r = 0.0, g = 0.0, b = 0.0;
  if (wl >= 380.0 && wl < 440.0) { r = -(wl - 440.0) / 60.0; b = 1.0; }
  else if (wl < 490.0) { g = (wl - 440.0) / 50.0; b = 1.0; }
  else if (wl < 510.0) { g = 1.0; b = -(wl - 510.0) / 20.0; }
  else if (wl < 580.0) { r = (wl - 510.0) / 70.0; g = 1.0; }
  else if (wl < 645.0) { r = 1.0; g = -(wl - 645.0) / 65.0; }
  else if (wl <= 780.0) { r = 1.0; }
  float f = 1.0;
  if (wl < 420.0) f = 0.3 + 0.7 * (wl - 380.0) / 40.0;
  else if (wl > 700.0) f = 0.3 + 0.7 * (780.0 - wl) / 80.0;
  return pow(vec3(r, g, b) * f, vec3(0.8));
}

// Cauchy or Sellmeier refractive index
float matN(int elIdx, float wl) {
  vec4 r0 = elRow(elIdx, 0);
  vec4 r4 = elRow(elIdx, 4);
  if (r4.x > 0.5) {
    // Sellmeier
    float um = wl / 1000.0;
    float um2 = um * um;
    float n2 = 1.0;
    vec4 r5 = elRow(elIdx, 5);
    float coeffs[6] = float[6](r4.y, r4.z, r4.w, r5.x, r5.y, r5.z);
    for (int i = 0; i < 6; i += 2) {
      float B = coeffs[i], C = coeffs[i+1];
      n2 += B * um2 / (um2 - C);
    }
    return sqrt(max(1.0, n2));
  }
  // Cauchy
  float um = wl / 1000.0;
  return r0.y + r0.z / (um * um);
}

// Material absorption coefficient
float matAbsorption(int elIdx, float wl) {
  vec4 r1 = elRow(elIdx, 1);
  float base = r1.x;
  if (r1.y <= 0.0) return base;
  float d = (wl - r1.z) / r1.w;
  return base + r1.y * exp(-d * d);
}

// Mirror reflectance
float matReflectance(int elIdx, float wl) {
  vec4 r2 = elRow(elIdx, 2);
  float base = r2.x;
  if (r2.y <= 0.0) return base;
  float d = (wl - r2.z) / r2.w;
  return min(1.0, base + r2.y * exp(-d * d));
}

void main() {
  int rayIdx = int(a_rayIndex);
  int targetBounce = int(a_bounceIndex);
  int srcIdx = rayIdx / u_raysPerSource;
  int k = rayIdx - srcIdx * u_raysPerSource;

  // Default: degenerate segment (zero length, zero intensity)
  v_p = vec4(0.0);
  v_c1 = vec4(0.0);
  v_c2 = vec4(0.0);
  v_meta = vec4(0.0);
  gl_Position = vec4(0.0);

  if (srcIdx >= u_sourceCount) return;

  // Mic gain for this source
  float micGain = texelFetch(u_micLevels, ivec2(srcIdx, 0), 0).r;
  float intensity = (u_baseIntensity / sqrt(float(u_raysPerSource))) * micGain;
  if (intensity < 1e-6) return;

  // Emitter position
  float srcStripH = u_benchH / float(u_sourceCount);
  float ey0 = float(u_sourceCount - 1 - srcIdx) * srcStripH;
  float apertureH = srcStripH * u_apertureFactor;
  float yT = fract(float(k + 1) * PHI);
  float aT = fract(float(k + 1) * PSI);
  float ey = ey0 + (srcStripH - apertureH) * 0.5 + yT * apertureH;
  float wlRange = max(1.0, u_wlMax - u_wlMin);
  float wl = u_wlMin + wlRange * (float(k) + 0.5) / float(u_raysPerSource);
  vec3 rgb = wlToRGB(wl);
  float angle = (aT - 0.5) * u_spreadRad;
  vec2 pos = vec2(4.0, ey);
  vec2 dir = vec2(cos(angle), sin(angle));
  float I = intensity;

  // Inside-element stack (fixed size)
  int stack[MAX_STACK];
  int stackLen = 0;

  // Check initial containment
  // (Simplified: skip initial containment check for GPU version.
  //  This only matters for elements overlapping the left wall.)

  // Walls
  vec2 w0a = vec2(0.0, 0.0), w0b = vec2(u_benchW, 0.0);
  vec2 w1a = vec2(u_benchW, 0.0), w1b = vec2(u_benchW, u_benchH);
  vec2 w2a = vec2(u_benchW, u_benchH), w2b = vec2(0.0, u_benchH);
  vec2 w3a = vec2(0.0, u_benchH), w3b = vec2(0.0, 0.0);

  // Trace bounces 0..targetBounce
  for (int bounce = 0; bounce <= targetBounce; bounce++) {
    float tBest = 1e30;
    int hitEdgeIdx = -1;
    int hitWallKind = -1; // -1=none, 0=top, 1=sensor, 2=bottom, 3=emitter

    // Test element edges
    for (int i = 0; i < u_edgeCount; i++) {
      vec4 ep = edgeEndpoints(i);
      float t = raySeg(pos, dir, ep.xy, ep.zw);
      if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = i; hitWallKind = -1; }
    }

    // Test walls
    float t;
    t = raySeg(pos, dir, w0a, w0b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 0; }
    t = raySeg(pos, dir, w1a, w1b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 1; }
    t = raySeg(pos, dir, w2a, w2b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 2; }
    t = raySeg(pos, dir, w3a, w3b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 3; }

    if (tBest >= 1e29) {
      // No hit — emit escape segment on target bounce
      if (bounce == targetBounce) {
        vec2 p2 = pos + dir * 1000.0;
        v_p = vec4(pos, p2);
        v_c1 = vec4(rgb * I, I);
        v_c2 = vec4(rgb * I, I);
        v_meta = vec4(wl, 0.0, 0.0, 0.0);
      }
      return;
    }

    vec2 hit = pos + dir * tBest;

    // Beer-Lambert absorption inside current medium
    float Iend = I;
    float d = length(hit - pos);
    if (stackLen > 0) {
      int insideIdx = stack[stackLen - 1];
      float alpha = matAbsorption(insideIdx, wl);
      if (alpha > 0.0) Iend = I * exp(-alpha * d);
    }

    // Emit this segment if it's the target bounce
    if (bounce == targetBounce) {
      v_p = vec4(pos, hit);
      v_c1 = vec4(rgb * I, I);
      v_c2 = vec4(rgb * Iend, Iend);
      v_meta = vec4(wl, hitWallKind == 1 ? 1.0 : 0.0, 0.0, 0.0);
      return;
    }

    I = Iend;

    // Wall hit: ray terminates — all subsequent bounces produce degenerate segments
    if (hitWallKind >= 0) return;

    // Element hit: refract or reflect
    vec3 edgeInfo = edgeNormalAndEl(hitEdgeIdx);
    vec2 n = edgeInfo.xy;
    int elIdx = int(edgeInfo.z);
    vec4 elType = elRow(elIdx, 0);
    float type = elType.x;
    vec4 elDelay = elRow(elIdx, 3);
    float delayK = elDelay.x;

    // Skip delay elements (captured by CPU tracer)
    if (type < 0.5 && delayK > 0.0003) return;

    if (type > 0.5) {
      // Mirror
      float vdotn = dot(dir, n);
      dir = dir - 2.0 * vdotn * n;
      I *= matReflectance(elIdx, wl);
    } else {
      // Dielectric — Snell's law
      float nGlass = matN(elIdx, wl);
      float vdotn_out = dot(dir, n);
      bool entering = vdotn_out < 0.0;
      float n1, n2;
      vec2 sn;
      if (entering) {
        n1 = stackLen > 0 ? matN(stack[stackLen-1], wl) : 1.0;
        n2 = nGlass;
        sn = n;
      } else {
        // Pop from stack
        for (int j = stackLen - 1; j >= 0; j--) {
          if (stack[j] == elIdx) {
            for (int m = j; m < stackLen - 1; m++) stack[m] = stack[m+1];
            stackLen--;
            break;
          }
        }
        n1 = nGlass;
        n2 = stackLen > 0 ? matN(stack[stackLen-1], wl) : 1.0;
        sn = -n;
      }
      float eta = n1 / n2;
      float cosI = -dot(dir, sn);
      float sin2T = eta * eta * (1.0 - cosI * cosI);
      if (sin2T > 1.0) {
        // TIR
        float vd = dot(dir, -sn);
        dir = dir - 2.0 * vd * (-sn);
        if (!entering && stackLen < MAX_STACK) {
          // Re-push popped element
          stack[stackLen] = elIdx;
          stackLen++;
        }
      } else {
        float cosT = sqrt(1.0 - sin2T);
        dir = eta * dir + (eta * cosI - cosT) * sn;
        if (entering && stackLen < MAX_STACK) {
          stack[stackLen] = elIdx;
          stackLen++;
        }
      }
      dir = normalize(dir);
      I *= GLASS_LOSS;
    }

    pos = hit + dir * ${(EPS * 10).toExponential()};
    if (I < 0.002) return;
  }
}
`;

const FS = `#version 300 es
precision highp float;
void main() { discard; }
`;

// ── Sensor accumulation shaders ──
// Reads directly from the TF buffer (16-float stride). Each vertex
// is one (ray, bounce) record. The VS checks v_meta.y (sensor hit
// flag); non-hits are placed off-screen. Hits are rendered as 1×1
// points at the correct (bin, sensor) position in the FBO. Additive
// blending accumulates intensity.
const SENSOR_VS = `#version 300 es
precision highp float;
// TF buffer layout: v_p(4) + v_c1(4) + v_c2(4) + v_meta(4)
in vec4 a_p;      // p1.x, p1.y, p2.x, p2.y
in vec4 a_c1;     // unused here
in vec4 a_c2;     // r*I2, g*I2, b*I2, I2
in vec4 a_meta;   // wavelength, isSensor, 0, 0

uniform float u_benchH;
uniform int u_sensorCount;
uniform int u_binCount;

flat out float v_intensity;

void main() {
  float isSensor = a_meta.y;
  float I2 = a_c2.w;
  // Discard non-sensor-hits and zero-intensity segments.
  if (isSensor < 0.5 || I2 < 1e-6) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0); // off-screen
    gl_PointSize = 1.0;
    v_intensity = 0.0;
    return;
  }
  float hy = a_p.w; // p2.y
  float wl = a_meta.x;
  float stripH = u_benchH / float(u_sensorCount);
  int sIdx = int(u_sensorCount) - 1 - int(floor(hy / stripH));
  sIdx = clamp(sIdx, 0, int(u_sensorCount) - 1);
  int bIdx = int(floor((wl - 380.0) / (780.0 - 380.0) * float(u_binCount)));
  bIdx = clamp(bIdx, 0, int(u_binCount) - 1);
  float x = (float(bIdx) + 0.5) / float(u_binCount) * 2.0 - 1.0;
  float y = (float(sIdx) + 0.5) / float(u_sensorCount) * 2.0 - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
  gl_PointSize = 1.0;
  v_intensity = I2;
}
`;

const SENSOR_FS = `#version 300 es
precision highp float;
flat in float v_intensity;
out vec4 fragColor;
void main() {
  fragColor = vec4(v_intensity, 0.0, 0.0, 0.0);
}
`;

export class GPUTracer {
  constructor(gl) {
    this.gl = gl;
    this._program = null;
    this._sensorProgram = null;
    this._tfBuffer = null;
    this._inputBuffer = null;
    this._edgeTex = null;
    this._elementTex = null;
    this._micTex = null;
    this._ready = false;
    this._debugReadback = false; // set true for gpu-test.html

    // Output compatible with CPU tracer
    this.segmentData = new Float32Array(0);
    this.segmentCount = 0;
    this.sensorBins = null;
    this.sensorCount = 0;
    this.binCount = 64;

    // Dirty tracking — skip texture re-upload when scene unchanged.
    this._sceneGeneration = -1;
    this._lastMicLevels = null;
    this._edgeTexReady = false;
    this._elementTexReady = false;
    this._micTexReady = false;

    // Uniform locations (cached after first use).
    this._uloc = null;

    this._init();
  }

  _init() {
    const gl = this.gl;

    // Required for additive blending on R32F FBO (sensor pass).
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_float_blend');

    // Compile trace program with transform feedback
    const vs = this._compile(gl.VERTEX_SHADER, VS);
    const fs = this._compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.transformFeedbackVaryings(prog, ['v_p', 'v_c1', 'v_c2', 'v_meta'], gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('GPU tracer link:', gl.getProgramInfoLog(prog));
      return;
    }
    this._program = prog;

    // Cache uniform locations.
    const u = name => gl.getUniformLocation(prog, name);
    this._uloc = {
      benchW: u('u_benchW'), benchH: u('u_benchH'),
      sourceCount: u('u_sourceCount'), raysPerSource: u('u_raysPerSource'),
      wlMin: u('u_wlMin'), wlMax: u('u_wlMax'),
      apertureFactor: u('u_apertureFactor'), spreadRad: u('u_spreadRad'),
      baseIntensity: u('u_baseIntensity'),
      edgeCount: u('u_edgeCount'), elementCount: u('u_elementCount'),
      sensorCount: u('u_sensorCount'), sensorStripH: u('u_sensorStripH'),
      edges: u('u_edges'), elements: u('u_elements'), micLevels: u('u_micLevels'),
    };

    // Compile sensor program.
    const svs = this._compile(gl.VERTEX_SHADER, SENSOR_VS);
    const sfs = this._compile(gl.FRAGMENT_SHADER, SENSOR_FS);
    if (svs && sfs) {
      const sp = gl.createProgram();
      gl.attachShader(sp, svs);
      gl.attachShader(sp, sfs);
      gl.linkProgram(sp);
      if (gl.getProgramParameter(sp, gl.LINK_STATUS)) {
        this._sensorProgram = sp;
        this._sensorLoc = {
          aP: gl.getAttribLocation(sp, 'a_p'),
          aC1: gl.getAttribLocation(sp, 'a_c1'),
          aC2: gl.getAttribLocation(sp, 'a_c2'),
          aMeta: gl.getAttribLocation(sp, 'a_meta'),
          benchH: gl.getUniformLocation(sp, 'u_benchH'),
          sensorCount: gl.getUniformLocation(sp, 'u_sensorCount'),
          binCount: gl.getUniformLocation(sp, 'u_binCount'),
        };
      }
    }

    // Sensor FBO: R32F texture, binCount × sensorCount.
    // Created/resized lazily in trace() when dimensions change.
    this._sensorFBO = null;
    this._sensorTex = null;
    this._sensorFBOWidth = 0;
    this._sensorFBOHeight = 0;

    // Allocate textures at max size with texStorage2D (never reallocated).
    // Zero-initialize to avoid lazy-init warnings on partial subImage updates.
    this._edgeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._edgeTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, MAX_EDGES, 2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_EDGES, 2, gl.RGBA, gl.FLOAT,
      new Float32Array(MAX_EDGES * 2 * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._elementTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._elementTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, MAX_ELEMENTS, ELEMENT_TEX_ROWS);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_ELEMENTS, ELEMENT_TEX_ROWS, gl.RGBA, gl.FLOAT,
      new Float32Array(MAX_ELEMENTS * ELEMENT_TEX_ROWS * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._micTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._micTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, 64, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.FLOAT, new Float32Array(64));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Transform feedback object
    this._tf = gl.createTransformFeedback();

    // Validate R32F additive blending: some ANGLE/Intel drivers
    // silently clamp or quantize. Render a known value, read it back,
    // check within epsilon. If it fails, sensor accumulation falls
    // back to CPU.
    this._sensorFBOValid = this._validateR32FBlend();

    this._ready = true;
  }

  _validateR32FBlend() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
      console.warn('GPU tracer: R32F FBO not supported, sensor accumulation will use CPU');
      return false;
    }
    // Clear to 0, then additively blend two known values.
    gl.viewport(0, 0, 1, 1);
    gl.clearColor(0.25, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Read back the clear value.
    const result = new Float32Array(1);
    gl.readPixels(0, 0, 1, 1, gl.RED, gl.FLOAT, result);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
    const ok = Math.abs(result[0] - 0.25) < 0.01;
    if (!ok) {
      console.warn(`GPU tracer: R32F precision check failed (wrote 0.25, read ${result[0]}), sensor accumulation will use CPU`);
    }
    return ok;
  }

  _compile(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('GPU tracer shader:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  // Upload element edges via texSubImage2D (texture pre-allocated at max size).
  _uploadEdges(edges) {
    const gl = this.gl;
    const n = edges.length;
    if (n === 0) return;
    // Pack into two rows: row 0 = endpoints, row 1 = normal + element index.
    // Row stride is MAX_EDGES (texture width), not n.
    if (!this._edgeData || this._edgeData.length < n * 4) {
      this._edgeData = new Float32Array(Math.max(n, 1) * 4);
    }
    const d = this._edgeData;
    // Row 0
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      d[i*4] = e.p1.x; d[i*4+1] = e.p1.y; d[i*4+2] = e.p2.x; d[i*4+3] = e.p2.y;
    }
    gl.bindTexture(gl.TEXTURE_2D, this._edgeTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RGBA, gl.FLOAT, d.subarray(0, n*4));
    // Row 1
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      d[i*4] = e.nx; d[i*4+1] = e.ny; d[i*4+2] = e._gpuElIdx ?? 0; d[i*4+3] = 0;
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, n, 1, gl.RGBA, gl.FLOAT, d.subarray(0, n*4));
  }

  // Upload element material properties via texSubImage2D.
  _uploadElements(elementInfos) {
    const gl = this.gl;
    const n = elementInfos.length;
    if (n === 0) return;
    // Each element is one column, ELEMENT_TEX_ROWS rows. Upload row by row
    // to avoid building a full-width × rows buffer.
    if (!this._elRowData || this._elRowData.length < n * 4) {
      this._elRowData = new Float32Array(Math.max(n, 1) * 4);
    }
    const d = this._elRowData;
    gl.bindTexture(gl.TEXTURE_2D, this._elementTex);
    for (let row = 0; row < ELEMENT_TEX_ROWS; row++) {
      for (let i = 0; i < n; i++) {
        const info = elementInfos[i];
        const mat = info.mat;
        const el = info.el;
        const off = i * 4;
        if (row === 0) {
          d[off] = mat?.type === 'mirror' ? 1 : 0;
          d[off+1] = mat?.A ?? 1; d[off+2] = mat?.B ?? 0; d[off+3] = 0;
        } else if (row === 1) {
          const a = mat?.absorb ?? {};
          d[off] = a.base ?? 0; d[off+1] = a.peak ?? 0;
          d[off+2] = a.center ?? 0; d[off+3] = a.sigma ?? 1;
        } else if (row === 2) {
          const r = mat?.reflect ?? {};
          d[off] = r.base ?? 0.98; d[off+1] = r.peak ?? 0;
          d[off+2] = r.center ?? 0; d[off+3] = r.sigma ?? 1;
        } else if (row === 3) {
          const c = el.color ? (() => {
            const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(el.color || '');
            return m ? [parseInt(m[1],16)/255, parseInt(m[2],16)/255, parseInt(m[3],16)/255] : [1,1,1];
          })() : [0,0,0];
          d[off] = info.delayK; d[off+1] = c[0]; d[off+2] = c[1]; d[off+3] = c[2];
        } else if (row === 4) {
          const s = mat?.sellmeier;
          d[off] = s ? 1 : 0; d[off+1] = s?s[0]:0; d[off+2] = s?s[1]:0; d[off+3] = s?s[2]:0;
        } else {
          const s = mat?.sellmeier;
          d[off] = s&&s[3]?s[3]:0; d[off+1] = s&&s[4]?s[4]:0; d[off+2] = s&&s[5]?s[5]:0; d[off+3] = 0;
        }
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, n, 1, gl.RGBA, gl.FLOAT, d.subarray(0, n*4));
    }
  }

  trace(scene) {
    if (!this._ready) return;
    const gl = this.gl;
    const { bench, emitter, sensorCount, elements, runtime } = scene;
    const nSrc = emitter.count;
    const raysPer = emitter.raysPerSource;
    const totalRays = nSrc * raysPer;
    const totalVertices = totalRays * MAX_BOUNCES;
    // Rebuild edges/elements every frame (elements may have moved/
    // rotated). The texSubImage2D upload is cheap — no allocation,
    // reuses pre-sized typed arrays.
    const edges = [];
    const elementInfos = [];
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const { edges: eEdges, polygon } = worldEdges(el);
      const mat = materialOptics(el.material);
      const dK = elementDelay(el, mat);
      elementInfos.push({ el, polygon, mat, delayK: dK, _gpuIdx: i });
      for (const e of eEdges) { e._gpuElIdx = i; edges.push(e); }
    }
    this._uploadEdges(edges);
    this._uploadElements(elementInfos);
    this._cachedEdgeCount = edges.length;
    this._cachedElementCount = elementInfos.length;

    // Mic levels: always upload (tiny — nSrc floats).
    if (!this._micData || this._micData.length < nSrc) {
      this._micData = new Float32Array(Math.max(nSrc, 1));
    }
    if (runtime.micLevels) {
      for (let i = 0; i < nSrc; i++) this._micData[i] = runtime.micLevels[i] ?? 1;
    } else {
      this._micData.fill(1);
    }
    gl.bindTexture(gl.TEXTURE_2D, this._micTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(nSrc, 64), 1, gl.RED, gl.FLOAT,
      this._micData.subarray(0, Math.min(nSrc, 64)));

    // Input vertex buffer: rebuild only when totalVertices changes.
    if (!this._inputBuffer || this._inputVertexCount !== totalVertices) {
      const inputData = new Float32Array(totalVertices * 2);
      for (let r = 0; r < totalRays; r++) {
        for (let b = 0; b < MAX_BOUNCES; b++) {
          const idx = (r * MAX_BOUNCES + b) * 2;
          inputData[idx] = r;
          inputData[idx + 1] = b;
        }
      }
      if (this._inputBuffer) gl.deleteBuffer(this._inputBuffer);
      this._inputBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._inputBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, inputData, gl.STATIC_DRAW);
      this._inputVertexCount = totalVertices;
    }

    // TF buffer: resize only when totalVertices changes.
    const tfBytes = totalVertices * TF_FLOATS_PER_VERTEX * 4;
    if (!this._tfBuffer || this._tfBytes !== tfBytes) {
      if (this._tfBuffer) gl.deleteBuffer(this._tfBuffer);
      this._tfBuffer = gl.createBuffer();
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, this._tfBuffer);
      gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, tfBytes, gl.DYNAMIC_READ);
      this._tfBytes = tfBytes;
    }

    // VAO setup.
    if (!this._vao) this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._inputBuffer);
    const aRay = gl.getAttribLocation(this._program, 'a_rayIndex');
    const aBounce = gl.getAttribLocation(this._program, 'a_bounceIndex');
    gl.enableVertexAttribArray(aRay);
    gl.vertexAttribPointer(aRay, 1, gl.FLOAT, false, 8, 0);
    gl.enableVertexAttribArray(aBounce);
    gl.vertexAttribPointer(aBounce, 1, gl.FLOAT, false, 8, 4);

    // Uniforms (cached locations).
    const loc = this._uloc;
    gl.useProgram(this._program);
    gl.uniform1f(loc.benchW, bench.w);
    gl.uniform1f(loc.benchH, bench.h);
    gl.uniform1i(loc.sourceCount, nSrc);
    gl.uniform1i(loc.raysPerSource, raysPer);
    gl.uniform1f(loc.wlMin, emitter.wlMin);
    gl.uniform1f(loc.wlMax, emitter.wlMax);
    gl.uniform1f(loc.apertureFactor, emitter.apertureFactor ?? 0.01);
    gl.uniform1f(loc.spreadRad, (emitter.spreadDeg ?? 0) * Math.PI / 180);
    gl.uniform1f(loc.baseIntensity, 1.6);
    gl.uniform1i(loc.edgeCount, this._cachedEdgeCount ?? 0);
    gl.uniform1i(loc.elementCount, this._cachedElementCount ?? 0);
    gl.uniform1i(loc.sensorCount, sensorCount);
    gl.uniform1f(loc.sensorStripH, bench.h / sensorCount);

    // Textures.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._edgeTex);
    gl.uniform1i(loc.edges, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._elementTex);
    gl.uniform1i(loc.elements, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._micTex);
    gl.uniform1i(loc.micLevels, 2);

    // --- Transform feedback ---
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._tfBuffer);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, totalVertices);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindVertexArray(null);

    // Expose TF buffer for direct rendering (zero-copy).
    this.glSegmentBuffer = this._tfBuffer;
    this.glSegmentStride = TF_FLOATS_PER_VERTEX * 4;
    this.glSegmentCount = totalVertices;

    // --- Sensor accumulation ---
    this.sensorCount = sensorCount;
    const binLen = sensorCount * this.binCount;
    if (!this.sensorBins || this.sensorBins.length !== binLen) {
      this.sensorBins = new Float32Array(binLen);
    }

    if (this._sensorProgram && this._sensorFBOValid) {
      // GPU path: render sensor hits into R32F FBO with additive blending,
      // then readPixels the tiny result (~6 KB).
      const fbW = this.binCount;
      const fbH = sensorCount;

      // Create/resize FBO if needed.
      if (!this._sensorFBO || this._sensorFBOWidth !== fbW || this._sensorFBOHeight !== fbH) {
        if (this._sensorFBO) { gl.deleteFramebuffer(this._sensorFBO); gl.deleteTexture(this._sensorTex); }
        this._sensorTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._sensorTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, fbW, fbH, 0, gl.RED, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this._sensorFBO = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._sensorFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._sensorTex, 0);
        this._sensorFBOWidth = fbW;
        this._sensorFBOHeight = fbH;
      }

      // Save GL state that the sensor pass modifies.
      const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const prevViewport = gl.getParameter(gl.VIEWPORT);
      const prevBlend = gl.isEnabled(gl.BLEND);
      const prevBlendSrc = gl.getParameter(gl.BLEND_SRC_RGB);
      const prevBlendDst = gl.getParameter(gl.BLEND_DST_RGB);
      const prevClearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE);
      const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE);

      // Render sensor hits.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._sensorFBO);
      gl.viewport(0, 0, fbW, fbH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive

      gl.useProgram(this._sensorProgram);
      gl.uniform1f(this._sensorLoc.benchH, bench.h);
      gl.uniform1i(this._sensorLoc.sensorCount, sensorCount);
      gl.uniform1i(this._sensorLoc.binCount, this.binCount);

      // Bind TF buffer as vertex input with 16-float stride.
      const stride = TF_FLOATS_PER_VERTEX * 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, this._tfBuffer);
      const sLoc = this._sensorLoc;
      const sensorAttribs = [
        [sLoc.aP, 4, 0], [sLoc.aC1, 4, 16],
        [sLoc.aC2, 4, 32], [sLoc.aMeta, 4, 48],
      ];
      for (const [loc, size, offset] of sensorAttribs) {
        if (loc < 0) continue;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      }

      gl.drawArrays(gl.POINTS, 0, totalVertices);

      for (const [loc] of sensorAttribs) {
        if (loc >= 0) gl.disableVertexAttribArray(loc);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      // Read back the tiny FBO.
      gl.readPixels(0, 0, fbW, fbH, gl.RED, gl.FLOAT, this.sensorBins);

      // Restore GL state.
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
      gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      gl.clearColor(prevClearColor[0], prevClearColor[1], prevClearColor[2], prevClearColor[3]);
      if (prevBlend) { gl.enable(gl.BLEND); gl.blendFunc(prevBlendSrc, prevBlendDst); }
      else gl.disable(gl.BLEND);
      gl.activeTexture(prevActiveTex);
    } else {
      // CPU fallback: read TF buffer and accumulate sensor bins on CPU.
      // Used when R32F blending validation failed.
      gl.bindBuffer(gl.COPY_READ_BUFFER, this._tfBuffer);
      const rb = new Float32Array(totalVertices * TF_FLOATS_PER_VERTEX);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, rb);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      this.sensorBins.fill(0);
      const sensorStripH = bench.h / sensorCount;
      for (let i = 0; i < totalVertices; i++) {
        const off = i * TF_FLOATS_PER_VERTEX;
        const I2 = rb[off + 11];
        const isSensor = rb[off + 13];
        if (isSensor > 0.5 && I2 > 1e-6) {
          const hy = rb[off + 3];
          const sIdx = Math.min(sensorCount - 1, Math.max(0,
            sensorCount - 1 - Math.floor(hy / sensorStripH)));
          const wl = rb[off + 12];
          const binIdx = Math.min(this.binCount - 1, Math.max(0,
            Math.floor((wl - 380) / (780 - 380) * this.binCount)));
          this.sensorBins[sIdx * this.binCount + binIdx] += I2;
        }
      }
    }

    // --- Debug: CPU segment copy for gpu-test.html ---
    if (this._debugReadback) {
      // Use COPY_READ_BUFFER to avoid conflict with ARRAY_BUFFER bindings.
      gl.bindBuffer(gl.COPY_READ_BUFFER, this._tfBuffer);
      const rb = new Float32Array(totalVertices * TF_FLOATS_PER_VERTEX);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, rb);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      let segCount = 0;
      for (let i = 0; i < totalVertices; i++) {
        const off = i * TF_FLOATS_PER_VERTEX;
        if (rb[off + 7] > 1e-6 || rb[off + 11] > 1e-6) segCount++;
      }
      if (this.segmentData.length < segCount * SEG_FLOATS) {
        this.segmentData = new Float32Array(segCount * SEG_FLOATS);
      }
      let si = 0;
      for (let i = 0; i < totalVertices; i++) {
        const off = i * TF_FLOATS_PER_VERTEX;
        if (rb[off + 7] < 1e-6 && rb[off + 11] < 1e-6) continue;
        for (let f = 0; f < SEG_FLOATS; f++) {
          this.segmentData[si * SEG_FLOATS + f] = rb[off + f];
        }
        si++;
      }
      this.segmentCount = segCount;
    }
  }

  // Stubs: no particle simulation on GPU
  activeParticleCount() { return 0; }
  resetPersistence() {}
  get simRate() { return 1; }
  set simRate(_) {}
}
