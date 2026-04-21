// GPU ray tracer via WebGL2 transform feedback (ping-pong bounces).
//
// Instead of one vertex per (ray, bounce) pair that re-traces the full
// prefix, this runs one TF dispatch per bounce with totalRays vertices.
// Each dispatch reads the previous bounce's ray state and advances one
// step. Total work: totalRays × actualBounces (not × B²/2).
//
// Buffer layout: single large INTERLEAVED buffer with one region per
// bounce, each region = totalRays × 24 floats (8 ray state + 16 segment).
// The renderer draws all non-degenerate segments from the buffer.
//
// Sensor accumulation: additive-blend R32F FBO + readPixels (~6 KB).
//
// Limitations vs CPU tracer:
//   - No delay/particle simulation (stays on CPU; main.js auto-switches)
//   - Fixed-size inside-element stack (max 4 deep; silent overflow)
//   - No secondary rays
//   - No initial containment check (elements overlapping emitter wall)
//
// TODO: Known performance wins (not correctness blockers):
//   - Spatial partition for edges: uniform 32×32 grid as texture.
//   - MAX_STACK overflow detection.
//   - Early termination: skip remaining bounce passes when all rays dead
//     (requires alive-count readback or occlusion query).

import { wavelengthToRGB, materialN, materialAbsorption, mirrorReflectance,
         elementAbsorption, elementReflectance, elementDelay, MATERIALS } from './spectrum.js';
import { worldEdges, materialOptics } from './scene.js';

const MAX_BOUNCES = 32;
const MAX_EDGES = 512;
const MAX_ELEMENTS = 64;
const SEG_FLOATS = 12;
const ELEMENT_TEX_ROWS = 6;
const EPS = 1e-4;

// Per-vertex output: 6 vec4s = 24 floats, INTERLEAVED.
// [0-3]   v_rayPosDir  — ray state: posX, posY, dirX, dirY
// [4-7]   v_rayState   — ray state: I, wl, alive, packedStack
//         packedStack encodes a depth-3 inside-element stack as:
//         stackLen*262144 + stack[0]*4096 + stack[1]*64 + stack[2]
//         (element indices 0-63, exact in fp32 integer range)
// [8-11]  v_segP       — segment: p1x, p1y, p2x, p2y
// [12-15] v_segC1      — segment: r*I1, g*I1, b*I1, I1
// [16-19] v_segC2      — segment: r*I2, g*I2, b*I2, I2
// [20-23] v_segMeta    — segment: wl, isSensor, 0, 0
const PP_FLOATS = 24;
const PP_BYTES = PP_FLOATS * 4; // 96
// Byte offsets within a PP record for segment fields:
const SEG_P_OFF = 32;     // v_segP: bytes 32-47 (floats 8-11)
const SEG_C1_OFF = 48;    // v_segC1: bytes 48-63 (floats 12-15)
const SEG_C2_OFF = 64;    // v_segC2: bytes 64-79 (floats 16-19)
const SEG_META_OFF = 80;  // v_segMeta: bytes 80-95 (floats 20-23)

