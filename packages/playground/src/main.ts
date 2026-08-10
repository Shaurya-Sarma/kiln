/**
 * Kiln playground — the public demo at kiln.shaux.dev.
 *
 * Presentation concept: "The Studio". The pot stands on a plaster pedestal
 * like an exhibit; the renderer is TRANSPARENT (alpha) so the page's paper,
 * grain, and a huge faint firing number sit *behind* the 3D scene — DOM
 * typography and WebGPU sharing one composition. Kept pots live on the shelf
 * (bottom), stored as recipes, replayable forever via their seeds.
 */

import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/wght-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import {
  ACESFilmicToneMapping,
  CircleGeometry,
  DirectionalLight,
  Group,
  LatheGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PointLight,
  Raycaster,
  Scene,
  Vector2,
} from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  PRESETS,
  type PresetName,
  buildPotGeometry,
  createAshMaterial,
  createCeladonMaterial,
  createCopperRedMaterial,
  createCrystallineMaterial,
  createShinoMaterial,
  createTenmokuMaterial,
  type Atmosphere,
  firingLabel,
  newFiringSeed,
  sampleProfile,
  studioEnvironment,
} from "@kiln/engine";
import { type GlazeName, type Recipe, type ShelfEntry, loadShelf, saveShelf, sketchThumbnail } from "./shelf.js";
import type { Colorant } from "@kiln/engine";
import {
  clayGrab,
  dialStep,
  emberWhisper,
  flickRelease,
  kilnDoor,
  potSettle,
  setSoundEnabled,
  setSpinRate,
  shelfLift,
  shelfPlace,
  shelfRemove,
  soundEnabled,
  stamp,
  startRoar,
  stopRoar,
  tink,
  uiTick,
} from "./audio.js";
import { initCursor, setPotGrip } from "./cursor.js";
import "./style.css";

// Every glaze receives the full firing — atmosphere, seed, AND hold. The
// hold matters everywhere now (a soak matures every melt), so the factories
// just forward the recipe's firing facts wholesale.
const GLAZES: Record<GlazeName, (r: Recipe) => Material> = {
  celadon: (r) => createCeladonMaterial(firing(r)),
  crystalline: (r) => createCrystallineMaterial(firing(r)),
  tenmoku: (r) => createTenmokuMaterial(firing(r)),
  shino: (r) => createShinoMaterial(firing(r)),
  "copper-red": (r) => createCopperRedMaterial(firing(r)),
  ash: (r) => createAshMaterial(firing(r)),
};
function firing(r: Recipe) {
  return { atmosphere: r.atmosphere, seed: r.seed, holdMinutes: r.holdMinutes, colorant: r.colorant };
}

/** What is happening in the melt, and what the kiln varies per firing —
 * shown under the glaze picker so the controls teach the craft they model. */
const GLAZE_NOTES: Record<GlazeName, string> = {
  celadon:
    "Iron dissolved in translucent glass — pale where thin, deep jade where it pools. Reduction fires green; oxidation, honey.",
  crystalline:
    "Zinc crystals bloom as the kiln cools. The firing decides where they start; the hold decides how large they grow.",
  tenmoku:
    "Iron-saturated black that breaks to rust on rims and ridges. Oil spots mark where bubbles surfaced from the melt.",
  shino:
    "The glaze that does what it wants — flame blushes it orange, smoke traps grey under the melt. No two firings agree.",
  "copper-red":
    "Copper starved of oxygen turns blood-red with violet veils. Give the same recipe air and it settles into quiet green.",
  ash: "Wood ash melts into runny glass and rivulets down the wall. Each firing the drips choose new paths.",
};

