// Auto element placement.
//
// Analyzes the currently loaded song and the current scene, then chooses
// an element kind, material, and position that:
//   (a) doesn't overlap existing elements,
//   (b) avoids the song's melody band so the line isn't destroyed,
//   (c) is positioned to interact with existing elements optically when
//       synergy rules fire (chain dispersion, cavity, focal point, …).
//
// Invoked from the Add menu's "Auto" item. Entirely pure — no DOM access.
// Returns `{ element, adjustments }` on success, `{ error }` on failure.
//   element     — new element ready to push into scene.elements.
//   adjustments — list of `{ id, spin }` tweaks to apply to existing
//                 elements (tempo-sync for a scene that wasn't spinning).

import { makeElement, worldEdges, overlapsAny } from './scene.js';

export function autoPlace(scene, song) {
  const features = song ? analyzeSong(song, scene) : defaultFeatures(scene);
  const synergy = analyzeScene(scene);
  const candidates = makeCandidates(features, synergy, scene);
  if (candidates.length === 0) {
    return { error: 'no candidate element kinds available' };
  }

  // Shuffle within same-ish scores so repeated Auto presses on the same
  // scene+song don't always produce identical output.
  shuffleInPlace(candidates);
  candidates.sort((a, b) => b._score - a._score);

  const adjustments = buildSpinAdjustments(features, synergy, scene);

  for (const c of candidates) {
    const el = tryPlaceCandidate(c, features, synergy, scene);
    if (el) {
      return { element: el, adjustments, label: c._label };
    }
  }
  return {
    error: 'no non-overlapping placement found outside the melody band',
  };
}

// --- Song analysis ---

export function analyzeSong(song, scene) {
  const notes = song.notes || [];
  const N = (song.global?.emitter?.count) || scene.emitter.count;
  if (notes.length === 0 || N <= 0) return defaultFeatures(scene);

  // Pitch-energy histogram weighted by velocity × duration.
  const w = new Float64Array(N);
  for (const n of notes) {
    if (n.emitter < 0 || n.emitter >= N) continue;
    w[n.emitter] += (n.vel || 1) * (n.dur || 0.1);
  }
  let total = 0;
  for (let i = 0; i < N; i++) total += w[i];
  if (total <= 0) return defaultFeatures(scene);
  const W = new Array(N);
  for (let i = 0; i < N; i++) W[i] = w[i] / total;

  // 3-tap smoothed copy for band detection.
  const S = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    S[i] = 0.25 * (W[i - 1] ?? 0) + 0.5 * W[i] + 0.25 * (W[i + 1] ?? 0);
  }

  // Centroid + spread (in emitter-index space).
  // Bass-pedal compensation: a sustained low drone (e.g. open-string
  // bass on emitter 0) can hold 20-30% of the velocity-weighted
  // energy and drag the centroid toward the bottom of the bench even
  // when the melody is firmly in the upper half. Down-weight the
  // lower third's contribution to the centroid so the metric reflects
  // the "musical voice" region rather than the drone.
  const third = Math.max(1, Math.floor(N / 3));
  const BASS_FADE = 0.3;
  let cNum = 0, cDen = 0;
  for (let i = 0; i < N; i++) {
    const wt = i < third ? BASS_FADE * W[i] : W[i];
    cNum += i * wt;
    cDen += wt;
  }
  const centroid = cDen > 0 ? cNum / cDen : N / 2;
  let variance = 0;
  for (let i = 0; i < N; i++) variance += W[i] * (i - centroid) ** 2;
  const spread = Math.sqrt(variance);

  // Bass / treble ratios.
  let bassRatio = 0, trebleRatio = 0;
  for (let i = 0; i < third; i++) bassRatio += W[i];
  for (let i = N - third; i < N; i++) trebleRatio += W[i];

  // Melody band: peak of smoothed weights in the upper 2/3 of the
  // bench (skips the bass-pedal region for the same reason as the
  // centroid down-weight above), then expand while ≥ 30% of peak.
  let peak = third;
  for (let i = third + 1; i < N; i++) if (S[i] > S[peak]) peak = i;
  const thresh = S[peak] * 0.3;
  let mLo = peak, mHi = peak;
  while (mLo > 0 && S[mLo - 1] >= thresh) mLo--;
  while (mHi < N - 1 && S[mHi + 1] >= thresh) mHi++;
  // Cap the melody band to half the emitter range so we don't veto the
  // whole bench for polyphonic pieces.
  const maxMelodyWidth = Math.max(1, Math.floor(N / 2));
  if (mHi - mLo + 1 > maxMelodyWidth) {
    mLo = Math.max(0, peak - Math.floor(maxMelodyWidth / 2));
    mHi = Math.min(N - 1, mLo + maxMelodyWidth - 1);
  }

  // Quiet band: widest-minimum-energy window (width ≥ N/5) that does
  // NOT overlap the melody band.
  const winW = Math.max(1, Math.ceil(N / 5));
  let bestLo = -1, bestSum = Infinity;
  for (let i = 0; i + winW - 1 < N; i++) {
    if (i <= mHi && i + winW - 1 >= mLo) continue; // overlaps melody
    let s = 0;
    for (let j = i; j < i + winW; j++) s += S[j];
    if (s < bestSum) { bestSum = s; bestLo = i; }
  }
  if (bestLo < 0) {
    // Shouldn't hit (melody is capped at N/2), but safe fallback.
    for (let i = 0; i + winW - 1 < N; i++) {
      let s = 0;
      for (let j = i; j < i + winW; j++) s += S[j];
      if (s < bestSum) { bestSum = s; bestLo = i; }
    }
  }
  const qLo = Math.max(0, bestLo);
  const qHi = Math.min(N - 1, bestLo + winW - 1);

  // Density / polyphony / velocity variance.
  const duration = Math.max(1e-3, song.duration || 1);
  const notesPerSec = notes.length / duration;
  let noteSeconds = 0;
  for (const n of notes) noteSeconds += (n.dur || 0);
  const avgPoly = noteSeconds / duration;

  let vMean = 0;
  for (const n of notes) vMean += (n.vel || 1);
  vMean /= notes.length;
  let vVar = 0;
  for (const n of notes) vVar += ((n.vel || 1) - vMean) ** 2;
  const velSigma = Math.sqrt(vVar / notes.length);

  return {
    N, W, S,
    centroid, spread,
    bassRatio, trebleRatio,
    melodyLo: mLo, melodyHi: mHi,
    quietLo: qLo, quietHi: qHi,
    notesPerSec, avgPoly,
    velSigma,
    bpm: song.bpm || 120,
    duration,
    hasMelody: true,
  };
}

