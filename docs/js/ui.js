// UI: input handling, property panel, save/load.

import { makeElement, worldEdges, pointInPolygon, overlapsAny, serializeScene, deserializeScene, createScene, autoTitle, bumpGeneration, ensureRuntimeSize } from './scene.js';
import { autoPlace } from './auto-place.js';
import { MATERIALS } from './spectrum.js';
import { ELEMENTS } from './elements.js';

// Turn a scene title into a filesystem-friendly filename.
// Strips diacritics, replaces em-dashes and non-alphanumerics with a single
// dash, trims, lowercases, then prefixes "chromavox-" and suffixes ".json".
function filenameFromTitle(title) {
  const slug = (title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')    // strip combining diacritics
    .replace(/[^a-zA-Z0-9]+/g, '-')     // collapse em-dash, commas, spaces, etc. into a single dash
    .replace(/^-+|-+$/g, '')            // trim leading/trailing dashes
    .toLowerCase();
  return 'chromavox-' + (slug || 'scene') + '.json';
}

// Apply a mutation to an element, reverting if it causes overlap.
// `mutate` is called with the element; `keys` lists the properties
// that may change (saved/restored on overlap). Returns true if applied.
function tryMutate(el, elements, keys, mutate) {
  if (!document.getElementById('no-overlap').checked) { mutate(el); return true; }
  const saved = {};
  for (const k of keys) saved[k] = el[k];
  mutate(el);
  if (overlapsAny(el, elements)) {
    for (const k of keys) el[k] = saved[k];
    return false;
  }
  return true;
}

// Undo/redo. Snapshots the mutable scene state (elements, emitter settings,
// sensor count, bench) as a JSON string. Rapid drags and slider scrubs are
// batched: `beginEdit` captures the pre-state lazily, `endEdit` commits if
// anything actually changed.
// Build an SVG icon for an Add-menu item by rendering the element's actual
// polygon (default rotation included). Single source of geometry — relies on
// `worldEdges` so any change to `localPolygon` automatically updates the
// menu icons.
function buildElementIcon(kind) {
  const el = makeElement(kind, 0, 0);
  const { polygon } = worldEdges(el);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const W = Math.max(1, maxX - minX);
  const H = Math.max(1, maxY - minY);
  const pad = Math.max(W, H) * 0.06;
  const vbW = W + 2 * pad;
  const vbH = H + 2 * pad;
  const pts = polygon.map(p =>
    `${(p.x - minX + pad).toFixed(1)},${(p.y - minY + pad).toFixed(1)}`
  ).join(' ');
  const sw = (Math.max(vbW, vbH) * 0.045).toFixed(2);
  return `<svg class="tmi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW.toFixed(1)} ${vbH.toFixed(1)}" preserveAspectRatio="xMidYMid meet"><polygon points="${pts}" fill="rgba(140,200,255,0.22)" stroke="rgba(210,225,240,0.9)" stroke-width="${sw}" stroke-linejoin="round"/></svg>`;
}

function hexToHue(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 0;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r)      h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function hslToHex(h, s, l) {
  const hp = h / 360;
  const to2 = n => {
    const k = (n + hp * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0');
  };
  return '#' + to2(0) + to2(8) + to2(4);
}

class History {
  constructor(limit = 50) {
    this.past = [];
    this.future = [];
    this.limit = limit;
    this.pending = null;
  }
  _snap(scene) {
    return JSON.stringify({
      bench: scene.bench,
      emitter: {
        count: scene.emitter.count,
        wlMin: scene.emitter.wlMin,
        wlMax: scene.emitter.wlMax,
        raysPerSource: scene.emitter.raysPerSource,
        spreadDeg: scene.emitter.spreadDeg,
        apertureFactor: scene.emitter.apertureFactor,
        disabled: [...(scene.emitter.disabled ?? [])],
      },
      sensorCount: scene.sensorCount,
      elements: scene.elements.map(({ _selected, ...rest }) => rest),
    });
  }
  _restore(scene, snap) {
    const data = JSON.parse(snap);
    scene.bench = data.bench;
    Object.assign(scene.emitter, data.emitter);
    scene.emitter.disabled = new Set(data.emitter.disabled || []);
    scene.sensorCount = data.sensorCount;
    scene.elements = data.elements.map(e => ({ ...e }));
    // Undo/redo can shift emitter/sensor counts — trip caches and
    // resize runtime arrays so consumers don't index past their ends.
    bumpGeneration(scene);
    ensureRuntimeSize(scene);
  }
  begin(scene) {
    if (this.pending !== null) return;
    this.pending = this._snap(scene);
  }
  commit(scene) {
    if (this.pending === null) return;
    const cur = this._snap(scene);
    if (cur !== this.pending) {
      this.past.push(this.pending);
      if (this.past.length > this.limit) this.past.shift();
      this.future.length = 0;
    }
    this.pending = null;
  }
  undo(scene) {
    if (!this.past.length) return false;
    const cur = this._snap(scene);
    this._restore(scene, this.past.pop());
    this.future.push(cur);
    return true;
  }
  redo(scene) {
    if (!this.future.length) return false;
    const cur = this._snap(scene);
    this._restore(scene, this.future.pop());
    this.past.push(cur);
    return true;
  }
}

export class UI {
  constructor(scene, canvas, onChange, onSceneReset) {
    this.scene = scene;
    this.canvas = canvas;
    this.onChange = onChange;
    this.onSceneReset = onSceneReset || (() => {});
    // Optional hook: called before serializing the scene for download.
    // Use it to flush out-of-scene state (e.g. carrier DOM) into the
    // scene object so the saved file matches live state.
    this.beforeSerialize = null;
    this.selected = null;
    this.dragging = null;
    this.history = new History();
    this.bindControls();
    this.bindTools();
    this.bindCanvas();
    this.bindSceneButtons();
    this.bindShortcuts();
    this.refreshEmitterLabels();
  }

  beginEdit() { this.history.begin(this.scene); }
  // Don't commit history while a drag is in flight — otherwise an
  // unrelated event (Shift keyup, slider change) can prematurely seal the
  // pending snapshot and the rest of the drag won't be recorded.
  endEdit()   { if (this.dragging) return; this.history.commit(this.scene); }

  bindShortcuts() {
    const STEP = 5;
    const ROT_STEP = 1 * Math.PI / 180;
    const SIZE_STEP = 8;
    const bumpSize = (el, d) => {
      const _res = ELEMENTS[el.kind]?.resize;
      if (_res) {
        for (const key of _res.keys) {
          const s = _res.scale?.[key] ?? 1;
          el[key] = Math.max(_res.min[key] ?? 0, el[key] + d * s);
        }
      }
    };

    window.addEventListener('keydown', e => {
      if (e.target.matches('input, select, textarea')) return;

      // Don't let UI shortcuts compete with an in-progress mouse drag —
      // lets the user play keyboard notes (or anything else) while moving
      // an element without delete/move/rotate/undo hijacking the gesture.
      if (this.dragging) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (this.history.undo(this.scene)) { this.select(null); this.rebuildSensorReadout(); this.syncControls(); this.onChange(); }
          return;
        }
        if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
          e.preventDefault();
          if (this.history.redo(this.scene)) { this.select(null); this.rebuildSensorReadout(); this.syncControls(); this.onChange(); }
          return;
        }
        if (this.selected && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          const SPIN_STEP = 10 * Math.PI / 180;
          this.beginEdit();
          this.selected.spin = (this.selected.spin || 0) + (e.key === 'ArrowRight' ? SPIN_STEP : -SPIN_STEP);
          this.renderPropPanel();
          this.onChange();
          return;
        }
      }

      // Tab / Shift+Tab: cycle selection through elements.
      if (e.key === 'Tab' && this.scene.elements.length > 0) {
        e.preventDefault();
        const els = this.scene.elements;
        const idx = this.selected ? els.indexOf(this.selected) : -1;
        const next = e.shiftKey
          ? (idx <= 0 ? els.length - 1 : idx - 1)
          : (idx < 0 || idx >= els.length - 1 ? 0 : idx + 1);
        this.select(els[next]);
        return;
      }

      // Escape: deselect.
      if (e.key === 'Escape') {
        this.select(null);
        return;
      }

      if (!this.selected) return;

      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        if (this._deleteBtn) this._deleteBtn.click();
        return;
      }

      const el = this.selected;
      const els = this.scene.elements;
      const sizeKeys = ['size', 'w', 'h', 'radius'];
      let handled = true;
      if (e.shiftKey && e.key === 'ArrowLeft')       { this.beginEdit(); tryMutate(el, els, ['rot','spin'], e => { e.rot -= ROT_STEP; e.spin = 0; }); }
      else if (e.shiftKey && e.key === 'ArrowRight') { this.beginEdit(); tryMutate(el, els, ['rot','spin'], e => { e.rot += ROT_STEP; e.spin = 0; }); }
      else if (e.shiftKey && e.key === 'ArrowUp')    { this.beginEdit(); tryMutate(el, els, sizeKeys, e => bumpSize(e,  SIZE_STEP)); }
      else if (e.shiftKey && e.key === 'ArrowDown')  { this.beginEdit(); tryMutate(el, els, sizeKeys, e => bumpSize(e, -SIZE_STEP)); }
      else if (e.key === 'ArrowLeft')  { this.beginEdit(); tryMutate(el, els, ['x'], e => { e.x -= STEP; }); }
      else if (e.key === 'ArrowRight') { this.beginEdit(); tryMutate(el, els, ['x'], e => { e.x += STEP; }); }
      else if (e.key === 'ArrowUp')    { this.beginEdit(); tryMutate(el, els, ['y'], e => { e.y -= STEP; }); }
      else if (e.key === 'ArrowDown')  { this.beginEdit(); tryMutate(el, els, ['y'], e => { e.y += STEP; }); }
      else handled = false;

      if (handled) {
        e.preventDefault();
        this.renderPropPanel();
        this.onChange();
      }
    });

    window.addEventListener('keyup', e => {
      if (e.key.startsWith('Arrow') || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') this.endEdit();
    });
  }

  // --- Emitter / sensor sliders ---
  bindControls() {
    const map = [
      ['emitter-count', 'count', parseInt],
      ['wl-min', 'wlMin', parseInt],
      ['wl-max', 'wlMax', parseInt],
      ['rays-per', 'raysPerSource', parseInt],
      ['spread', 'spreadDeg', parseInt],
      ['aperture', 'apertureFactor', v => parseInt(v, 10) / 100],
    ];
    const sc = document.getElementById('sensor-count');
    const sensorFactor = () =>
      Math.max(1, parseInt(document.getElementById('sensor-factor').value, 10) || 1);
    const applySync = () => {
      const target = Math.min(parseInt(sc.max, 10),
        Math.max(1, this.scene.emitter.count * sensorFactor()));
      this.scene.sensorCount = target;
      sc.value = target;
      document.getElementById('sensor-count-val').textContent = target;
      this.rebuildSensorReadout();
    };

    for (const [id, key, cast] of map) {
      const el = document.getElementById(id);
      if (key === 'apertureFactor') el.value = Math.round(this.scene.emitter[key] * 100);
      else el.value = this.scene.emitter[key];
      el.addEventListener('input', () => {
        this.beginEdit();
        this.scene.emitter[key] = cast(el.value, 10);
        if (key === 'count') {
          this.scene.emitter.disabled.clear();
          if (document.getElementById('sensor-sync').checked) applySync();
          // Shape change: notify caches via generation bump and resize
          // runtime arrays. Without this, the tracer's per-element
          // pools, edge-memory rows, and wlPerSource bands stay sized
          // for the previous count and consumers read past their ends.
          bumpGeneration(this.scene);
          ensureRuntimeSize(this.scene);
        }
        this.refreshEmitterLabels();
        this.onChange();
      });
      el.addEventListener('change', () => this.endEdit());
    }
    sc.value = this.scene.sensorCount;
    const factorIn = document.getElementById('sensor-factor');
    const syncIn = document.getElementById('sensor-sync');
    const syncFactorRow = () => {
      const on = syncIn.checked;
      const row = document.getElementById('sensor-factor-row');
      row.classList.toggle('row-disabled', !on);
      factorIn.disabled = !on;
    };
    syncFactorRow();

    sc.addEventListener('input', () => {
      this.beginEdit();
      this.scene.sensorCount = parseInt(sc.value, 10);
      document.getElementById('sensor-count-val').textContent = sc.value;
      // Manual change overrides sync.
      syncIn.checked = false;
      syncFactorRow();
      // Shape change: see emitter-count handler above.
      bumpGeneration(this.scene);
      this.onChange();
      this.rebuildSensorReadout();
    });
    sc.addEventListener('change', () => this.endEdit());

    // When sync is turned on, snap sensor count to source × factor; either
    // way, refresh the factor-row enabled state.
    syncIn.addEventListener('change', e => {
      syncFactorRow();
      if (!e.target.checked) return;
      this.beginEdit();
      applySync();
      this.endEdit();
      this.onChange();
    });

    // Factor slider re-syncs immediately if sync is on.
    factorIn.addEventListener('input', () => {
      document.getElementById('sensor-factor-val').textContent = factorIn.value;
      if (!syncIn.checked) return;
      this.beginEdit();
      applySync();
      this.onChange();
    });
    factorIn.addEventListener('change', () => this.endEdit());
  }

  syncControls() {
    const ids = ['emitter-count', 'wl-min', 'wl-max', 'rays-per', 'spread', 'aperture', 'sensor-count'];
    document.getElementById('emitter-count').value = this.scene.emitter.count;
    document.getElementById('wl-min').value = this.scene.emitter.wlMin;
    document.getElementById('wl-max').value = this.scene.emitter.wlMax;
    document.getElementById('rays-per').value = this.scene.emitter.raysPerSource;
    document.getElementById('spread').value = this.scene.emitter.spreadDeg;
    document.getElementById('aperture').value = Math.round((this.scene.emitter.apertureFactor ?? 0.01) * 100);
    document.getElementById('sensor-count').value = this.scene.sensorCount;
    this.refreshEmitterLabels();
    for (const id of ids) {
      document.getElementById(id).dispatchEvent(new Event('change'));
    }
  }
  refreshEmitterLabels() {
    document.getElementById('emitter-count-val').textContent = this.scene.emitter.count;
    document.getElementById('wl-min-val').textContent = this.scene.emitter.wlMin;
    document.getElementById('wl-max-val').textContent = this.scene.emitter.wlMax;
    document.getElementById('rays-per-val').textContent = this.scene.emitter.raysPerSource;
    document.getElementById('spread-val').textContent = this.scene.emitter.spreadDeg;
    document.getElementById('aperture-val').textContent = (this.scene.emitter.apertureFactor ?? 0.01).toFixed(2);
    document.getElementById('sensor-count-val').textContent = this.scene.sensorCount;
  }

  // --- Tool palette ---
  bindTools() {
    const place = kind => {
      this.beginEdit();
      let cx = this.scene.bench.w / 2;
      let cy = this.scene.bench.h / 2;
      const el = makeElement(kind, cx, cy);
      // No-overlap: spiral outward from center to find a free position.
      if (document.getElementById('no-overlap').checked) {
        this.scene.elements.push(el);
        const step = 40;
        let found = !overlapsAny(el, this.scene.elements);
        if (!found) {
          for (let r = 1; r < 20 && !found; r++) {
            for (let dx = -r; dx <= r && !found; dx++) {
              for (let dy = -r; dy <= r && !found; dy++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
                el.x = cx + dx * step;
                el.y = cy + dy * step;
                if (el.x > 60 && el.x < this.scene.bench.w - 20 &&
                    el.y > 20 && el.y < this.scene.bench.h - 20 &&
                    !overlapsAny(el, this.scene.elements)) {
                  found = true;
                }
              }
            }
          }
        }
        if (!found) { el.x = cx; el.y = cy; } // fallback to center
        // Element already pushed above.
      } else {
        this.scene.elements.push(el);
      }
      this.select(el);
      this.endEdit();
      this.onChange();
    };

    // Delete action button (not a mode — acts immediately on selected).
    this._deleteBtn = document.getElementById('delete-btn');
    this._deleteBtn.addEventListener('click', () => {
      if (!this.selected) return;
      this.beginEdit();
      const idx = this.scene.elements.indexOf(this.selected);
      this.scene.elements = this.scene.elements.filter(e => e !== this.selected);
      // Select next element if any, preferring the one after the deleted.
      const next = this.scene.elements[Math.min(idx, this.scene.elements.length - 1)];
      this.select(next || null);
      this.endEdit();
      this.onChange();
    });

    // Add split-button: left = place last-used kind, right (▾) = dropdown.
    const LABEL_BY_KIND = {};
    for (const [k, v] of Object.entries(ELEMENTS)) LABEL_BY_KIND[k] = v.label;
    const addBtn = document.getElementById('add-btn');
    const addOptions = document.getElementById('add-options');
    const addMenu = document.getElementById('add-menu');
    let lastAddKind = 'prism';
    const setLastKind = kind => {
      lastAddKind = kind;
      addBtn.innerHTML = buildElementIcon(kind) + '<span class="add-label"> ' + (LABEL_BY_KIND[kind] || kind) + '</span>';
    };
    setLastKind('prism');
    addBtn.addEventListener('click', () => { place(lastAddKind); });
    const closeMenu = () => addMenu.classList.remove('open');
    addOptions.addEventListener('click', e => {
      e.stopPropagation();
      if (addMenu.classList.contains('open')) { closeMenu(); return; }
      document.querySelectorAll('.tool-menu.open, .options-menu.open').forEach(m => m.classList.remove('open'));
      // Reparent to <body> so older mobile Chrome doesn't clip the
      // dropdown to the toolbar's overflow:auto scroll rect. Idempotent;
      // modern browsers are unaffected because `position: fixed` already
      // escaped the clip for them.
      if (addMenu.parentElement !== document.body) document.body.appendChild(addMenu);
      const r = addOptions.getBoundingClientRect();
      addMenu.style.top = `${r.bottom + 4}px`;
      addMenu.style.left = `${Math.max(4, r.right - 180)}px`;
      addMenu.classList.add('open');
    });
    addMenu.querySelectorAll('.tool-menu-item').forEach(item => {
      const kind = item.dataset.tool;
      // "Auto" is an action, not a placeable kind — no icon, dedicated handler.
      if (kind === 'auto') {
        item.addEventListener('click', () => { this.autoPlace(); closeMenu(); });
        return;
      }
      item.insertAdjacentHTML('afterbegin', buildElementIcon(kind));
      item.addEventListener('click', () => {
        setLastKind(kind);
        place(kind);
        closeMenu();
      });
    });
    document.addEventListener('click', e => {
      if (addMenu.classList.contains('open') && !addMenu.contains(e.target) && e.target !== addOptions) {
        closeMenu();
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && addMenu.classList.contains('open')) closeMenu();
    });
  }

  // --- Canvas pointer events ---
  bindCanvas() {
    const c = this.canvas;
    this.pointers = new Map();
    c.addEventListener('pointerdown', e => this.onDown(e));
    c.addEventListener('pointermove', e => this.onMove(e));
    c.addEventListener('pointerup', e => this.onUp(e));
    c.addEventListener('pointercancel', e => this.onUp(e));
    c.addEventListener('contextmenu', e => e.preventDefault());
  }

  _captureBaseSize(el) {
    return { size: el.size, w: el.w, h: el.h, radius: el.radius };
  }
  _applyPinchScale(el, base, s) {
    const p = ELEMENTS[el.kind]?.pinch ?? ELEMENTS[el.kind]?.resize;
    if (p) {
      for (const key of p.keys) {
        el[key] = Math.max(p.min[key] ?? 0, base[key] * s);
      }
    }
  }
  _applyEmitterToggle(sIdx, solo) {
    const n = this.scene.emitter.count;
    const dis = this.scene.emitter.disabled || (this.scene.emitter.disabled = new Set());
    this.beginEdit();
    if (solo) {
      const onlyOn = !dis.has(sIdx) && dis.size === n - 1;
      dis.clear();
      if (!onlyOn) {
        for (let i = 0; i < n; i++) if (i !== sIdx) dis.add(i);
      }
    } else {
      if (dis.has(sIdx)) dis.delete(sIdx); else dis.add(sIdx);
    }
    this.endEdit();
    this.onChange();
  }
  _startPinchIfTwoPointers() {
    if (this.pointers.size !== 2 || !this.selected) return;
    const pts = [...this.pointers.values()];
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    const dist = Math.hypot(dx, dy) || 1;
    const angle = Math.atan2(dy, dx);
    this.beginEdit();
    this.dragging = {
      type: 'pinch',
      startDist: dist,
      startAngle: angle,
      startRot: this.selected.rot,
      baseSize: this._captureBaseSize(this.selected),
    };
  }

  canvasToBench(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { w: bw, h: bh } = this.scene.bench;
    const x = (clientX - rect.left) / rect.width * bw;
    const y = (clientY - rect.top) / rect.height * bh;
    return { x, y };
  }

  hitTestElement(x, y) {
    // First pass: exact polygon hit.
    for (let i = this.scene.elements.length - 1; i >= 0; i--) {
      const el = this.scene.elements[i];
      const { polygon } = worldEdges(el);
      if (pointInPolygon(polygon, x, y)) return el;
    }
    // Second pass: proximity hit — within 15 bench pixels of the
    // element center. Makes small/thin elements easier to grab,
    // especially on touch screens.
    const margin = 15;
    for (let i = this.scene.elements.length - 1; i >= 0; i--) {
      const el = this.scene.elements[i];
      const dx = x - el.x, dy = y - el.y;
      if (dx * dx + dy * dy < margin * margin) return el;
    }
    return null;
  }

  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this.canvasToBench(e.clientX, e.clientY);
    this.pointers.set(e.pointerId, { x, y });
    // Second simultaneous pointer: start pinch (scale + rotate).
    // If nothing is selected yet, find the element whose center is
    // closest to the midpoint of the two fingers — users typically
    // place fingers *around* a small object, not on it.
    if (this.pointers.size === 2) {
      if (!this.selected) {
        const pts = [...this.pointers.values()];
        const mx = (pts[0].x + pts[1].x) / 2;
        const my = (pts[0].y + pts[1].y) / 2;
        const span = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        let bestEl = null, bestDist = Infinity;
        for (const el of this.scene.elements) {
          const d = Math.hypot(mx - el.x, my - el.y);
          // Element center must be within half the finger span of the midpoint.
          if (d < span * 0.6 && d < bestDist) { bestDist = d; bestEl = el; }
        }
        if (bestEl) {
          this.beginEdit();
          this.select(bestEl);
        }
      }
      if (this.selected) this._startPinchIfTwoPointers();
      return;
    }

    // Click on left-wall tick area toggles that source. Shift-click or long
    // press (≥450 ms) solos it.
    if (x >= 0 && x <= 30) {
      const n = this.scene.emitter.count;
      const sIdx = Math.max(0, Math.min(n - 1, n - 1 - Math.floor(y / (this.scene.bench.h / n))));
      if (e.shiftKey) {
        this._applyEmitterToggle(sIdx, true);
        return;
      }
      const pending = { pointerId: e.pointerId, sIdx, x, y, applied: false, timer: 0 };
      this.emitterPending = pending;
      // Identity check inside the closure: a stale timer from a previous
      // press must not fire against the current pending object.
      pending.timer = setTimeout(() => {
        if (this.emitterPending === pending) {
          this._applyEmitterToggle(sIdx, true);
          pending.applied = true;
        }
      }, 450);
      return;
    }

    const hit = this.hitTestElement(x, y);
    if (hit) {
      this.beginEdit();
      this.select(hit);
      if (e.shiftKey || e.button === 2) {
        const a = Math.atan2(y - hit.y, x - hit.x);
        this.dragging = { type: 'rotate', startAngle: a, startRot: hit.rot };
      } else {
        this.dragging = { type: 'move', dx: hit.x - x, dy: hit.y - y };
      }
    } else {
      this.select(null);
      // Empty-bench click: register a smoke swirl source so the touch
      // stirs the fog. Clicks on elements or emitter ticks don't qualify
      // — objects emit their own displacement source already, and it
      // read as noisy to add a swirl on top.
      this._swirlingPointers ??= new Set();
      this._swirlingPointers.add(e.pointerId);
      window.chromavox?.renderer?.pushPointerSource?.(e.pointerId, x, y);
    }
  }

  onMove(e) {
    const { x, y } = this.canvasToBench(e.clientX, e.clientY);
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x, y });
      // Keep the smoke swirl stuck to the moving finger/mouse — only
      // for pointers that started as empty-bench swirls.
      if (this._swirlingPointers?.has(e.pointerId)) {
        window.chromavox?.renderer?.pushPointerSource?.(e.pointerId, x, y);
      }
    }
    // Cancel a pending emitter long-press if the pointer drifts too far.
    if (this.emitterPending && this.emitterPending.pointerId === e.pointerId) {
      const dx = x - this.emitterPending.x, dy = y - this.emitterPending.y;
      if (dx * dx + dy * dy > 18 * 18) {
        clearTimeout(this.emitterPending.timer);
        this.emitterPending = null;
      }
      return;
    }
    if (!this.dragging || !this.selected) return;
    if (this.dragging.type === 'pinch' && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      const dist = Math.hypot(dx, dy) || 1;
      const angle = Math.atan2(dy, dx);
      const scale = dist / this.dragging.startDist;
      const prevRot = this.selected.rot;
      const prevSize = this._captureBaseSize(this.selected);
      this.selected.rot = this.dragging.startRot + (angle - this.dragging.startAngle);
      this.selected.spin = 0;
      this._applyPinchScale(this.selected, this.dragging.baseSize, scale);
      if (document.getElementById('no-overlap').checked &&
          overlapsAny(this.selected, this.scene.elements)) {
        this.selected.rot = prevRot;
        Object.assign(this.selected, prevSize);
      }
      this.renderPropPanel();
      this.onChange();
    } else if (this.dragging.type === 'move') {
      const prevX = this.selected.x, prevY = this.selected.y;
      this.selected.x = x + this.dragging.dx;
      this.selected.y = y + this.dragging.dy;
      if (document.getElementById('no-overlap').checked &&
          overlapsAny(this.selected, this.scene.elements)) {
        this.selected.x = prevX;
        this.selected.y = prevY;
      }
      this.onChange();
    } else if (this.dragging.type === 'rotate') {
      const prevRot = this.selected.rot;
      const a = Math.atan2(y - this.selected.y, x - this.selected.x);
      this.selected.rot = this.dragging.startRot + (a - this.dragging.startAngle);
      this.selected.spin = 0;
      if (document.getElementById('no-overlap').checked &&
          overlapsAny(this.selected, this.scene.elements)) {
        this.selected.rot = prevRot;
      }
      this.renderPropPanel();
      this.onChange();
    }
  }

  onUp(e) {
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    this.pointers.delete(e.pointerId);
    // Let the smoke swirl decay from here — but only for pointers that
    // actually created one (empty-bench clicks).
    if (this._swirlingPointers?.delete(e.pointerId)) {
      window.chromavox?.renderer?.releasePointerSource?.(e.pointerId);
    }
    // Emitter long-press / click resolution.
    if (this.emitterPending && this.emitterPending.pointerId === e.pointerId) {
      clearTimeout(this.emitterPending.timer);
      if (!this.emitterPending.applied) {
        this._applyEmitterToggle(this.emitterPending.sIdx, false);
      }
      this.emitterPending = null;
      return;
    }
    // End pinch only when fewer than two pointers remain.
    if (this.dragging?.type === 'pinch' && this.pointers.size < 2) {
      this.dragging = null;
      this.endEdit();
      return;
    }
    this.dragging = null;
    this.endEdit();
  }

  select(el) {
    if (this.selected) this.selected._selected = false;
    this.selected = el;
    if (el) el._selected = true;
    if (this._deleteBtn) this._deleteBtn.disabled = !el;
    this.renderPropPanel();
    this.onChange();
  }

  // --- Property panel ---
  renderPropPanel() {
    const panel = document.getElementById('prop-panel');
    panel.innerHTML = '';
    const el = this.selected;
    if (!el) { panel.innerHTML = '<em>No selection</em>'; return; }

    const addRow = (label, input, valText) => {
      const row = document.createElement('div');
      row.className = 'prop';
      const lab = document.createElement('label');
      lab.textContent = label;
      if (valText !== undefined) {
        const vs = document.createElement('span');
        vs.className = 'prop-val';
        vs.textContent = ' ' + valText;
        lab.appendChild(vs);
      }
      row.appendChild(lab);
      row.appendChild(input);
      panel.appendChild(row);
      return lab; // return label so callers can update the value span
    };

    const def = ELEMENTS[el.kind];
    if (!def) return;

    const title = document.createElement('div');
    title.innerHTML = `<strong>${def.label}</strong>`;
    panel.appendChild(title);

    // Material dropdown (first, so the user sees what they're editing).
    const matType = MATERIALS[def.material]?.type || 'dielectric';
    const matList = def.materials
      || Object.keys(MATERIALS).filter(k => MATERIALS[k].type === matType);
    const sel = document.createElement('select');
    for (const k of matList) {
      const opt = document.createElement('option');
      opt.value = k; opt.textContent = k;
      if (k === el.material) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      this.beginEdit(); el.material = sel.value; this.endEdit(); this.onChange();
    });
    addRow('Material', sel);

    // Rotation
    const rot = document.createElement('input');
    rot.type = 'range'; rot.min = -180; rot.max = 180; rot.step = 1;
    const rotDeg = () => Math.round(el.rot * 180 / Math.PI);
    rot.value = rotDeg();
    const rotLab = addRow('Rotation', rot, rotDeg() + '°');
    const updateRotVal = () => {
      const vs = rotLab.querySelector('.prop-val');
      if (vs) vs.textContent = ' ' + rotDeg() + '°';
    };
    rot.addEventListener('input', () => {
      this.beginEdit();
      const newRot = parseFloat(rot.value) * Math.PI / 180;
      if (!tryMutate(el, this.scene.elements, ['rot', 'spin'], e => { e.rot = newRot; e.spin = 0; })) {
        rot.value = rotDeg();
      }
      updateRotVal();
      this.onChange();
    });
    rot.addEventListener('change', () => this.endEdit());

    // Continuous rotation (degrees per second).
    const spinRow = document.createElement('div');
    spinRow.style.display = 'flex';
    spinRow.style.gap = '4px';
    const spinInput = document.createElement('input');
    spinInput.type = 'range';
    spinInput.min = -180; spinInput.max = 180; spinInput.step = 1;
    spinInput.style.flex = '1';
    const spinDeg = () => Math.round((el.spin || 0) * 180 / Math.PI);
    spinInput.value = spinDeg();
    const spinResetBtn = document.createElement('button');
    spinResetBtn.textContent = '×';
    spinResetBtn.title = 'Stop spinning';
    spinRow.appendChild(spinInput);
    spinRow.appendChild(spinResetBtn);
    const spinLab = addRow('Spin', spinRow, spinDeg() + '°/s');
    const updateSpinVal = () => {
      const vs = spinLab.querySelector('.prop-val');
      if (vs) vs.textContent = ' ' + spinDeg() + '°/s';
    };
    spinInput.addEventListener('input', () => {
      this.beginEdit();
      const newSpin = parseFloat(spinInput.value) * Math.PI / 180;
      if (!tryMutate(el, this.scene.elements, ['spin'], e => { e.spin = newSpin; })) {
        spinInput.value = spinDeg();
      }
      updateSpinVal();
      this.onChange();
    });
    spinInput.addEventListener('change', () => this.endEdit());
    spinResetBtn.addEventListener('click', () => {
      this.beginEdit();
      el.spin = 0;
      this.endEdit();
      spinInput.value = 0;
      updateSpinVal();
      this.onChange();
    });

    // --- Schema-driven property sliders ---
    // Material color hints for the color picker default.
    const MATERIAL_COLOR_HINT = {
      crown: '#8ccbff', flint: '#ffb3cc', fused: '#d9ffe6', water: '#80bfff',
      diamond: '#ffffe6', hyper: '#ff80ff', slowGlass: '#9b80e0',
      mirror: '#bfccff', 'mirror-red': '#ff6666',
      'mirror-green': '#66ff6e', 'mirror-blue': '#6670ff',
    };

    // Generate sliders from schema props (skip rot — handled above).
    for (const [key, desc] of Object.entries(def.props)) {
      if (key === 'rot') continue; // already rendered as Rotation row
      if (key === 'spin') continue; // already rendered as Spin row

      if (desc.type === 'color') {
        // Color picker + hue slider + reset.
        const colorRow = document.createElement('div');
        colorRow.style.display = 'flex'; colorRow.style.gap = '4px';
        const colorInput = document.createElement('input');
        colorInput.type = 'color'; colorInput.style.flex = '1';
        const initialColor = el.color || MATERIAL_COLOR_HINT[el.material] || '#cccccc';
        colorInput.value = initialColor;
        const resetBtn = document.createElement('button');
        resetBtn.textContent = '×'; resetBtn.title = 'Reset to material default';
        colorRow.appendChild(colorInput); colorRow.appendChild(resetBtn);
        addRow('Color', colorRow);

        const hueInput = document.createElement('input');
        hueInput.type = 'range'; hueInput.min = 0; hueInput.max = 360; hueInput.step = 1;
        hueInput.value = hexToHue(initialColor);
        hueInput.style.background = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';
        addRow('Hue', hueInput);

        colorInput.addEventListener('input', () => {
          this.beginEdit(); el.color = colorInput.value;
          hueInput.value = hexToHue(el.color); this.onChange();
        });
        colorInput.addEventListener('change', () => this.endEdit());
        hueInput.addEventListener('input', () => {
          this.beginEdit();
          const hex = hslToHex(parseInt(hueInput.value, 10), 1, 0.5);
          el.color = hex; colorInput.value = hex; this.onChange();
        });
        hueInput.addEventListener('change', () => this.endEdit());
        resetBtn.addEventListener('click', () => {
          this.beginEdit(); delete el.color; this.endEdit();
          const fb = MATERIAL_COLOR_HINT[el.material] || '#cccccc';
          colorInput.value = fb; hueInput.value = hexToHue(fb); this.onChange();
        });
        continue;
      }

      // Numeric slider.
      const hasConvert = !!desc.toInternal;
      const uiVal = () => hasConvert ? desc.fromInternal(el[key] || 0) : (el[key] ?? desc.default ?? 0);
      const fmtVal = v => desc.display ? desc.display(v) : String(Math.round(v * 100) / 100);

      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = desc.min; inp.max = desc.max; inp.step = desc.step || 1;
      inp.value = uiVal();

      let rowLab;
      const updateVal = () => {
        const vs = rowLab?.querySelector('.prop-val');
        if (vs) vs.textContent = ' ' + fmtVal(uiVal());
      };

      // All numeric sliders get a × reset button. Target is the
      // schema default if present; otherwise 0 (keeps DELAY's null
      // default behaving like the old "reset to zero").
      const resetUi = desc.default == null
        ? 0
        : (hasConvert ? desc.fromInternal(desc.toInternal(desc.default)) : desc.default);
      const resetInternal = hasConvert
        ? (desc.default == null ? desc.toInternal(0) : desc.toInternal(resetUi))
        : (desc.default == null ? 0 : desc.default);

      const row = document.createElement('div');
      row.style.display = 'flex'; row.style.gap = '4px';
      inp.style.flex = '1';
      const btn = document.createElement('button');
      btn.textContent = '×'; btn.title = 'Reset';
      row.appendChild(inp); row.appendChild(btn);
      btn.addEventListener('click', () => {
        this.beginEdit();
        el[key] = resetInternal;
        this.endEdit();
        inp.value = resetUi;
        updateVal();
        this.onChange();
      });
      rowLab = addRow(desc.label || key, row, fmtVal(uiVal()));

      inp.addEventListener('input', () => {
        this.beginEdit();
        const v = parseFloat(inp.value);
        const intVal = hasConvert ? desc.toInternal(v) : v;
        if (!tryMutate(el, this.scene.elements, [key], e => { e[key] = intVal; })) {
          inp.value = uiVal();
        }
        updateVal();
        this.onChange();
      });
      inp.addEventListener('change', () => this.endEdit());
    }

  }

  // --- Save / load / clear ---
  bindSceneButtons() {
    document.getElementById('save').addEventListener('click', () => {
      if (this.beforeSerialize) this.beforeSerialize();
      const text = serializeScene(this.scene);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filenameFromTitle(autoTitle(this.scene));
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const fileInput = document.getElementById('file-input');
    document.getElementById('load').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      const text = await f.text();
      try {
        this.beginEdit();
        const scene = deserializeScene(text);
        Object.assign(this.scene, scene);
        window.dispatchEvent(new Event('resize'));
        this.syncControls();
        this.select(null);
        this.rebuildSensorReadout();
        this.endEdit();
        this.onSceneReset();
        this.onChange();
      } catch (err) {
        alert('Load failed: ' + err.message);
      }
      fileInput.value = '';
    });

    document.getElementById('clear').addEventListener('click', () => {
      this.beginEdit();
      const fresh = createScene();
      Object.assign(this.scene, fresh);
      this.select(null);
      this.syncControls();
      this.rebuildSensorReadout();
      this.endEdit();
      this.onSceneReset();
      this.onChange();
      try {
        localStorage.removeItem('chromavox-scene');
        localStorage.removeItem('chromavox-ui');
        localStorage.removeItem('chromavox-song');
      } catch {}
    });

    this.bindPresets();

    // Per-side drawer toggles. Simple on/off each.
    const app = document.getElementById('app');
    document.getElementById('left-toggle').addEventListener('click', () => {
      app.classList.toggle('show-left');
    });
    document.getElementById('right-toggle').addEventListener('click', () => {
      app.classList.toggle('show-right');
      this.onChange(); // force readout redraw when panel slides in
    });
  }

  async bindPresets() {
    const sel = document.getElementById('preset-select');
    try {
      const list = await (await fetch('presets/index.json')).json();
      for (const p of list) {
        const opt = document.createElement('option');
        opt.value = p.file; opt.textContent = p.label;
        sel.appendChild(opt);
      }
    } catch {
      sel.disabled = true;
      return;
    }
    sel.addEventListener('change', async () => {
      const file = sel.value;
      if (!file) return;
      try {
        this.beginEdit();
        const text = await (await fetch('presets/' + file)).text();
        const scene = deserializeScene(text);
        Object.assign(this.scene, scene);
        window.dispatchEvent(new Event('resize'));
        this.syncControls();
        this.select(null);
        this.rebuildSensorReadout();
        this.endEdit();
        this.onSceneReset();
        this.onChange();
      } catch (err) {
        alert('Preset load failed: ' + err.message);
      }
      sel.value = '';
    });
  }

  // Sensor readout rebuild (when sensor count changes).
  rebuildSensorReadout() {
    const host = document.getElementById('sensor-readout');
    host.innerHTML = '';
    // One canvas for the full sensor stack. Renderer writes directly
    // into the backing ImageData (see updateReadout). Internal size is
    // 128 × (sensorCount * ROW_H); CSS stretches to the panel.
    const c = document.createElement('canvas');
    c.id = 'sensor-readout-canvas';
    const rowH = 14;
    c.width = 128;
    c.height = Math.max(1, this.scene.sensorCount * rowH);
    host.appendChild(c);
  }

  // Exposed for main.js spin enforcement.
  elementsOverlap(el, elements) { return overlapsAny(el, elements); }

  // "Auto" placement: analyze the current song + scene and add one
  // interesting element positioned to interact optically with existing
  // ones while avoiding the melody band. May also tempo-sync-spin one
  // existing element if nothing was spinning yet. Undo collapses the
  // whole operation into a single history step.
  autoPlace() {
    const song = window.chromavox?.songPlayer?.song ?? null;
    const result = autoPlace(this.scene, song);
    if (result.error) {
      window.chromavox?.statusToast?.('Auto: ' + result.error);
      return;
    }
    this.beginEdit();
    for (const adj of result.adjustments) {
      const target = this.scene.elements.find(e => e.id === adj.id);
      if (target) target.spin = adj.spin;
    }
    this.scene.elements.push(result.element);
    this.select(result.element);
    this.endEdit();
    this.onChange();
    if (result.label) {
      window.chromavox?.statusToast?.('Auto: ' + result.label);
    }
  }
}