async function main() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("missing #app");
  const preheat = document.querySelector("#preheat");

  // ?debug=cursor — the cursor contact sheet: every follower state pinned out as
  // artwork, because a screenshot cannot photograph a cursor. It has to return
  // BEFORE the renderer: the sheet is pure DOM and needs no 3D, and gating it
  // behind `await renderer.init()` made it unreachable on any machine without
  // WebGPU (headless Chrome included), where that promise simply never settles.
  if (new URLSearchParams(location.search).get("debug") === "cursor") {
    preheat?.remove();
    initCursor();
    return;
  }

  // ?debug=sound — the audition board: every sound in the palette with a button
  // to trigger it, plus a spin-rate slider for the continuous wheel loop. You
  // cannot hear a screenshot, so this is how the sound design gets checked.
  if (new URLSearchParams(location.search).get("debug") === "sound") {
    preheat?.remove();
    const { mountSoundBoard } = await import("./sound-board.js");
    mountSoundBoard(app);
    return;
  }

  // ?debug=texture — show the raw crystalline canvas flat, for hunting seams
  // and tuning bloom density without the 3D projection in the way.
  if (new URLSearchParams(location.search).get("debug") === "texture") {
    const { crystallineTexture } = await import("@kiln/engine");
    const q = new URLSearchParams(location.search);
    const tex = crystallineTexture({
      seed: Number(q.get("seed") ?? 417),
      atmosphere: (q.get("atmosphere") ?? "reduction") as Atmosphere,
      holdMinutes: Number(q.get("hold") ?? 75),
    });
    // The engine prefers OffscreenCanvas, which isn't a DOM element — blit it
    // onto a visible canvas to inspect it.
    const source = tex.image as OffscreenCanvas | HTMLCanvasElement;
    const view = document.createElement("canvas");
    view.width = source.width;
    view.height = source.height;
    const ctx2d = view.getContext("2d")!;
    // ?debug=texture&shift=1 rolls the texture by half its width so the wrap
    // seam lands center-screen — a break along the middle = doesn't tile.
    if (q.get("shift")) {
      ctx2d.drawImage(source, -source.width / 2, 0);
      ctx2d.drawImage(source, source.width / 2, 0);
    } else {
      ctx2d.drawImage(source, 0, 0);
    }
    view.style.cssText = "width:100vmin;height:100vmin;display:block;margin:auto";
    preheat?.remove();
    app.appendChild(view);
    return;
  }

  // ---------- state (shareable: the URL reproduces the exact pot) ----------
  const params = new URLSearchParams(location.search);
  const recipe: Recipe = {
    form: (params.get("form") ?? "vase") as PresetName,
    glaze: (params.get("glaze") ?? "celadon") as GlazeName,
    atmosphere: (params.get("atmosphere") ?? "reduction") as Atmosphere,
    holdMinutes: Number(params.get("hold") ?? 45),
    seed: Number(params.get("seed") ?? newFiringSeed()),
    colorant: (params.get("colorant") ?? "iron") as Colorant,
  };

  function syncUrl() {
    const q = new URLSearchParams({
      form: recipe.form,
      glaze: recipe.glaze,
      atmosphere: recipe.atmosphere,
      hold: String(recipe.holdMinutes),
      seed: String(recipe.seed),
      colorant: recipe.colorant,
    });
    history.replaceState(null, "", `?${q}`);
  }

  // ---------- renderer: TRANSPARENT so DOM typography sits behind the 3D ----------
  const renderer = new WebGPURenderer({ antialias: true, alpha: true });
  await renderer.init();
  preheat?.remove(); // the kiln is hot — from here the scene takes over
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;

  const scene = new Scene(); // no background — the page's paper shows through

  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0.4, 1.7, 5.2);

  // Image-based lighting: the pots reflect a procedural studio (engine/studio.ts).
  // `scene.environment` only feeds the materials — `scene.background` stays null,
  // so the canvas is still transparent and the page's paper shows through.
  scene.environment = studioEnvironment(renderer);
  scene.environmentIntensity = 0.9;

  // The rig on top of the environment is now deliberately thin. Its job is what
  // an environment map cannot do: cast the contact shadow that sits the pot on
  // the pedestal, and put one sharp specular on the glaze. Everything soft —
  // ambient fill, the sheen down the shoulder, the vertical highlight streaks —
  // comes from the studio, which is why the old AmbientLight is gone: it was
  // flattening the very contrast that makes a glaze look wet.
  const key = new DirectionalLight("#fff2e0", 1.35);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 8;
  // A directional light's shadow camera defaults to a 10x10 box, but the whole
  // exhibit is about 4 units across — so nearly all of those 2048 texels were
  // being spent on empty space. Cropping the frustum to the stage is free
  // resolution, and it is what turns the contact shadow under the foot from a
  // grey smudge into an actual ring.
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 3.4;
  key.shadow.camera.bottom = -1.4;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 16;
  // Offset shadow lookups along the surface normal. Needed because the foot pad
  // and the pedestal top touch: a depth comparison between two surfaces at the
  // same depth goes either way per texel, which is what stipples a contact edge.
  key.shadow.normalBias = 0.045;

  // The studio's overhead softbox is the largest source in the environment, but
  // an environment map cannot cast a shadow — so there was nothing dark directly
  // beneath the pot and it read as pasted onto the plinth rather than standing
  // on it. This light stands in for that softbox: nearly overhead, dim, heavily
  // blurred, and its real job is the pool of occlusion inside the foot ring.
  const overhead = new DirectionalLight("#fff4e6", 0.55);
  overhead.position.set(0.5, 9, 1.2);
  overhead.castShadow = true;
  overhead.shadow.mapSize.set(1024, 1024);
  overhead.shadow.radius = 14;
  overhead.shadow.camera.left = -2.6;
  overhead.shadow.camera.right = 2.6;
  overhead.shadow.camera.top = 2.6;
  overhead.shadow.camera.bottom = -2.6;
  overhead.shadow.camera.near = 1;
  overhead.shadow.camera.far = 16;
  overhead.shadow.normalBias = 0.03;

  const fill = new DirectionalLight("#dfe4f0", 0.25);
  fill.position.set(-5, 3, 2);
  const rim = new DirectionalLight("#ffffff", 0.5);
  rim.position.set(-2, 4, -6);
  scene.add(key, overhead, fill, rim);

  // The exhibit stage: a plaster pedestal on a paper-toned floor disc. Both are
  // pitched a step DARKER than the page's paper on purpose. They used to be the
  // same value, which was invisible until the environment map arrived and the
  // rig came down — at which point the pedestal dissolved into the background
  // and left the pot floating. A plinth only does its job if its silhouette
  // reads against the wall behind it.
  //
  // The plinth is a revolved profile rather than a cylinder, because a cylinder's
  // edges are the tell. Its top rim is a mathematically sharp ring, so the key
  // light resolves it as one hard line and the whole form flattens to a shape.
  // Cast plaster has a small radius wherever it left the mould, and that radius
  // is what produces the thin travelling highlight along the top edge that reads
  // as a solid object. Same silhouette and the same two values as before — the
  // change is entirely in how the edges catch light.
  const PEDESTAL_TOP = 0;
  const PEDESTAL_BOTTOM = -1.1;
  const TOP_RADIUS = 1.15;
  const BOTTOM_RADIUS = 1.2; // the slight taper that keeps it from looking like a pipe
  const EDGE_RADIUS = 0.045; // the mould-release radius on the top and base edges

  /** Points along a circular arc about (cx, cy), for building a fillet. */
  const arc = (cx: number, cy: number, r: number, from: number, to: number, steps: number) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const angle = from + ((to - from) * i) / steps;
      return new Vector2(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    });

  // Bottom-centre up and over to top-centre. The straight body is implicit: lathe
  // joins consecutive points, so the gap between the two fillets IS the taper,
  // and no point is repeated (a duplicate would revolve into a degenerate ring
  // whose zero-area faces produce NaN normals).
  const pedestalProfile = [
    new Vector2(0, PEDESTAL_BOTTOM),
    ...arc(BOTTOM_RADIUS - EDGE_RADIUS, PEDESTAL_BOTTOM + EDGE_RADIUS, EDGE_RADIUS, -Math.PI / 2, 0, 8),
    ...arc(TOP_RADIUS - EDGE_RADIUS, PEDESTAL_TOP - EDGE_RADIUS, EDGE_RADIUS, 0, Math.PI / 2, 8),
    new Vector2(0, PEDESTAL_TOP),
  ];
  const pedestal = new Mesh(
    // 192 segments, not 64. The plinth fills a third of the frame, and at 64 the
    // silhouette's flat spots are visible against the paper at this size.
    new LatheGeometry(pedestalProfile, 192),
    new MeshStandardMaterial({ color: "#d8cebc", roughness: 0.88 }),
  );
  pedestal.castShadow = pedestal.receiveShadow = true;
  const floor = new Mesh(
    new CircleGeometry(30, 128).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: "#e0d8ca", roughness: 0.96 }),
  );
  floor.position.y = PEDESTAL_BOTTOM;
  floor.receiveShadow = true;
  scene.add(pedestal, floor);

  // ---------- the pot on stage ----------
  // Exactly one, always at the center of the plinth. Firing a new pot or loading
  // one off the shelf replaces it. There used to be a "+table" action that stood
  // up to two companions from the shelf alongside it, at x = ±1.55; it is gone
  // deliberately, because the pedestal only reads as an exhibit when there is a
  // single thing on it, and companions turned the composition into a shop window.
  const stage = new Group();
  // A hair above the pedestal, not exactly on it. The pots stand on a trimmed
  // foot ring whose contact pad is dead flat at y = 0, which would be coplanar
  // with the pedestal's top face and z-fight along the silhouette. Well under a
  // pixel of separation, and the shadow still lands where the foot is.
  stage.position.y = PEDESTAL_TOP + 0.004;
  scene.add(stage);

  type StagePot = {
    mesh: Mesh;
    recipe: Recipe;
    /** Current spin, radians/frame. Decays toward the idle wheel speed. */
    spin: number;
    /** When this pot landed on the stage — drives the entrance animation. */
    bornAt: number;
  };
  let stagePots: StagePot[] = [];

  /** The wheel never quite stops: every pot's idle rotation speed. */
  const IDLE_SPIN = 0.004;

  function buildPotMesh(r: Recipe): Mesh {
    const profile = PRESETS[r.form];
    if (!profile) throw new Error(`unknown form: ${r.form}`);
    const sampled = sampleProfile(profile);
    const mesh = new Mesh(buildPotGeometry(sampled), GLAZES[r.glaze](r));
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  function removeStagePot(pot: StagePot) {
    pot.mesh.geometry.dispose();
    (pot.mesh.material as Material).dispose();
    stage.remove(pot.mesh);
  }

  // The only writer of `stagePots`, and it always leaves exactly one pot in it —
  // which is what keeps "one pot on the plinth" true rather than merely tidy.
  function setWorkingPot(r: Recipe) {
    stagePots.forEach(removeStagePot);
    const mesh = buildPotMesh(r);
    stagePots = [{ mesh, recipe: { ...r }, spin: IDLE_SPIN, bornAt: performance.now() }];
    stage.add(mesh);
    Object.assign(recipe, r);
    updatePlacard();
    syncUrl();
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  // Zoom stays within the exhibit: close enough to read a crystal, never so
  // far the pot becomes a speck on an endless paper plain.
  controls.minDistance = 2.4;
  controls.maxDistance = 9;
  controls.target.set(0, 0.9, 0);

  // ---------- spin the pot like a wheel ----------
  // Dragging EMPTY space orbits the camera (OrbitControls). Dragging THE POT
  // grabs it: it follows your hand, and a flick releases with real momentum
  // that decays back to the idle wheel speed — the way a wheel head keeps
  // turning after you take your hand off it.
  const raycaster = new Raycaster();
  const pointerNdc = new Vector2();
  let grabbed: StagePot | null = null;
  let lastPointerX = 0;
  let lastDragDelta = 0;
  /** The grabbed pot's rotation last frame — how loud the wheel is right now. */
  let grabbedRotation = 0;

  function potUnderPointer(event: PointerEvent): StagePot | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObjects(stagePots.map((pot) => pot.mesh));
    const hitMesh = hits[0]?.object;
    return stagePots.find((pot) => pot.mesh === hitMesh) ?? null;
  }

  renderer.domElement.addEventListener("pointerdown", (event) => {
    const pot = potUnderPointer(event);
    if (!pot) return;
    grabbed = pot;
    lastPointerX = event.clientX;
    lastDragDelta = 0;
    controls.enabled = false; // the hand is on the pot, not the camera
    setPotGrip("grabbing");
    clayGrab(); // a palm meeting the damp wall
  });
  renderer.domElement.addEventListener("pointermove", (event) => {
    if (grabbed) {
      const delta = event.clientX - lastPointerX;
      lastPointerX = event.clientX;
      lastDragDelta = delta * 0.011; // px -> radians; tuned to feel 1:1
      grabbed.mesh.rotation.y += lastDragDelta;
    } else {
      setPotGrip(potUnderPointer(event) ? "over" : "none");
    }
  });
  const releasePot = () => {
    if (!grabbed) return;
    grabbed.spin = lastDragDelta; // the flick: leave with the hand's velocity
    flickRelease(lastDragDelta); // air off the rim, but only on a real flick
    grabbed = null;
    controls.enabled = true;
    setPotGrip("none");
  };
  renderer.domElement.addEventListener("pointerup", releasePot);
  renderer.domElement.addEventListener("pointerleave", releasePot);

  // ---------- the inspection lamp ----------
  // A warm handheld light that rides just in front of the pot, following the
  // cursor — the way a potter walks a lamp across a glaze to read its depth
  // and catch the crystals. Pure pleasure feature; costs one point light.
  const lamp = new PointLight("#ffd9a6", 0, 5, 2);
  scene.add(lamp);
  let lampTarget = 0;
  addEventListener("pointermove", (event) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    // Park the lamp along the pointer's ray, most of the way to the pot — close
    // enough to throw a readable highlight, far enough not to clip inside it.
    const toStage = camera.position.distanceTo(controls.target);
    lamp.position.copy(raycaster.ray.at(toStage - 1.35, lamp.position));
    lampTarget = 2.6;

    // DOM parallax: the giant number drifts against the pot as the cursor
    // moves — two layers of paper sliding, the cheapest depth cue there is.
    bignumEl.style.transform = `translateX(calc(-50% + ${pointerNdc.x * -14}px)) translateY(${pointerNdc.y * 8}px)`;
  });

  // ---------- chrome ----------
  const pieceTitle = (r: Recipe) => `${r.form[0]!.toUpperCase()}${r.form.slice(1)} — ${r.glaze}`;

  const chrome = document.createElement("div");
  chrome.innerHTML = `
    <div class="bignum" id="bignum"></div>
    <div class="vignette"></div>
    <div class="grain"></div>
    <i class="tick tl"></i><i class="tick tr"></i><i class="tick bl"></i><i class="tick br"></i>
    <header class="masthead">
      <h1><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#6F4930"/><path fill="#F4EAD5" d="M 25 11 L 40 10 L 38 15 L 37 20 L 45 26 L 48 35 L 44 47 L 40 51 L 42 56 L 23 57 L 26 51 L 21 46 L 16 34 L 20 25 L 27 19 L 26 14 Z"/></svg>Kiln</h1>
    </header>
    <div class="panel">
      <p class="recipe-title"><span>FIRING RECIPE</span><button id="panelToggle" title="minimize the recipe">–</button></p>
      <label>form
        <select id="preset">${Object.keys(PRESETS)
          .map((n) => `<option value="${n}" ${n === recipe.form ? "selected" : ""}>${n}</option>`)
          .join("")}</select>
      </label>
      <label>glaze
        <select id="glaze">${Object.keys(GLAZES)
          .map((n) => `<option value="${n}" ${n === recipe.glaze ? "selected" : ""}>${n}</option>`)
          .join("")}</select>
      </label>
      <p class="glaze-note" id="glazeNote"></p>
      <label>colorant
        <select id="colorant">${(["iron", "cobalt", "chrome", "manganese", "rutile"] as const)
          .map((c) => `<option value="${c}" ${c === recipe.colorant ? "selected" : ""}>${c}</option>`)
          .join("")}</select>
      </label>
      <label>atmosphere
        <select id="atmosphere">${(["reduction", "oxidation"] as const)
          .map((a) => `<option value="${a}" ${a === recipe.atmosphere ? "selected" : ""}>${a}</option>`)
          .join("")}</select>
      </label>
      <label>hold at peak <span id="holdLabel">${recipe.holdMinutes} min</span>
        <input id="hold" type="range" min="10" max="90" step="5" value="${recipe.holdMinutes}" />
      </label>
      <button id="fire">FIRE</button>
      <p class="seed">firing <span id="seed"></span></p>
    </div>
    <div class="placard" id="placard">
      <p class="placard-title" id="placardTitle"></p>
      <p class="placard-meta" id="placardMeta"></p>
      <button class="keep" id="keep">keep this pot → shelf</button>
    </div>
    <button class="share" id="share">copy link to this firing</button>
    <button class="share soundtoggle" id="soundToggle">sound ${soundEnabled() ? "on" : "off"}</button>
    <p class="credit">
      made by <a href="https://shaux.dev" target="_blank" rel="noopener">shaurya sarma</a>
      · <a href="https://github.com/Shaurya-Sarma" target="_blank" rel="noopener">github</a>
    </p>
    <div class="shelf" id="shelf">
      <p class="shelf-label">THE SHELF</p>
      <div class="shelf-items" id="shelfItems"></div>
    </div>
    <div class="kilnfire" id="kilnfire"><span class="ember-label">firing</span></div>
  `;
  app.appendChild(renderer.domElement);
  app.appendChild(chrome);

  // The studio cursor. Owns every cursor picture in the app; the only thing the
  // scene tells it is whether a hand is on a pot (setPotGrip, above). Bails out
  // on its own for touch and reduced motion, so this call is unconditional.
  initCursor();

  // The recipe card folds down to its title bar — the pot is the exhibit and
  // sometimes the card is just in the way. Remembered across visits.
  const panelEl = chrome.querySelector<HTMLDivElement>(".panel")!;
  const panelToggle = chrome.querySelector<HTMLButtonElement>("#panelToggle")!;
  const setPanelCollapsed = (collapsed: boolean) => {
    panelEl.classList.toggle("collapsed", collapsed);
    panelToggle.textContent = collapsed ? "+" : "–";
    localStorage.setItem("kiln.panel.v1", collapsed ? "min" : "open");
  };
  panelToggle.addEventListener("click", () => setPanelCollapsed(!panelEl.classList.contains("collapsed")));
  const storedPanel = localStorage.getItem("kiln.panel.v1");
  // Phones start folded: the card would otherwise stand in front of the pot,
  // and the pot is the point. A stored preference still wins.
  if (storedPanel === "min" || (storedPanel === null && matchMedia("(max-width: 720px)").matches)) {
    setPanelCollapsed(true);
  }

  const seedEl = chrome.querySelector<HTMLSpanElement>("#seed")!;
  const bignumEl = chrome.querySelector<HTMLDivElement>("#bignum")!;
  const fireBtn = chrome.querySelector<HTMLButtonElement>("#fire")!;
  const kilnfire = chrome.querySelector<HTMLDivElement>("#kilnfire")!;

  function updatePlacard() {
    chrome.querySelector("#placardTitle")!.textContent = pieceTitle(recipe);
    chrome.querySelector("#placardMeta")!.textContent =
      `${recipe.atmosphere} fire · ${recipe.holdMinutes} min hold · ${firingLabel(recipe.seed)}`;
    seedEl.textContent = firingLabel(recipe.seed);
    bignumEl.textContent = firingLabel(recipe.seed).replace("no. ", "");
    glazeNoteEl.textContent = GLAZE_NOTES[recipe.glaze];
    document.title = `Kiln — firing ${firingLabel(recipe.seed)}`;
  }

  // ---------- the shelf ----------
  let shelf: ShelfEntry[] = loadShelf();
  const shelfEl = chrome.querySelector<HTMLDivElement>("#shelf")!;
  const shelfItemsEl = chrome.querySelector<HTMLDivElement>("#shelfItems")!;

  function renderShelf() {
    shelfEl.style.display = shelf.length ? "" : "none";
    shelfItemsEl.innerHTML = "";
    shelf.forEach((entry, index) => {
      const item = document.createElement("div");
      item.className = "shelf-item";
      // Delete lives ON the thumbnail as a corner badge (revealed on hover) —
      // a bare "×" floating under the name was too small to find and too easy
      // to miss; a badge on the artifact reads as "remove THIS".
      item.innerHTML = `
        <div class="shelf-thumb">
          <img src="${sketchThumbnail(entry.recipe)}" alt="" title="load onto the pedestal" />
          <button class="shelf-remove" title="remove from shelf">×</button>
        </div>
        <p class="shelf-name">${firingLabel(entry.recipe.seed)}</p>
      `;
      item.querySelector("img")!.addEventListener("click", () => {
        shelfLift(); // a dry hand taking it off the board
        setWorkingPot(entry.recipe);
        syncControls();
      });
      item.querySelector<HTMLButtonElement>(".shelf-remove")!.addEventListener("click", () => {
        shelfRemove();
        shelf = shelf.filter((_, i) => i !== index);
        saveShelf(shelf);
        renderShelf();
      });
      shelfItemsEl.appendChild(item);
    });
  }

  chrome.querySelector<HTMLButtonElement>("#keep")!.addEventListener("click", () => {
    const already = shelf.some((e) => JSON.stringify(e.recipe) === JSON.stringify(recipe));
    if (!already) {
      shelf = [...shelf, { recipe: { ...recipe }, savedAt: Date.now() }];
      saveShelf(shelf);
      renderShelf();
      shelfPlace(); // the knock of a pot set on the wooden shelf board
    }
  });

  // ?demo=1 pre-stocks the shelf (screenshots, first-visit demos).
  if (params.get("demo") === "1" && shelf.length === 0) {
    shelf = [
      { recipe: { form: "bowl", glaze: "celadon", atmosphere: "reduction", holdMinutes: 30, seed: 1204, colorant: "iron" }, savedAt: 0 },
      { recipe: { form: "bottle", glaze: "crystalline", atmosphere: "reduction", holdMinutes: 75, seed: 417, colorant: "iron" }, savedAt: 0 },
      { recipe: { form: "vase", glaze: "crystalline", atmosphere: "oxidation", holdMinutes: 60, seed: 2024, colorant: "cobalt" }, savedAt: 0 },
      { recipe: { form: "mug", glaze: "tenmoku", atmosphere: "oxidation", holdMinutes: 20, seed: 88, colorant: "iron" }, savedAt: 0 },
    ];
    saveShelf(shelf);
  }
  renderShelf();

  // ---------- control wiring ----------
  function syncControls() {
    chrome.querySelector<HTMLSelectElement>("#preset")!.value = recipe.form;
    chrome.querySelector<HTMLSelectElement>("#glaze")!.value = recipe.glaze;
    chrome.querySelector<HTMLSelectElement>("#atmosphere")!.value = recipe.atmosphere;
    chrome.querySelector<HTMLSelectElement>("#colorant")!.value = recipe.colorant;
    chrome.querySelector<HTMLInputElement>("#hold")!.value = String(recipe.holdMinutes);
    chrome.querySelector<HTMLSpanElement>("#holdLabel")!.textContent = `${recipe.holdMinutes} min`;
  }

  chrome.querySelector<HTMLSelectElement>("#preset")!.addEventListener("change", (e) => {
    uiTick("form");
    setWorkingPot({ ...recipe, form: (e.target as HTMLSelectElement).value as PresetName });
  });
  const glazeNoteEl = chrome.querySelector<HTMLParagraphElement>("#glazeNote")!;
  const updateGlazeNote = () => (glazeNoteEl.textContent = GLAZE_NOTES[recipe.glaze]);
  updateGlazeNote();
  chrome.querySelector<HTMLSelectElement>("#glaze")!.addEventListener("change", (e) => {
    uiTick("glaze");
    setWorkingPot({ ...recipe, glaze: (e.target as HTMLSelectElement).value as GlazeName });
  });
  chrome.querySelector<HTMLSelectElement>("#colorant")!.addEventListener("change", (e) => {
    uiTick("glaze");
    setWorkingPot({ ...recipe, colorant: (e.target as HTMLSelectElement).value as Colorant });
  });
  chrome.querySelector<HTMLSelectElement>("#atmosphere")!.addEventListener("change", (e) => {
    uiTick("atmosphere");
    setWorkingPot({ ...recipe, atmosphere: (e.target as HTMLSelectElement).value as Atmosphere });
  });
  chrome.querySelector<HTMLInputElement>("#hold")!.addEventListener("input", (e) => {
    const holdMinutes = Number((e.target as HTMLInputElement).value);
    dialStep(); // one detent of the kiln controller dial
    chrome.querySelector<HTMLSpanElement>("#holdLabel")!.textContent = `${holdMinutes} min`;
    setWorkingPot({ ...recipe, holdMinutes });
  });

  /**
   * The firing sequence — the emotional center of the whole app.
   * The gallery dims to kiln-dark, embers rise (you can't watch a firing; you
   * wait outside the kiln), the new pot is thrown in the dark, and the door
   * opens onto a pot you've never seen before.
   */
  function fireKiln() {
    fireBtn.disabled = true;
    kilnfire.classList.remove("open");
    kilnfire.classList.add("dim");
    startRoar(); // the pressure-roar of a kiln at temperature, swelling with the dark
    setTimeout(() => setWorkingPot({ ...recipe, seed: newFiringSeed() }), 1200);
    setTimeout(() => {
      kilnfire.classList.add("open");
      kilnfire.classList.remove("dim");
      stopRoar();
      kilnDoor(); // the latch and the heavy brick door swinging open
      tink(); // the ceramic ring of the pot being set down
    }, 1700);
    setTimeout(() => {
      kilnfire.classList.remove("open");
      fireBtn.disabled = false;
    }, 3000);
  }
  fireBtn.addEventListener("click", fireKiln);
  // The one control that gets a hover voice: embers breathing in the firebox.
  // (If every button whispered, none of them would mean anything.)
  fireBtn.addEventListener("pointerenter", emberWhisper);
  if (params.get("debug") === "firing") kilnfire.classList.add("dim");

  chrome.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    stamp(); // the maker's stamp pressed into leather-hard clay
    const btn = chrome.querySelector<HTMLButtonElement>("#share")!;
    btn.textContent = "copied — same seed, same pot";
    setTimeout(() => (btn.textContent = "copy link to this firing"), 2000);
  });
  const soundBtn = chrome.querySelector<HTMLButtonElement>("#soundToggle")!;
  soundBtn.addEventListener("click", () => {
    setSoundEnabled(!soundEnabled());
    soundBtn.textContent = `sound ${soundEnabled() ? "on" : "off"}`;
    if (soundEnabled()) tink(); // instant proof it's on
  });

  // ---------- resize + render loop ----------
  function resize() {
    const { clientWidth: w, clientHeight: h } = app!;
    camera.aspect = w / h;
    // A portrait phone crops the pot at the default focal length — widen the
    // field of view as the viewport narrows (the dolly-free way to step back).
    camera.fov = camera.aspect < 0.7 ? 47 : camera.aspect < 1 ? 41 : 35;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  addEventListener("resize", resize);
  resize();

  setWorkingPot(recipe);

  /** Ease-out-back: overshoots its target slightly, then settles — the feel
   * of a pot being set down with just a little too much confidence. */
  function easeOutBack(k: number): number {
    const c = 1.70158;
    const t = k - 1;
    return 1 + (c + 1) * t * t * t + c * t * t;
  }
  const ENTRANCE_MS = 700;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // The wheel's continuous voice: the fastest pot on stage drives it (while a
    // pot is grabbed, the hand's own velocity does). Silent at idle speed.
    let fastestSpin = 0;
    stagePots.forEach((pot) => {
      // Spin: while grabbed the hand drives it directly; released spin decays
      // exponentially back to the idle wheel speed (the flick's momentum).
      if (pot !== grabbed) {
        pot.mesh.rotation.y += pot.spin;
        pot.spin += (IDLE_SPIN - pot.spin) * 0.025;
        fastestSpin = Math.max(fastestSpin, Math.abs(pot.spin));
      } else {
        // Hand-driven: the wheel's speed is the rotation it actually gained this
        // frame, so a hand resting on the pot without moving is silent — which
        // is exactly what a stopped wheel does.
        fastestSpin = Math.max(fastestSpin, Math.abs(pot.mesh.rotation.y - grabbedRotation));
        grabbedRotation = pot.mesh.rotation.y;
      }
      // Entrance: rise out of the pedestal and settle with a slight overshoot.
      const age = (now - pot.bornAt) / ENTRANCE_MS;
      if (age < 1) {
        const k = easeOutBack(age);
        pot.mesh.position.y = -0.35 * (1 - k);
        pot.mesh.scale.setScalar(0.94 + 0.06 * k);
      } else {
        // The first frame past the entrance — the scale still being mid-flight is
        // what marks that edge — is the moment the pot comes to rest.
        if (pot.mesh.scale.x !== 1) potSettle();
        pot.mesh.position.y = 0;
        pot.mesh.scale.setScalar(1);
      }
    });
    setSpinRate(fastestSpin);
    // The inspection lamp breathes in when the cursor moves, out when it rests.
    lamp.intensity += (lampTarget - lamp.intensity) * 0.08;
    lampTarget *= 0.985; // no movement -> the lamp is set down again
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((err) => {
  console.error(err);
  const el = document.createElement("pre");
  el.textContent = String(err);
  document.body.appendChild(el);
});