function defaultFeatures(scene) {
  const N = scene.emitter.count || 24;
  return {
    N, W: null, S: null,
    centroid: N / 2, spread: N / 4,
    bassRatio: 0.33, trebleRatio: 0.33,
    melodyLo: -1, melodyHi: -1, // no melody veto
    quietLo: Math.floor(N * 0.2), quietHi: Math.floor(N * 0.4),
    notesPerSec: 0, avgPoly: 0, velSigma: 0,
    bpm: 120, duration: 1,
    hasMelody: false,
  };
}

// --- Scene synergy ---

export function analyzeScene(scene) {
  const syn = {
    hasPrism: false, hasBlock: false, hasCircle: false,
    hasLensConvex: false, hasLensConcave: false,
    hasMirror: false, hasMirrorConcave: false, hasMirrorConvex: false,
    hasDiamond: false, hasRabbit: false,
    hasSpinning: false, hasColored: false, hasSlowGlass: false,
    prisms: [], mirrors: [], mirrorsConcave: [],
    lensesConvex: [], coloredElements: [], slowGlassElements: [],
    count: scene.elements.length,
  };
  for (const el of scene.elements) {
    switch (el.kind) {
      case 'prism':          syn.hasPrism = true;         syn.prisms.push(el); break;
      case 'block':          syn.hasBlock = true; break;
      case 'lens-convex':    syn.hasLensConvex = true;    syn.lensesConvex.push(el); break;
      case 'lens-concave':   syn.hasLensConcave = true; break;
      case 'mirror':         syn.hasMirror = true;        syn.mirrors.push(el); break;
      case 'mirror-concave': syn.hasMirrorConcave = true; syn.mirrorsConcave.push(el); break;
      case 'mirror-convex':  syn.hasMirrorConvex = true; break;
      case 'circle':         syn.hasCircle = true; break;
      case 'diamond':        syn.hasDiamond = true; break;
      case 'rabbit':         syn.hasRabbit = true; break;
    }
    if (Math.abs(el.spin || 0) > 1e-6) syn.hasSpinning = true;
    if (el.color) { syn.hasColored = true; syn.coloredElements.push(el); }
    if (el.material === 'slowGlass' || (el.delayK ?? 0) > 0.0003) {
      syn.hasSlowGlass = true; syn.slowGlassElements.push(el);
    }
  }
  return syn;
}