// ── Bounce vertex shader ──
// Handles both emission (u_bounce==0, uses gl_VertexID) and bouncing
// (u_bounce>0, reads ray state from input attributes).
const PP_VS = `#version 300 es
precision highp float;

// Ray state from previous bounce (only used when u_bounce > 0).
in vec4 a_rayPosDir;  // posX, posY, dirX, dirY
in vec4 a_rayState;   // I, wl, alive, packedStack

uniform int u_bounce;

// Edge/element textures (same as before)
uniform sampler2D u_edges;
uniform int u_edgeCount;
uniform sampler2D u_elements;
uniform int u_elementCount;

// Emitter setup (used only at bounce 0)
uniform float u_benchW;
uniform float u_benchH;
uniform int u_sourceCount;
uniform int u_raysPerSource;
uniform float u_wlMin;
uniform float u_wlMax;
uniform float u_apertureFactor;
uniform float u_spreadRad;
uniform float u_baseIntensity;
uniform sampler2D u_micLevels;
uniform sampler2D u_wlPerSource;
uniform int u_hasWlPer;

// TF outputs: ray state + segment (6 vec4 = 24 floats INTERLEAVED)
out vec4 v_rayPosDir;
out vec4 v_rayState;
out vec4 v_segP;
out vec4 v_segC1;
out vec4 v_segC2;
out vec4 v_segMeta;

const float PHI = 0.6180339887498949;
const float PSI = 0.7548776662466927;
const float GLASS_LOSS = 0.998;

vec4 edgeRow0(int i) { return texelFetch(u_edges, ivec2(i, 0), 0); }
vec4 edgeRow1(int i) { return texelFetch(u_edges, ivec2(i, 1), 0); }
vec4 elRow(int i, int row) { return texelFetch(u_elements, ivec2(i, row), 0); }

// Inside-element stack: packed into one float as an integer.
// stackLen*262144 + stack[0]*4096 + stack[1]*64 + stack[2]
// Supports depth 0-3 with element indices 0-63.
// Slots beyond stkLen are garbage but never read (stkLen gates access).
const int MAX_STACK = 3;
int stk[3];  // unpacked stack
int stkLen;  // unpacked length

void unpackStack(float packed) {
  int p = int(packed);
  stkLen = p / 262144;
  stk[0] = (p / 4096) % 64;
  stk[1] = (p / 64) % 64;
  stk[2] = p % 64;
}
float packStack() {
  return float(stkLen * 262144 + stk[0] * 4096 + stk[1] * 64 + stk[2]);
}
void stkPush(int elIdx) {
  if (stkLen < MAX_STACK) {
    stk[stkLen] = elIdx;
    stkLen++;
  }
}
bool stkPop(int elIdx) {
  // Remove elIdx from stack (may not be on top due to overlapping elements)
  for (int j = stkLen - 1; j >= 0; j--) {
    if (stk[j] == elIdx) {
      for (int m = j; m < stkLen - 1; m++) stk[m] = stk[m+1];
      stkLen--;
      return true;
    }
  }
  return false;
}
int stkTop() {
  return stkLen > 0 ? stk[stkLen - 1] : -1;
}

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

bool angleInRange(float a, float a0, float span) {
  float da = mod(a - a0, 6.2831853);
  return da <= span + 1e-4;
}

float rayArc(vec2 o, vec2 d, vec2 c, float R, float a0, float a1) {
  vec2 oc = o - c;
  float A = dot(d, d);
  float B = dot(oc, d);
  float C = dot(oc, oc) - R * R;
  float disc = B * B - A * C;
  if (disc < 0.0) return -1.0;
  float sq = sqrt(disc);
  float invA = 1.0 / A;
  float span = mod(a1 - a0, 6.2831853);
  if (span <= 0.0) span += 6.2831853;
  float t1 = (-B - sq) * invA;
  float t2 = (-B + sq) * invA;
  if (t1 > ${EPS.toExponential()}) {
    vec2 hp = o + d * t1;
    float ang = atan(hp.y - c.y, hp.x - c.x);
    if (angleInRange(ang, a0, span)) return t1;
  }
  if (t2 > ${EPS.toExponential()}) {
    vec2 hp = o + d * t2;
    float ang = atan(hp.y - c.y, hp.x - c.x);
    if (angleInRange(ang, a0, span)) return t2;
  }
  return -1.0;
}

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

float matN(int elIdx, float wl) {
  vec4 r0 = elRow(elIdx, 0);
  vec4 r4 = elRow(elIdx, 4);
  if (r4.x > 0.5) {
    float um = wl / 1000.0, um2 = um * um, n2 = 1.0;
    vec4 r5 = elRow(elIdx, 5);
    float c[6] = float[6](r4.y, r4.z, r4.w, r5.x, r5.y, r5.z);
    for (int i = 0; i < 6; i += 2) n2 += c[i] * um2 / (um2 - c[i+1]);
    return sqrt(max(1.0, n2));
  }
  float um = wl / 1000.0;
  return r0.y + r0.z / (um * um);
}

// Color transmission: how strongly an RGB color filter transmits
// wavelength wl. T = dot(color, wlRGB) / sum(wlRGB). Matches the
// CPU's colorTransmission() in spectrum.js.
float colorTrans(vec3 color, float wl) {
  vec3 w = wlToRGB(wl);
  float total = w.r + w.g + w.b + 1e-6;
  return clamp(dot(color, w) / total, 0.01, 1.0);
}

float matAbsorption(int elIdx, float wl) {
  // Absorption multiplier from row 0.w (el.absorb, default 1).
  float absorbMul = elRow(elIdx, 0).w;
  // Check for element color override (row 3, yzw = RGB, 0 if no color).
  vec4 r3 = elRow(elIdx, 3);
  vec3 elColor = r3.yzw;
  if (elColor.r + elColor.g + elColor.b > 0.01) {
    float trans = colorTrans(elColor, wl);
    return (-log(trans) / 80.0) * absorbMul; // D_REF = 80
  }
  vec4 r1 = elRow(elIdx, 1);
  float alpha;
  if (r1.y <= 0.0) alpha = r1.x;
  else { float d = (wl - r1.z) / r1.w; alpha = r1.x + r1.y * exp(-d * d); }
  return alpha * absorbMul;
}

float matReflectance(int elIdx, float wl) {
  // Check for element color override.
  vec4 r3 = elRow(elIdx, 3);
  vec3 elColor = r3.yzw;
  if (elColor.r + elColor.g + elColor.b > 0.01) {
    float trans = colorTrans(elColor, wl);
    return 0.02 + 0.93 * trans;
  }
  vec4 r2 = elRow(elIdx, 2);
  if (r2.y <= 0.0) return r2.x;
  float d = (wl - r2.z) / r2.w;
  return min(1.0, r2.x + r2.y * exp(-d * d));
}

void main() {
  // Defaults: dead ray, degenerate segment.
  v_rayPosDir = vec4(0.0);
  v_rayState = vec4(0.0);
  v_segP = vec4(0.0);
  v_segC1 = vec4(0.0);
  v_segC2 = vec4(0.0);
  v_segMeta = vec4(0.0);
  gl_Position = vec4(0.0);

  vec2 pos, dir;
  float I, wl;
  stkLen = 0; stk[0] = 0; stk[1] = 0; stk[2] = 0;

  if (u_bounce == 0) {
    // --- Emission: compute ray from gl_VertexID ---
    int rayIdx = gl_VertexID;
    int srcIdx = rayIdx / u_raysPerSource;
    int k = rayIdx - srcIdx * u_raysPerSource;
    if (srcIdx >= u_sourceCount) {
      v_rayState = vec4(0.0, 0.0, 0.0, 0.0); // alive=0, packedStack=0 (empty)
      return;
    }
    float micGain = texelFetch(u_micLevels, ivec2(srcIdx, 0), 0).r;
    I = (u_baseIntensity / sqrt(float(u_raysPerSource))) * micGain;
    if (I < 1e-6) {
      v_rayState = vec4(0.0, 0.0, 0.0, 0.0); // alive=0, packedStack=0 (empty)
      return;
    }
    float srcStripH = u_benchH / float(u_sourceCount);
    float ey0 = float(u_sourceCount - 1 - srcIdx) * srcStripH;
    float apertureH = srcStripH * u_apertureFactor;
    float yT = fract(float(k + 1) * PHI);
    float aT = fract(float(k + 1) * PSI);
    float ey = ey0 + (srcStripH - apertureH) * 0.5 + yT * apertureH;
    float srcWlMin = u_wlMin;
    float srcWlMax = u_wlMax;
    if (u_hasWlPer > 0) {
      srcWlMin = texelFetch(u_wlPerSource, ivec2(srcIdx, 0), 0).r;
      srcWlMax = texelFetch(u_wlPerSource, ivec2(srcIdx, 1), 0).r;
    }
    float wlRange = max(1.0, srcWlMax - srcWlMin);
    wl = srcWlMin + wlRange * (float(k) + 0.5) / float(u_raysPerSource);
    float angle = (aT - 0.5) * u_spreadRad;
    pos = vec2(4.0, ey);
    dir = vec2(cos(angle), sin(angle));
  } else {
    // --- Bounce: read ray state from previous pass ---
    pos = a_rayPosDir.xy;
    dir = a_rayPosDir.zw;
    I = a_rayState.x;
    wl = a_rayState.y;
    float alive = a_rayState.z;
    unpackStack(a_rayState.w);
    if (alive < 0.5) {
      v_rayState = a_rayState; // pass through dead state
      return;
    }
  }

  // --- One bounce ---
  vec2 w0a = vec2(0.0, 0.0), w0b = vec2(u_benchW, 0.0);
  vec2 w1a = vec2(u_benchW, 0.0), w1b = vec2(u_benchW, u_benchH);
  vec2 w2a = vec2(u_benchW, u_benchH), w2b = vec2(0.0, u_benchH);
  vec2 w3a = vec2(0.0, u_benchH), w3b = vec2(0.0, 0.0);

  float tBest = 1e30;
  int hitEdgeIdx = -1;
  int hitWallKind = -1;

  for (int i = 0; i < u_edgeCount; i++) {
    vec4 r0 = edgeRow0(i);
    vec4 r1 = edgeRow1(i);
    float edgeType = r1.w;
    float t;
    if (edgeType > 0.5) {
      // Arc: r0 = (cx, cy, R, convex), r1 = (a0, a1, elIdx, 1.0)
      t = rayArc(pos, dir, r0.xy, r0.z, r1.x, r1.y);
    } else {
      // Segment: r0 = (p1.x, p1.y, p2.x, p2.y)
      t = raySeg(pos, dir, r0.xy, r0.zw);
    }
    if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = i; hitWallKind = -1; }
  }
  float t;
  t = raySeg(pos, dir, w0a, w0b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 0; }
  t = raySeg(pos, dir, w1a, w1b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 1; }
  t = raySeg(pos, dir, w2a, w2b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 2; }
  t = raySeg(pos, dir, w3a, w3b); if (t > 0.0 && t < tBest) { tBest = t; hitEdgeIdx = -1; hitWallKind = 3; }

  vec3 rgb = wlToRGB(wl);

  if (tBest >= 1e29) {
    // No hit — escape segment, kill ray
    vec2 p2 = pos + dir * 1000.0;
    v_segP = vec4(pos, p2);
    v_segC1 = vec4(rgb * I, I);
    v_segC2 = vec4(rgb * I, I);
    v_segMeta = vec4(wl, 0.0, 0.0, 0.0);
    v_rayPosDir = vec4(p2, dir);
    v_rayState = vec4(0.0, wl, 0.0, 0.0); // dead
    return;
  }

  vec2 hit = pos + dir * tBest;

  // Beer-Lambert absorption
  float Iend = I;
  float dist = length(hit - pos);
  int topEl = stkTop();
  if (topEl >= 0) {
    float alpha = matAbsorption(topEl, wl);
    if (alpha > 0.0) Iend = I * exp(-alpha * dist);
  }

  // Emit segment
  v_segP = vec4(pos, hit);
  v_segC1 = vec4(rgb * I, I);
  v_segC2 = vec4(rgb * Iend, Iend);
  v_segMeta = vec4(wl, hitWallKind == 1 ? 1.0 : 0.0, 0.0, 0.0);

  I = Iend;

  // Wall hit: ray terminates
  if (hitWallKind >= 0) {
    v_rayPosDir = vec4(hit, dir);
    v_rayState = vec4(0.0, wl, 0.0, 0.0); // dead
    return;
  }

  // Element hit: refract or reflect.
  // Read both edge rows for normal + element index.
  vec4 hitR0 = edgeRow0(hitEdgeIdx);
  vec4 hitR1 = edgeRow1(hitEdgeIdx);
  float hitEdgeType = hitR1.w;
  vec2 n;
  int elIdx;
  if (hitEdgeType > 0.5) {
    // Arc: normal = normalize(hit - center), flip if concave.
    n = normalize(hit - hitR0.xy);
    if (hitR0.w < 0.5) n = -n;  // concave
    elIdx = int(hitR1.z);
  } else {
    n = hitR1.xy;
    elIdx = int(hitR1.z);
  }
  vec4 elType = elRow(elIdx, 0);
  float type = elType.x;
  vec4 elDelay = elRow(elIdx, 3);
  float delayK = elDelay.x;

  if (type < 0.5 && delayK > 0.0003) {
    // Delay element — kill (CPU handles particles)
    v_rayPosDir = vec4(hit, dir);
    v_rayState = vec4(0.0, wl, 0.0, -1.0);
    return;
  }

  if (type > 0.5) {
    // Mirror
    float vdotn = dot(dir, n);
    dir = dir - 2.0 * vdotn * n;
    I *= matReflectance(elIdx, wl);
  } else {
    // Dielectric — Snell's law with depth-3 inside-element stack.
    float nGlass = matN(elIdx, wl);
    float vdotn_out = dot(dir, n);
    bool entering = vdotn_out < 0.0;
    float n1, n2;
    vec2 sn;
    bool popped = false;
    if (entering) {
      n1 = stkTop() >= 0 ? matN(stkTop(), wl) : 1.0;
      n2 = nGlass;
      sn = n;
    } else {
      popped = stkPop(elIdx);
      n1 = nGlass;
      n2 = stkTop() >= 0 ? matN(stkTop(), wl) : 1.0;
      sn = -n;
    }
    float eta = n1 / n2;
    float cosI = -dot(dir, sn);
    float sin2T = eta * eta * (1.0 - cosI * cosI);
    if (sin2T > 1.0) {
      // TIR — reflect and re-push if we popped
      float vd = dot(dir, -sn);
      dir = dir - 2.0 * vd * (-sn);
      if (!entering && popped) stkPush(elIdx);
    } else {
      float cosT = sqrt(1.0 - sin2T);
      dir = eta * dir + (eta * cosI - cosT) * sn;
      if (entering) stkPush(elIdx);
    }
    dir = normalize(dir);
    I *= GLASS_LOSS;
  }

  vec2 newPos = hit + dir * ${(EPS * 10).toExponential()};
  float alive = I < 0.002 ? 0.0 : 1.0;

  v_rayPosDir = vec4(newPos, dir);
  v_rayState = vec4(I, wl, alive, packStack());
}
`;

