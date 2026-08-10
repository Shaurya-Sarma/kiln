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

## 5. Crystalline + tenmoku: patterns are textures, not per-pixel math

Celadon is pure per-pixel math, but spherulites and oil spots are *patterns* — so they're
synthesized on a 2D canvas at firing time from the firing's seeded RNG, then sampled by
the material. No image files anywhere; every pattern grows from the seed.

- **Crystalline**: seed scatters nucleation sites; hold-time at the growth temperature
  sets bloom radius (saturating — real diffusion kinetics); each spherulite = two layers
  of tapered needle strokes + a glassy halo (crystals rob surrounding glaze of colorant)
  + a bright nucleus. 2048² canvas.
- **Tenmoku**: base color is math (iron black breaking to rust where pooling is negative
  — ridges and rim); oil spots are a seeded texture biased toward the top (bubbles rise),
  blended by alpha.

## 6. Three bugs, one night — all writeup material

1. **Moiré rings**: 900 hard 1px mottle dots aliased under minification on the curved
   wall. Fix: soft radial-gradient patches + anisotropic filtering + 2048² texture.
2. **Un-solving the library's solved problem**: called `computeVertexNormals()` on a
   `LatheGeometry`, overwriting its seam-averaged normals with one-sided ones → vertical
   lighting line. The library was right; the "cleanup" call was the bug.
3. **The wrap-seam purity bug** (the good one): blooms near the texture's left/right
   edge are drawn 2–3 times (wrapped copies) for seam continuity — but the draw function
   called `rand()` internally, so each copy drew *different needles*, painting a hard
   break along the seam. Diagnosed with a debug view that rolls the texture by half its
   width so the seam lands center-screen. **Rule: a tiling texture must be a pure
   function of a precomputed plan; randomness inside the draw call breaks wrapping.**

## 7. Shareable firings

The playground keeps full state in the URL (`?form=bottle&glaze=crystalline&
atmosphere=reduction&hold=75&seed=417`) — a link reproduces the exact pot, because the
seed replays the randomness. Also the test harness: headless-Chrome screenshots of any
state without UI automation.

## 8. The Figma plugin: two programs, one typed conversation

A plugin is two programs that can't touch each other's worlds: the **sandbox** (document
access, no DOM, no rendering) and the **UI iframe** (full browser, no document access).
Kiln keeps the sandbox thin — read the selected curve, place exported images — and runs
the whole engine in the iframe. The entire postMessage conversation is written down as
discriminated unions in `messages.ts`, imported by both sides, so the compiler keeps two
separately-built programs honest with each other.

- **Pen tool → profile** (`profile-from-figma.ts`): Figma exposes vector geometry as
  SVG-ish path text (absolute M/L/C/Q/Z only). We flatten béziers, then apply the
  potter's interpretation: leftmost point = the wheel's axis, y flipped (Figma is
  y-down), normalized to standard pot height, foot-first. Pure functions — unit-tested
  in plain Node before ever touching Figma. Unsupported input throws → preset fallback,
  so the plugin is never unusable.
- **Exports**: render → canvas readback → PNG bytes → `figma.createImage` → rectangle
  with an image fill. Every exported pot carries its full firing settings in
  `setPluginData` plus a "Re-fire in Kiln" relaunch button — a placed render is a live
  document you can re-open, not a dead image.
- **Test tiles ×9**: nine seeds of the current setup placed as a grid frame. Potters
  explore glazes with test-tile grids; designers explore options with variant grids —
  same artifact, and the reason this is the flagship export.
- **Honest tradeoff**: the plugin pins the WebGL2 backend (`forceWebGL: true`) because
  PNG readback must happen in the same task as the render — rock-solid on WebGL2,
  finicky on WebGPU swapchains. Same TSL materials compile to GLSL automatically; the
  playground stays WebGPU-first.
- **Build**: esbuild twice + inline the UI bundle into one HTML file (the iframe has a
  null origin — no external scripts, three.js and all). Escape `</script>` in the
  bundle or the inline tag terminates early.
- **Typing war story**: the UI typecheck (which compiles the engine too) caught TSL
  errors Vite never surfaced — `attribute()`'s typings widen the node type to `string`.
  Fix: pin the generic (`attribute<"float">("aPooling", "float")`).

## 9. Design pass: "a potter's studio notebook in a gallery"

Synthesized from five reference sites (noartmusic, namaha.healthcare,
estelle-jozwicki, valeran.eu, serotoninn), in the builder's preference order:

- From **noart**: the hand×technical tension — a soft serif voice against a workshop
  monospace (labels, values, firing numbers), plus crop-mark corner ticks.
- From **namaha/estelle**: gallery warmth — the pot as the exhibit, calm whitespace,
  serif italic microcopy ("the kiln decides").
- From **valeran**: the firing moment — on FIRE the gallery dims to kiln-dark, embers
  rise from the bottom edge, and the new pot appears before light floods back
  (you can't watch a firing; you wait outside the kiln).
- From **serotoninn**: the controls as a **glaze recipe card** — dashed border, stamped
  mono values, offset paper shadow.

System: Fraunces Variable (SOFT/WONK axes — an old-style serif designed to feel warm
and slightly imperfect) + IBM Plex Mono; warm paper, clay-ink brown (never pure black),
kiln-brick red; SVG-turbulence paper grain over everything. Fonts self-hosted via
Fontsource — no CDN, which also keeps them working inside the plugin's null-origin
iframe. Glyph gotcha: Plex Mono lacks "№" (U+2116) — firing labels use "no." instead.