// --- Candidate generation ---

function makeCandidates(f, syn, scene) {
  const jitter = () => 1 + 0.3 * (Math.random() - 0.5);
  const list = [];

  // Count existing elements by kind so we can penalize candidates that
  // would duplicate what's already there. Diversity wins over purity
  // of fit — if the scene already has a prism, a second prism is half
  // as appealing.
  const kindCount = {};
  for (const el of scene.elements) {
    kindCount[el.kind] = (kindCount[el.kind] || 0) + 1;
  }
  const diversity = kind => 1 / (1 + (kindCount[kind] || 0));

  // Prisms are the most visually interesting refractor — sharp apex,
  // big dispersion fan, clear rotation. Auto leans into them; three
  // prism flavors cover bass pulse, treble color, and dense chords.

  // 1. Rotating prism — bass-heavy, low polyphony. Tempo-synced spin.
  {
    let w = 0.25; // baseline so prisms stay in the mix even for neutral songs
    if (f.bassRatio > 0.35) w += f.bassRatio * 1.8;
    if (f.avgPoly < 2 && f.hasMelody) w += 0.3;
    if (syn.hasSpinning) w += 0.4; // counter-spin visual interest
    list.push({
      kind: 'prism',
      materialChoices: ['crown', 'fused', 'flint'],
      sizeRange: [90, 140],
      rotRange: [-Math.PI, Math.PI],
      spinBpmSign: syn.hasSpinning ? -1 : +1,
      yPref: 'bass', // lower band of bench (high-y)
      _score: w * jitter(),
      _label: 'rotating prism (bass pulse)',
    });
  }

  // 2. Colorful prism — treble or expressive dynamics. Chain dispersion
  // when another prism exists. The anchor drives S1 bearing-based
  // placement (rays leaving the first prism fan toward the new one);
  // S3's Gaussian centre is 'quiet' rather than 'near-anchor' so the
  // same bass-area prism doesn't get stacked on top of itself.
  {
    let w = 0.2; // baseline
    if (f.trebleRatio > 0.3) w += f.trebleRatio * 1.4;
    if (f.velSigma > 0.2) w += f.velSigma;
    if (syn.hasPrism) w += 0.3;
    list.push({
      kind: 'prism',
      materialChoices: syn.hasPrism ? ['hyper', 'flint'] : ['flint', 'hyper', 'crown'],
      sizeRange: [100, 150],
      rotRange: [-Math.PI, Math.PI],
      spinBpmSign: 0,
      yPref: syn.hasPrism ? 'quiet' : 'treble',
      anchor: syn.hasPrism ? syn.prisms[0] : null,
      _score: w * jitter(),
      _label: 'colorful prism (chain dispersion)',
    });
  }

  // 3. Convex lens — wide spread, works to converge rays onto a narrower
  // sensor band.
  {
    let w = 0;
    if (f.spread > f.N / 4) w += 0.8;
    if (f.avgPoly > 1 && f.hasMelody) w += 0.2;
    if (w > 0) list.push({
      kind: 'lens-convex',
      materialChoices: ['crown', 'fused'],
      sizeRange: [110, 170],
      rotRange: [-Math.PI / 4, Math.PI / 4],
      spinBpmSign: 0,
      yPref: 'quiet',
      _score: w * jitter(),
      _label: 'convex lens (focus spread)',
    });
  }

  // Mirrors only appear when there's a prism in the scene for them to
  // catch dispersed light from, and they're always small — a full-sized
  // mirror tends to dominate the bench and destroy the line. Both
  // variants are anchored to the prism so S1 places them downstream
  // of its dispersion fan; S3 orbits the prism too.

  // 4. Small flat mirror — redirects part of a prism's spectrum off
  // onto a different sensor band.
  if (syn.hasPrism) {
    list.push({
      kind: 'mirror',
      materialChoices: ['mirror'],
      sizeRange: [40, 70], // primary is 'w' — 40–70 bench units wide
      rotRange: [-Math.PI / 2, Math.PI / 2],
      spinBpmSign: 0,
      yPref: 'near-anchor',
      anchor: syn.prisms[0],
      _score: 0.9 * jitter(),
      _label: 'small flat mirror (prism catcher)',
    });
  }

  // 5. Small concave mirror — refocuses the dispersion fan onto a
  // tight spot, good for sparse or cavity-leaning songs.
  if (syn.hasPrism) {
    let w = 0.6;
    if (f.notesPerSec < 3) w += 1 - Math.min(1, f.notesPerSec / 3);
    list.push({
      kind: 'mirror-concave',
      materialChoices: ['mirror'],
      sizeRange: [35, 55], // primary is 'h' — 35–55 bench units tall
      rotRange: [Math.PI - Math.PI / 3, Math.PI + Math.PI / 3],
      spinBpmSign: 0,
      yPref: 'near-anchor',
      anchor: syn.prisms[0],
      _score: w * jitter(),
      _label: 'small concave mirror (prism refocuser)',
    });
  }

  // 6. Dense-chord prism — high-dispersion prism that smears stacked
  // harmonies without swallowing rays. Circles and slow-glass are
  // intentionally excluded from Auto (they muddy the line); a prism at
  // an angled quiet band covers the same niche more musically.
  {
    let w = 0;
    if (f.avgPoly > 2) w += Math.min(1.5, f.avgPoly * 0.3);
    if (w > 0) list.push({
      kind: 'prism',
      materialChoices: ['hyper', 'flint'],
      sizeRange: [90, 130],
      rotRange: [-Math.PI, Math.PI],
      spinBpmSign: 0,
      yPref: 'quiet',
      _score: w * jitter(),
      _label: 'dispersive prism (chord smear)',
    });
  }

  // 7. Synergy: complementary-color block when another element has a
  // color. Block is the right shape here (parallel faces, no deflection),
  // so the emerging rays are color-filtered rather than bent. Low weight
  // — prisms are usually more fun.
  if (syn.coloredElements.length > 0) {
    const src = syn.coloredElements[0];
    list.push({
      kind: 'block',
      materialChoices: ['crown', 'fused'],
      sizeRange: [80, 130],
      rotRange: [-Math.PI / 3, Math.PI / 3],
      spinBpmSign: 0,
      yPref: 'near-anchor',
      anchor: src,
      forceColor: complementHex(src.color),
      _score: 0.4 * jitter(),
      _label: 'complementary-color block',
    });
  }

  // 9. Diamond — small novelty light-trap. Low base weight.
  {
    let w = 0.25;
    if (f.bassRatio < 0.3 && f.trebleRatio < 0.3) w += 0.2; // mid-focused songs
    if (syn.hasDiamond) w *= 0.2; // don't pile diamonds
    list.push({
      kind: 'diamond',
      materialChoices: ['diamond'],
      sizeRange: [80, 130],
      rotRange: [-Math.PI / 6, Math.PI / 6],
      spinBpmSign: 0,
      yPref: 'quiet',
      _score: w * jitter(),
      _label: 'diamond trap',
    });
  }

  // 10. Rabbit — flat novelty candidate.
  {
    let w = 0.2;
    if (syn.hasRabbit) w *= 0.2;
    list.push({
      kind: 'rabbit',
      materialChoices: ['crown', 'flint', 'water'],
      sizeRange: [120, 170],
      rotRange: [-Math.PI, Math.PI],
      spinBpmSign: 0,
      yPref: 'quiet',
      _score: w * jitter(),
      _label: 'rabbit',
    });
  }

  // Apply diversity penalty: each existing element of a kind halves
  // the score of any candidate that would add another of the same
  // kind. On a full scene this flips weight to whatever kinds aren't
  // there yet, eliminating the "same element over and over" effect.
  for (const c of list) c._score *= diversity(c.kind);

  // Prune near-zero entries so they don't waste retry budget.
  return list.filter(c => c._score > 0.01);
}