const PP_FS = `#version 300 es
precision highp float;
void main() { discard; }
`;

// ── Sensor accumulation shaders (same as before) ──
const SENSOR_VS = `#version 300 es
precision highp float;
in vec4 a_p;
in vec4 a_c2;
in vec4 a_meta;
uniform float u_benchH;
uniform int u_sensorCount;
uniform int u_binCount;
flat out float v_intensity;
void main() {
  float isSensor = a_meta.y;
  float I2 = a_c2.w;
  if (isSensor < 0.5 || I2 < 1e-6) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 1.0;
    v_intensity = 0.0;
    return;
  }
  float hy = a_p.w;
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
void main() { fragColor = vec4(v_intensity, 0.0, 0.0, 0.0); }
`;

// Postconditions of trace():
//   - FBO unbound (null).
//   - Blend disabled after sensor pass.
//   - Viewport, program, VAO, active texture left dirty.
//   - Caller (renderer.draw) must set its own GL state before drawing.
//   - glSegmentBuffer / glSegmentStride / glSegmentOffset / glSegmentCount
//     expose the segment buffer for zero-copy renderer binding.
export class GPUTracer {
  constructor(gl) {
    this.gl = gl;
    this._program = null;
    this._sensorProgram = null;
    this._ready = false;
    this._debugReadback = false;

    // Output compatible with CPU tracer
    this.segmentData = new Float32Array(0);
    this.segmentCount = 0;
    this.sensorBins = null;
    this.sensorCount = 0;
    this.binCount = 64;

    this._uloc = null;
    this._sensorFBO = null;
    this._sensorTex = null;
    this._sensorFBOWidth = 0;
    this._sensorFBOHeight = 0;
    this._sensorFBOValid = false;

    this._init();
  }

