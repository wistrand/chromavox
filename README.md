# Chromavox

2D optics raycaster in the browser. Emitters on the left, sensors on the
right, placeable dielectric and mirror elements in between. Real Snell
refraction with Cauchy wavelength-dependent index.

Plain HTML + ES modules + WebGL2. No dependencies.

## Run

```
npm start          # node serve.js, port 8005
node serve.js 9000 # override port
```

ES modules require HTTP, not `file://`.

## Layout

- `docs/index.html`, `docs/style.css` — shell and panels.
- `docs/spectrum.js` — wavelength→RGB, Cauchy `n(λ)=A+B/λ²`, glass presets.
- `docs/scene.js` — data model, polygon geometry, JSON save/load.
- `docs/raytracer.js` — CPU tracer, per-frame vertex buffer, sensor bins.
- `docs/renderer.js` — WebGL2 passes: additive rays, alpha overlay.
- `docs/ui.js` — pointer input, property panel, save/load.
- `docs/main.js` — wiring and dirty-flag render loop.
- `serve.js` — zero-dep static server.