// --- Placement ---

function tryPlaceCandidate(c, f, syn, scene) {
  const benchW = scene.bench.w;
  const benchH = scene.bench.h;
  const N = scene.emitter.count;
  const stripH = benchH / N;

  const melody = f.melodyLo >= 0
    ? bandToY(f.melodyLo, f.melodyHi, benchH, stripH)
    : null;
  const quiet = bandToY(f.quietLo, f.quietHi, benchH, stripH);

  const proposals = generateProposals(c, f, syn, scene, melody, quiet, benchW, benchH);

  for (const p of proposals) {
    const el = buildElement(c, p);
    if (!isInBench(el, benchW, benchH)) continue;
    if (melody && violatesMelody(el, melody)) continue;
    if (overlapsAny(el, scene.elements)) continue;
    return el;
  }
  return null;
}

function bandToY(loIdx, hiIdx, benchH, stripH) {
  // Emitter 0 is at y = benchH - 0.5*stripH (bottom); index grows upward
  // (toward y=0). Band [lo..hi] in index space → y-range in bench coords.
  const yTop = benchH - (hiIdx + 1) * stripH;
  const yBot = benchH - loIdx * stripH;
  return { yLo: yTop, yHi: yBot };
}

function generateProposals(c, f, syn, scene, melody, quiet, benchW, benchH) {
  const out = [];
  const pushTrial = (x, y, extra = {}) => out.push({
    x, y,
    rot: randRange(c.rotRange),
    size: randRange(c.sizeRange),
    material: randChoice(c.materialChoices),
    color: c.forceColor || null,
    spin: c.spinBpmSign ? spinFromBpm(f.bpm, c.spinBpmSign) : 0,
    ...extra,
  });

  // S1 — synergy-anchored: place downstream of the anchor along its
  // bearing. Rotation is biased so the new element's axis aligns with
  // the light that's likely to hit it.
  if (c.anchor) {
    const a = c.anchor;
    const baseBearing = a.rot || 0;
    const anchorRadius = estimateRadius(a);
    for (let i = 0; i < 6; i++) {
      const bearing = baseBearing + (Math.random() - 0.5) * Math.PI / 3;
      const size = randRange(c.sizeRange);
      const d = anchorRadius + size / 2 + 30 + Math.random() * 30;
      pushTrial(
        a.x + Math.cos(bearing) * d,
        a.y + Math.sin(bearing) * d,
        { size, rot: bearing + (Math.random() - 0.5) * Math.PI / 4 },
      );
    }
  }

  // S2 — quiet band, widest x-gap. One proposal per top gap.
  const yMid = (quiet.yLo + quiet.yHi) / 2;
  if (yMid > 20 && yMid < benchH - 20) {
    const gaps = findXGaps(scene, quiet.yLo, quiet.yHi, benchW);
    for (const g of gaps.slice(0, 4)) {
      if (g.width < 60) continue;
      pushTrial(g.center, yMid);
    }
  }

  // S3 — Gaussian around the preferred band's center. Far-tail
  // proposals are automatically shrunk so a cramped scene can still
  // find room for a (smaller) element without giving up and bailing.
  const ctr = preferredCenter(c, benchH, quiet, c.anchor);
  if (ctr) {
    const sigmaY = Math.max(30, (quiet.yHi - quiet.yLo) / 2);
    const sigmaX = benchW / 4;
    const cx = ctr.x ?? benchW / 2; // x-center defaults to bench center
    const cy = ctr.y;
    for (let i = 0; i < 16; i++) {
      const y = gaussian(cy, sigmaY);
      const x = gaussian(cx, sigmaX);
      // Mahalanobis-style normalized distance from the center.
      const dy = (y - cy) / sigmaY;
      const dx = (x - cx) / sigmaX;
      const dist = Math.min(1, Math.hypot(dx, dy) / 2);
      // Shrink up to 50% as we move into the tails — smaller objects
      // are more likely to fit in whatever gaps remain.
      const shrink = 1 - 0.5 * dist;
      const [loSz, hiSz] = c.sizeRange;
      const size = randRange([loSz * shrink, hiSz * shrink]);
      pushTrial(x, y, { size });
    }
  }

  return out;
}