  _init() {
    const gl = this.gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_float_blend');

    // Compile ping-pong trace program
    const vs = this._compile(gl.VERTEX_SHADER, PP_VS);
    const fs = this._compile(gl.FRAGMENT_SHADER, PP_FS);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.transformFeedbackVaryings(prog,
      ['v_rayPosDir', 'v_rayState', 'v_segP', 'v_segC1', 'v_segC2', 'v_segMeta'],
      gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('GPU tracer link:', gl.getProgramInfoLog(prog));
      return;
    }
    this._program = prog;

    const u = name => gl.getUniformLocation(prog, name);
    this._uloc = {
      bounce: u('u_bounce'),
      benchW: u('u_benchW'), benchH: u('u_benchH'),
      sourceCount: u('u_sourceCount'), raysPerSource: u('u_raysPerSource'),
      wlMin: u('u_wlMin'), wlMax: u('u_wlMax'),
      apertureFactor: u('u_apertureFactor'), spreadRad: u('u_spreadRad'),
      baseIntensity: u('u_baseIntensity'),
      edgeCount: u('u_edgeCount'), elementCount: u('u_elementCount'),
      edges: u('u_edges'), elements: u('u_elements'), micLevels: u('u_micLevels'),
      wlPerSource: u('u_wlPerSource'), hasWlPer: u('u_hasWlPer'),
    };
    this._aRayPosDir = gl.getAttribLocation(prog, 'a_rayPosDir');
    this._aRayState = gl.getAttribLocation(prog, 'a_rayState');

    // Sensor program
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
          aC2: gl.getAttribLocation(sp, 'a_c2'),
          aMeta: gl.getAttribLocation(sp, 'a_meta'),
          benchH: gl.getUniformLocation(sp, 'u_benchH'),
          sensorCount: gl.getUniformLocation(sp, 'u_sensorCount'),
          binCount: gl.getUniformLocation(sp, 'u_binCount'),
        };
      }
    }

    // Textures at max size
    this._edgeTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._edgeTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, MAX_EDGES, 2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_EDGES, 2, gl.RGBA, gl.FLOAT, new Float32Array(MAX_EDGES * 2 * 4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this._elementTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._elementTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, MAX_ELEMENTS, ELEMENT_TEX_ROWS);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_ELEMENTS, ELEMENT_TEX_ROWS, gl.RGBA, gl.FLOAT, new Float32Array(MAX_ELEMENTS * ELEMENT_TEX_ROWS * 4));
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

    // Per-source wavelength range: 64×2 R32F (row 0 = wlMin, row 1 = wlMax).
    this._wlPerTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._wlPerTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, 64, 2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 2, gl.RED, gl.FLOAT, new Float32Array(128));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // R32F + additive blend: EXT_color_buffer_float enables R32F
    // render targets; EXT_float_blend enables blending on them.
    // Extensions were already enabled above; just check the result.
    // EXT_float_blend is absent on some mobile GPUs — if missing,
    // fall back to CPU sensor accumulation (console warning).
    const hasColorBuf = !!gl.getExtension('EXT_color_buffer_float');
    const hasFloatBlend = !!gl.getExtension('EXT_float_blend');
    this._sensorFBOValid = hasColorBuf && hasFloatBlend;
    if (!this._sensorFBOValid) {
      console.warn('GPU tracer: disabled' +
        (!hasColorBuf ? ' (missing EXT_color_buffer_float)' : '') +
        (!hasFloatBlend ? ' (missing EXT_float_blend)' : '') +
        ' — using CPU tracer');
      this._ready = false;
      return;
    }
    this._ready = true;
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

  _uploadEdges(edges) {
    const gl = this.gl;
    const n = edges.length;
    if (n === 0) return;
    if (!this._edgeData || this._edgeData.length < n * 4) {
      this._edgeData = new Float32Array(n * 4);
    }
    const d = this._edgeData;
    gl.bindTexture(gl.TEXTURE_2D, this._edgeTex);
    // Row 0: segment = (p1.x, p1.y, p2.x, p2.y); arc = (cx, cy, R, convex)
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (e.type === 'arc') {
        d[i*4] = e.cx; d[i*4+1] = e.cy; d[i*4+2] = e.R; d[i*4+3] = e.convex ? 1 : 0;
      } else {
        d[i*4] = e.p1.x; d[i*4+1] = e.p1.y; d[i*4+2] = e.p2.x; d[i*4+3] = e.p2.y;
      }
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RGBA, gl.FLOAT, d.subarray(0, n*4));
    // Row 1: segment = (nx, ny, elIdx, 0); arc = (a0, a1, elIdx, 1)
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (e.type === 'arc') {
        d[i*4] = e.a0; d[i*4+1] = e.a1; d[i*4+2] = e._gpuElIdx ?? 0; d[i*4+3] = 1;
      } else {
        d[i*4] = e.nx; d[i*4+1] = e.ny; d[i*4+2] = e._gpuElIdx ?? 0; d[i*4+3] = 0;
      }
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, n, 1, gl.RGBA, gl.FLOAT, d.subarray(0, n*4));
  }

  _uploadElements(elementInfos) {
    const gl = this.gl;
    const n = elementInfos.length;
    if (n === 0) return;
    if (!this._elRowData || this._elRowData.length < n * 4) {
      this._elRowData = new Float32Array(n * 4);
    }
    const d = this._elRowData;
    gl.bindTexture(gl.TEXTURE_2D, this._elementTex);
    for (let row = 0; row < ELEMENT_TEX_ROWS; row++) {
      for (let i = 0; i < n; i++) {
        const info = elementInfos[i], mat = info.mat, el = info.el, off = i * 4;
        if (row === 0) {
          d[off] = mat?.type === 'mirror' ? 1 : 0;
          d[off+1] = mat?.A ?? 1; d[off+2] = mat?.B ?? 0; d[off+3] = el.absorb ?? 1;
        } else if (row === 1) {
          const a = mat?.absorb ?? {};
          d[off] = a.base ?? 0; d[off+1] = a.peak ?? 0; d[off+2] = a.center ?? 0; d[off+3] = a.sigma ?? 1;
        } else if (row === 2) {
          const r = mat?.reflect ?? {};
          d[off] = r.base ?? 0.98; d[off+1] = r.peak ?? 0; d[off+2] = r.center ?? 0; d[off+3] = r.sigma ?? 1;
        } else if (row === 3) {
          const c = el.color ? (() => {
            const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(el.color || '');
            return m ? [parseInt(m[1],16)/255, parseInt(m[2],16)/255, parseInt(m[3],16)/255] : [1,1,1];
          })() : [0,0,0];
          d[off] = info.delayK; d[off+1] = c[0]; d[off+2] = c[1]; d[off+3] = c[2];
        } else if (row === 4) {
          const s = mat?.sellmeier;
          d[off] = s?1:0; d[off+1] = s?s[0]:0; d[off+2] = s?s[1]:0; d[off+3] = s?s[2]:0;
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

    // Upload scene data
    const edges = [];
    const elementInfos = [];
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const { edges: eEdges } = worldEdges(el);
      const mat = materialOptics(el.material);
      const dK = elementDelay(el, mat);
      elementInfos.push({ el, mat, delayK: dK });
      for (const e of eEdges) { e._gpuElIdx = i; edges.push(e); }
    }
    this._uploadEdges(edges);
    this._uploadElements(elementInfos);

    // Mic levels
    if (!this._micData || this._micData.length < nSrc) {
      this._micData = new Float32Array(Math.max(nSrc, 1));
    }
    if (runtime.micLevels) {
      for (let i = 0; i < nSrc; i++) this._micData[i] = runtime.micLevels[i] ?? 1;
    } else {
      this._micData.fill(1);
    }
    // Apply disabled set — zero gain for disabled emitters unless
    // micLevels explicitly set them (e.g. touch mode activating a
    // disabled emitter). GPU shader doesn't know about the disabled set.
    const disabled = emitter.disabled;
    if (disabled && disabled.size > 0) {
      for (const s of disabled) {
        if (s >= 0 && s < nSrc && !(runtime.micLevels && runtime.micLevels[s] > 0)) {
          this._micData[s] = 0;
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this._micTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(nSrc, 64), 1, gl.RED, gl.FLOAT,
      this._micData.subarray(0, Math.min(nSrc, 64)));

    // Per-source wavelength ranges.
    const wlPer = runtime.wlPerSource;
    this._hasWlPer = !!wlPer;
    if (wlPer) {
      if (!this._wlPerData || this._wlPerData.length < nSrc) {
        this._wlPerData = new Float32Array(Math.max(nSrc, 1));
      }
      const d = this._wlPerData;
      gl.bindTexture(gl.TEXTURE_2D, this._wlPerTex);
      // Row 0: wlMin per source.
      for (let i = 0; i < nSrc && i < 64; i++) d[i] = wlPer.min[i];
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(nSrc, 64), 1, gl.RED, gl.FLOAT,
        d.subarray(0, Math.min(nSrc, 64)));
      // Row 1: wlMax per source.
      for (let i = 0; i < nSrc && i < 64; i++) d[i] = wlPer.max[i];
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, Math.min(nSrc, 64), 1, gl.RED, gl.FLOAT,
        d.subarray(0, Math.min(nSrc, 64)));
    }

    // Effective bounce count: bounded by total element edges + 1.
    // A ray can cross at most one edge per bounce, so it can't bounce
    // more times than there are edges. Reduces dispatch count and
    // segment buffer size dramatically for simple scenes.
    // Each edge can be hit multiple times (TIR, re-entry). With polygon
    // facets, edge count far exceeded actual hits; with analytic arcs the
    // count matches physical surfaces. Arc edges can be hit multiple
    // times (TIR), so they get 3× headroom. Polygon segment edges are
    // hit at most once, so they get 1×. +2 for the final wall hit.
    let arcCount = 0, segCount_ = 0;
    for (const e of edges) { if (e.type === 'arc') arcCount++; else segCount_++; }
    const effectiveBounces = Math.min(MAX_BOUNCES, segCount_ + arcCount * 3 + 2);

    // Ping-pong: two ray-state buffers (read from one, TF writes to
    // the other). Separate segment buffer for renderer output.
    // Chrome forbids reading and writing the same buffer in one draw
    // call even at different offsets.
    const rayStateBytes = totalRays * PP_BYTES;
    if (!this._ppBufs) {
      this._ppBufs = [gl.createBuffer(), gl.createBuffer()];
      for (const buf of this._ppBufs) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, rayStateBytes, gl.DYNAMIC_COPY);
      }
      this._ppRayStateBytes = rayStateBytes;
    }
    if (this._ppRayStateBytes !== rayStateBytes) {
      for (const buf of this._ppBufs) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, rayStateBytes, gl.DYNAMIC_COPY);
      }
      this._ppRayStateBytes = rayStateBytes;
      // Delete and invalidate VAOs and TF objects — they hold stale
      // buffer bindings from the old size.
      if (this._ppVaos) {
        for (const v of this._ppVaos) gl.deleteVertexArray(v);
        gl.deleteVertexArray(this._ppVao0);
      }
      if (this._ppTfs) {
        for (const t of this._ppTfs) gl.deleteTransformFeedback(t);
      }
      this._ppVaos = null;
      this._ppTfs = null;
    }
    // Segment buffer: effectiveBounces copies of the PP output.
    const segTotalBytes = effectiveBounces * rayStateBytes;
    if (!this._segBuffer || this._segBytes !== segTotalBytes) {
      if (this._segBuffer) gl.deleteBuffer(this._segBuffer);
      this._segBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._segBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, segTotalBytes, gl.DYNAMIC_COPY);
      this._segBytes = segTotalBytes;
    }

    // Uniforms
    gl.useProgram(this._program);
    const loc = this._uloc;
    gl.uniform1f(loc.benchW, bench.w);
    gl.uniform1f(loc.benchH, bench.h);
    gl.uniform1i(loc.sourceCount, nSrc);
    gl.uniform1i(loc.raysPerSource, raysPer);
    gl.uniform1f(loc.wlMin, emitter.wlMin);
    gl.uniform1f(loc.wlMax, emitter.wlMax);
    gl.uniform1f(loc.apertureFactor, emitter.apertureFactor ?? 0.01);
    gl.uniform1f(loc.spreadRad, (emitter.spreadDeg ?? 0) * Math.PI / 180);
    gl.uniform1f(loc.baseIntensity, 1.6);
    gl.uniform1i(loc.edgeCount, edges.length);
    gl.uniform1i(loc.elementCount, elementInfos.length);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._edgeTex);
    gl.uniform1i(loc.edges, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._elementTex);
    gl.uniform1i(loc.elements, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this._micTex);
    gl.uniform1i(loc.micLevels, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this._wlPerTex);
    gl.uniform1i(loc.wlPerSource, 3);
    gl.uniform1i(loc.hasWlPer, this._hasWlPer ? 1 : 0);

    // --- Bounce loop: ping-pong between two buffers ---
    // Two separate VAOs for the two read buffers, to avoid rebinding
    // attribs each bounce. VAO 0 reads from _ppBufs[0], VAO 1 from [1].
    if (!this._ppVaos) {
      this._ppVaos = [gl.createVertexArray(), gl.createVertexArray()];
      for (let v = 0; v < 2; v++) {
        gl.bindVertexArray(this._ppVaos[v]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._ppBufs[v]);
        if (this._aRayPosDir >= 0) {
          gl.enableVertexAttribArray(this._aRayPosDir);
          gl.vertexAttribPointer(this._aRayPosDir, 4, gl.FLOAT, false, PP_BYTES, 0);
        }
        if (this._aRayState >= 0) {
          gl.enableVertexAttribArray(this._aRayState);
          gl.vertexAttribPointer(this._aRayState, 4, gl.FLOAT, false, PP_BYTES, 16);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
      gl.bindVertexArray(null);
      // VAO for bounce 0 (no input attribs)
      this._ppVao0 = gl.createVertexArray();
      gl.bindVertexArray(this._ppVao0);
      if (this._aRayPosDir >= 0) gl.disableVertexAttribArray(this._aRayPosDir);
      if (this._aRayState >= 0) gl.disableVertexAttribArray(this._aRayState);
      gl.bindVertexArray(null);
    }

    // Two TF objects, one per write buffer. Created once, reused.
    if (!this._ppTfs) {
      this._ppTfs = [gl.createTransformFeedback(), gl.createTransformFeedback()];
      for (let t = 0; t < 2; t++) {
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._ppTfs[t]);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._ppBufs[t]);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      }
    }

    // Save state modified by trace. The renderer expects these intact.
    const prevRasterDiscard = gl.isEnabled(gl.RASTERIZER_DISCARD);
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);

    gl.enable(gl.RASTERIZER_DISCARD);

    for (let b = 0; b < effectiveBounces; b++) {
      gl.uniform1i(loc.bounce, b);
      const readIdx = b & 1;
      const writeIdx = 1 - readIdx;

      // Bind the VAO that reads from the read buffer (or VAO0 for bounce 0).
      gl.bindVertexArray(b === 0 ? this._ppVao0 : this._ppVaos[readIdx]);

      // Bind the TF that writes to the write buffer.
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this._ppTfs[writeIdx]);

      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, totalRays);
      gl.endTransformFeedback();

      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

      // Copy this bounce's output to the segment buffer.
      const segRegionOffset = b * rayStateBytes;
      gl.bindBuffer(gl.COPY_READ_BUFFER, this._ppBufs[writeIdx]);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, this._segBuffer);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER,
        0, segRegionOffset, rayStateBytes);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    }

    // Restore state.
    if (prevRasterDiscard) gl.enable(gl.RASTERIZER_DISCARD);
    else gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindVertexArray(prevVao);

    // Expose segment buffer for renderer. Segments at byte offset 32
    // within each PP_BYTES record, stride PP_BYTES.
    this.glSegmentBuffer = this._segBuffer;
    this.glSegmentStride = PP_BYTES;
    this.glSegmentOffset = SEG_P_OFF;
    this.glSegmentCount = totalRays * effectiveBounces;

    // --- Sensor FBO pass ---
    this.sensorCount = sensorCount;
    const binLen = sensorCount * this.binCount;
    if (!this.sensorBins || this.sensorBins.length !== binLen) {
      this.sensorBins = new Float32Array(binLen);
    }

    if (this._sensorProgram && this._sensorFBOValid) {
      const fbW = this.binCount, fbH = sensorCount;
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

      // Sensor pass modifies FBO, viewport, blend, program. The
      // renderer's draw() sets all of these before drawing, so we
      // only need to unbind the FBO afterward.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._sensorFBO);
      gl.viewport(0, 0, fbW, fbH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.useProgram(this._sensorProgram);
      gl.uniform1f(this._sensorLoc.benchH, bench.h);
      gl.uniform1i(this._sensorLoc.sensorCount, sensorCount);
      gl.uniform1i(this._sensorLoc.binCount, this.binCount);

      const totalVerts = totalRays * effectiveBounces;
      const sLoc = this._sensorLoc;
      gl.bindBuffer(gl.ARRAY_BUFFER, this._segBuffer);
      const sensorAttribs = [
        [sLoc.aP, 4, SEG_P_OFF],
        [sLoc.aC2, 4, SEG_C2_OFF],
        [sLoc.aMeta, 4, SEG_META_OFF],
      ];
      for (const [l, size, offset] of sensorAttribs) {
        if (l < 0) continue;
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, PP_BYTES, offset);
      }
      gl.drawArrays(gl.POINTS, 0, totalVerts);
      for (const [l] of sensorAttribs) { if (l >= 0) gl.disableVertexAttribArray(l); }
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.disable(gl.BLEND);

      gl.readPixels(0, 0, fbW, fbH, gl.RED, gl.FLOAT, this.sensorBins);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // Debug readback
    if (this._debugReadback) {
      const totalVerts = totalRays * effectiveBounces;
      const rbLen = totalVerts * PP_FLOATS;
      if (!this._debugBuf || this._debugBuf.length < rbLen) {
        this._debugBuf = new Float32Array(rbLen);
      }
      const rb = this._debugBuf;
      gl.bindBuffer(gl.COPY_READ_BUFFER, this._segBuffer);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, rb.subarray(0, rbLen));
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      let segCount = 0;
      for (let i = 0; i < totalVerts; i++) {
        const off = i * PP_FLOATS;
        if (rb[off + 12 + 3] > 1e-6 || rb[off + 16 + 3] > 1e-6) segCount++;
      }
      if (this.segmentData.length < segCount * SEG_FLOATS) {
        this.segmentData = new Float32Array(segCount * SEG_FLOATS);
      }
      // PP record layout offsets (in floats from record start):
      const SEG_P = 8, SEG_C1 = 12, SEG_C2 = 16;
      let si = 0;
      for (let i = 0; i < totalVerts; i++) {
        const off = i * PP_FLOATS;
        const I1 = rb[off + SEG_C1 + 3]; // v_segC1.w
        const I2 = rb[off + SEG_C2 + 3]; // v_segC2.w
        if (I1 < 1e-6 && I2 < 1e-6) continue;
        for (let f = 0; f < 4; f++) this.segmentData[si * SEG_FLOATS + f] = rb[off + SEG_P + f];
        for (let f = 0; f < 4; f++) this.segmentData[si * SEG_FLOATS + 4 + f] = rb[off + SEG_C1 + f];
        for (let f = 0; f < 4; f++) this.segmentData[si * SEG_FLOATS + 8 + f] = rb[off + SEG_C2 + f];
        si++;
      }
      this.segmentCount = si;
    }
  }

  activeParticleCount() { return 0; }
  resetPersistence() {}
  get simRate() { return 1; }
  set simRate(_) {}
}
