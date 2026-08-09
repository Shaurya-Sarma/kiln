# Kiln — build log

Running technical log of every decision made while building Kiln, in order. This is the
raw material for the final technical writeup. Newest entries at the bottom.

---

## 1. Repo shape: one engine, two thin shells

Kiln has to render in two very different hosts: a normal website (the playground) and
the sandboxed iframe of a Figma plugin. So the repo is a pnpm workspace with three
packages:

- `packages/engine` — everything real: profile parsing, lathe geometry, glaze materials,
  the firing simulation, seeded randomness. No DOM assumptions beyond a canvas.
- `packages/playground` — Vite site wrapping the engine (the public demo).
- `packages/figma-plugin` — the thin Figma wrapper (reads the selected pen-tool curve,
  hosts the engine in the plugin iframe, writes rendered images back to the canvas).

Decisions worth remembering:
- **Engine exports raw TS source** (`"exports": "./src/index.ts"`). Both consumers
  compile TypeScript themselves (Vite / esbuild), so building the engine separately
  would add a build step for zero benefit. Only valid because we control all consumers.
- **`three` is a peerDependency of the engine.** The engine must share the host app's
  copy of three — two copies would double the bundle and break `instanceof` across the
  boundary.
- **`noUncheckedIndexedAccess`** is on: profile code does a lot of `points[i-1]`
  neighbor access, and this flag turns "index might be out of bounds" into a compile
  error instead of a runtime crash.
- TypeScript 7, three r185, Vite 8 (latest stable at build time, Aug 2026).

## 2. The engine: a pot is a 2D curve, spun

Core data type: a vessel **profile** — `(radius, height)` points, foot → rim, the exact
cross-section a potter draws. Three transforms live in `engine/src/profile.ts`:

- **Catmull-Rom smoothing** — a spline that passes *through* every input point (unlike a
  bezier, whose control points pull from outside). A handful of pen-tool points becomes a
  silky wall, the way a rib smooths clay.
- **Arc-length resampling** — pen-tool points are unevenly spaced; texturing by raw point
  index would stretch and bunch glaze patterns. We re-pick N samples at *equal distances
  along the curve*, so `v = 0.2` always means "20% of the way up the actual surface."
- **Concavity → pooling** — discrete second derivative of radius: where neighbors stick
  out further than a point, the wall is a groove, and molten glaze pools thicker there.
  Computed once, baked onto the mesh as an `aPooling` vertex attribute (mapped via uv.y
  so it survives any vertex-ordering change in three).

Seeded randomness (`rng.ts`): mulberry32, a 4-line deterministic PRNG. Every firing gets
one seed; same seed = identical firing. That's what makes a firing an *identity*
("firing № 0417") you can store on a Figma node and re-open — and why `Math.random` is
banned everywhere except drawing a new seed.

## 3. Renderer decision: WebGPU-first via TSL

`WebGPURenderer` from `three/webgpu`, with its automatic WebGL2 fallback. Custom
materials can't be raw GLSL strings on this renderer — they're written in **TSL** (Three
Shading Language): shader logic as node expressions in TypeScript, compiled to WGSL on
WebGPU and GLSL on the fallback. One material, both APIs — which matters because the
Figma plugin iframe may or may not expose WebGPU.

## 4. Celadon: one idea, executed carefully

`finalColor = mix(thinColor, pooledColor, pooling)` — pooling = baked groove concavity
+ a boost near the foot (glaze runs downhill). Clearcoat at 1.0 gives the wet-glass skin
(glaze IS glass). The atmosphere toggle swaps palettes, encoding real chemistry: the
same iron oxide fires jade-green in reduction, honey-amber in oxidation.

**Milestone: first light.** Vase preset rendered with visible pooling at the neck groove
on the first run — profile math → vertex attribute → TSL shader, end to end.