// Center of the preferred placement region, used as the Gaussian mean
// for S3 proposals. Returns `{ x, y }` or null if the candidate has no
// sensible home.
function preferredCenter(c, benchH, quiet, anchor) {
  const qMid = (quiet.yLo + quiet.yHi) / 2;
  switch (c.yPref) {
    case 'bass':   return { x: null, y: benchH * 0.75 };
    case 'treble': return { x: null, y: benchH * 0.25 };
    case 'quiet':  return { x: null, y: qMid };
    case 'focal':  return anchor ? { x: anchor.x, y: anchor.y } : null;
    case 'near-anchor':
    case 'opposite-mirror':
      return anchor
        ? { x: anchor.x, y: anchor.y }
        : { x: null, y: qMid };
    default:       return { x: null, y: benchH / 2 };
  }
}

function buildElement(c, p) {
  const el = makeElement(c.kind, p.x, p.y);
  if (p.material) el.material = p.material;
  el.rot = p.rot;
  applyPrimarySize(el, p.size);
  if (p.spin) el.spin = p.spin;
  if (p.color) el.color = p.color;
  return el;
}

// Set the kind's primary size field. Keeps other dims (when present) at
// their schema defaults — e.g. block gets w=size, h default; lens gets
// h=size, w default, radius default.
function applyPrimarySize(el, size) {
  const key = PRIMARY_SIZE_KEY[el.kind];
  if (key && key in el) el[key] = size;
}
const PRIMARY_SIZE_KEY = {
  prism: 'size',
  block: 'w',
  'lens-convex': 'h',
  'lens-concave': 'h',
  mirror: 'w',
  'mirror-concave': 'h',
  'mirror-convex': 'h',
  circle: 'radius',
  rabbit: 'size',
  diamond: 'size',
};

// --- Validation ---

function isInBench(el, benchW, benchH) {
  const margin = 20;
  if (el.x < margin || el.x > benchW - margin) return false;
  if (el.y < margin || el.y > benchH - margin) return false;
  // Also keep entire polygon AABB inside the bench.
  const box = aabb(el);
  if (box.minX < 5 || box.maxX > benchW - 5) return false;
  if (box.minY < 5 || box.maxY > benchH - 5) return false;
  return true;
}

function violatesMelody(el, melody) {
  const box = aabb(el);
  // AABB y-range overlapping melody y-range → the element sits in the
  // ray path of melody notes.
  return !(box.maxY < melody.yLo || box.minY > melody.yHi);
}

function aabb(el) {
  const poly = worldEdges(el).polygon;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

function findXGaps(scene, yLo, yHi, benchW) {
  const obstacles = [];
  for (const el of scene.elements) {
    const box = aabb(el);
    if (box.maxY < yLo || box.minY > yHi) continue;
    obstacles.push({ lo: box.minX, hi: box.maxX });
  }
  obstacles.sort((a, b) => a.lo - b.lo);
  const gaps = [];
  let prev = 0;
  for (const o of obstacles) {
    if (o.lo > prev) gaps.push({ lo: prev, hi: o.lo });
    if (o.hi > prev) prev = o.hi;
  }
  if (prev < benchW) gaps.push({ lo: prev, hi: benchW });
  for (const g of gaps) {
    g.width = g.hi - g.lo;
    g.center = (g.lo + g.hi) / 2;
  }
  gaps.sort((a, b) => b.width - a.width);
  return gaps;
}

function estimateRadius(el) {
  const box = aabb(el);
  return Math.max(box.maxX - box.minX, box.maxY - box.minY) / 2;
}

// --- Spin adjustments ---

function buildSpinAdjustments(f, syn, scene) {
  if (syn.hasSpinning || !f.hasMelody || scene.elements.length === 0) {
    return [];
  }
  // Pick the element furthest outside the melody y-band.
  const stripH = scene.bench.h / scene.emitter.count;
  const melody = bandToY(f.melodyLo, f.melodyHi, scene.bench.h, stripH);
  const melodyMid = (melody.yLo + melody.yHi) / 2;

  let best = null;
  for (const el of scene.elements) {
    if (el.y >= melody.yLo && el.y <= melody.yHi) continue;
    const d = Math.abs(el.y - melodyMid);
    if (!best || d > best.d) best = { el, d };
  }
  if (!best) return [];

  const sign = Math.random() < 0.5 ? -1 : 1;
  const spin = spinFromBpm(f.bpm, sign);
  return [{ id: best.el.id, spin }];
}

// --- Helpers ---

function spinFromBpm(bpm, sign) {
  // Gentle bar-scale rotations only — one full turn every 8, 16, or 32
  // beats. At 112 BPM that's roughly 42, 21, or 11 deg/s, which reads as
  // "drifting slowly" rather than "whirring". Hard-capped at 45 deg/s
  // so a fast song can't nudge this into hectic territory.
  const beatsPerRotation = [8, 16, 32][Math.floor(Math.random() * 3)];
  const omega = (bpm / 60) * (2 * Math.PI / beatsPerRotation) * sign;
  const cap = Math.PI / 4; // 45 deg/s
  return Math.max(-cap, Math.min(cap, omega));
}

function randRange([lo, hi]) {
  if (lo === hi) return lo;
  return lo + Math.random() * (hi - lo);
}

// Box-Muller normal variate. `u1 > 0` guard avoids the log(0) edge case
// on the unlikely chance Math.random() returns exactly 0.
function gaussian(mean, sigma) {
  const u1 = Math.max(Math.random(), 1e-9);
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sigma * z;
}

function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function complementHex(hex) {
  if (!hex || hex[0] !== '#' || hex.length !== 7) return '#808080';
  const r = 255 - parseInt(hex.slice(1, 3), 16);
  const g = 255 - parseInt(hex.slice(3, 5), 16);
  const b = 255 - parseInt(hex.slice(5, 7), 16);
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
}
