/**
 * Kiln playground — the public demo at kiln.shaux.dev.
 *
 * Boot order matters with WebGPU: the renderer's init() is async (the browser
 * has to hand us a GPU adapter), so the whole app boots inside an async main().
 * If WebGPU is missing, three's WebGPURenderer falls back to WebGL2 by itself.
 */

import "@fontsource-variable/fraunces";
import "@fontsource-variable/fraunces/wght-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import {
  ACESFilmicToneMapping,
  AmbientLight,
  CircleGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
} from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  PRESETS,
  type PresetName,
  buildPotGeometry,
  createCeladonMaterial,
  createCrystallineMaterial,
  createTenmokuMaterial,
  type Atmosphere,
  firingLabel,
  newFiringSeed,
  sampleProfile,
} from "@kiln/engine";
import "./style.css";

const GLAZES = {
  celadon: (s: FiringState) => createCeladonMaterial(s),
  crystalline: (s: FiringState) => createCrystallineMaterial(s),
  tenmoku: (s: FiringState) => createTenmokuMaterial(s),
};
type GlazeName = keyof typeof GLAZES;
type FiringState = { atmosphere: Atmosphere; seed: number; holdMinutes: number };

async function main() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("missing #app");

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
    // ?debug=texture&shift=1 draws the texture rolled by half its width, so
    // the wrap seam lands in the middle of the view — if the pattern breaks
    // along the vertical centerline, the texture does not tile.
    if (q.get("shift")) {
      ctx2d.drawImage(source, -source.width / 2, 0);
      ctx2d.drawImage(source, source.width / 2, 0);
    } else {
      ctx2d.drawImage(source, 0, 0);
    }
    view.style.cssText = "width:100vmin;height:100vmin;display:block;margin:auto";
    app.appendChild(view);
    return;
  }

  // ---------- renderer ----------
  const renderer = new WebGPURenderer({ antialias: true });
  await renderer.init(); // async: acquires the GPU device (or falls back to WebGL2)
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  app.appendChild(renderer.domElement);

  // ---------- scene: a quiet ceramics gallery ----------
  const scene = new Scene();
  scene.background = new Color("#f4f1ec"); // warm gallery off-white

  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 1.6, 4.6);

  // Three-point light rig (no HDR environment yet — see BUILDLOG):
  // warm key with soft shadows, cool dim fill, and a rim light for the
  // glassy clearcoat highlight along the pot's silhouette.
  const key = new DirectionalLight("#fff2e0", 2.4);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 8;
  const fill = new DirectionalLight("#dfe4f0", 0.6);
  fill.position.set(-5, 3, 2);
  const rim = new DirectionalLight("#ffffff", 1.1);
  rim.position.set(-2, 4, -6);
  scene.add(key, fill, rim, new AmbientLight("#e8e4f0", 0.35));

  const ground = new Mesh(
    new CircleGeometry(30).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: "#efeae2", roughness: 0.95 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- state (shareable: the URL reproduces the exact pot) ----------
  const params = new URLSearchParams(location.search);
  const state = {
    preset: (params.get("form") ?? "vase") as PresetName,
    glaze: (params.get("glaze") ?? "celadon") as GlazeName,
    atmosphere: (params.get("atmosphere") ?? "reduction") as Atmosphere,
    holdMinutes: Number(params.get("hold") ?? 45),
    seed: Number(params.get("seed") ?? newFiringSeed()),
  };

  function syncUrl() {
    const q = new URLSearchParams({
      form: state.preset,
      glaze: state.glaze,
      atmosphere: state.atmosphere,
      hold: String(state.holdMinutes),
      seed: String(state.seed),
    });
    history.replaceState(null, "", `?${q}`);
  }

  let pot: Mesh | null = null;

  function firePot() {
    if (pot) {
      pot.geometry.dispose();
      scene.remove(pot);
    }
    const profile = PRESETS[state.preset];
    if (!profile) throw new Error(`unknown preset: ${state.preset}`);
    const sampled = sampleProfile(profile);
    const geometry = buildPotGeometry(sampled);
    const material = GLAZES[state.glaze](state);
    pot = new Mesh(geometry, material);
    pot.castShadow = pot.receiveShadow = true;
    scene.add(pot);

    // Aim the camera at the pot's vertical center, whatever its height.
    const midY = sampled.points.reduce((m, p) => Math.max(m, p.height), 0) / 2;
    controls.target.set(0, midY, 0);

    seedEl.textContent = firingLabel(state.seed);
    document.title = `Kiln — firing ${firingLabel(state.seed)}`;
    syncUrl();
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // don't go under the floor

  // ---------- chrome: grain, crop ticks, masthead, recipe card ----------
  const chrome = document.createElement("div");
  chrome.innerHTML = `
    <div class="grain"></div>
    <i class="tick tl"></i><i class="tick tr"></i><i class="tick bl"></i><i class="tick br"></i>
    <header class="masthead">
      <h1>Kiln</h1>
      <p class="tagline">throw · glaze · fire — <em>the kiln decides</em></p>
    </header>
    <div class="panel">
      <p class="recipe-title">FIRING RECIPE</p>
      <label>form
        <select id="preset">${Object.keys(PRESETS)
          .map((n) => `<option value="${n}" ${n === state.preset ? "selected" : ""}>${n}</option>`)
          .join("")}</select>
      </label>
      <label>glaze
        <select id="glaze">${Object.keys(GLAZES)
          .map((n) => `<option value="${n}" ${n === state.glaze ? "selected" : ""}>${n}</option>`)
          .join("")}</select>
      </label>
      <label>atmosphere
        <select id="atmosphere">${(["reduction", "oxidation"] as const)
          .map((a) => `<option value="${a}" ${a === state.atmosphere ? "selected" : ""}>${a}</option>`)
          .join("")}</select>
      </label>
      <label>hold at peak <span id="holdLabel">${state.holdMinutes} min</span>
        <input id="hold" type="range" min="10" max="90" step="5" value="${state.holdMinutes}" />
      </label>
      <button id="fire">FIRE</button>
      <p class="seed">firing <span id="seed"></span></p>
    </div>
    <button class="share" id="share">copy link to this firing</button>
    <div class="kilnfire" id="kilnfire"><span class="ember-label">firing</span></div>
  `;
  app.appendChild(chrome);

  const seedEl = chrome.querySelector<HTMLSpanElement>("#seed")!;
  const fireBtn = chrome.querySelector<HTMLButtonElement>("#fire")!;
  const kilnfire = chrome.querySelector<HTMLDivElement>("#kilnfire")!;

  chrome.querySelector<HTMLSelectElement>("#preset")!.addEventListener("change", (e) => {
    state.preset = (e.target as HTMLSelectElement).value as PresetName;
    firePot();
  });
  chrome.querySelector<HTMLSelectElement>("#glaze")!.addEventListener("change", (e) => {
    state.glaze = (e.target as HTMLSelectElement).value as GlazeName;
    firePot();
  });
  chrome.querySelector<HTMLSelectElement>("#atmosphere")!.addEventListener("change", (e) => {
    state.atmosphere = (e.target as HTMLSelectElement).value as Atmosphere;
    firePot();
  });
  const holdLabel = chrome.querySelector<HTMLSpanElement>("#holdLabel")!;
  chrome.querySelector<HTMLInputElement>("#hold")!.addEventListener("input", (e) => {
    state.holdMinutes = Number((e.target as HTMLInputElement).value);
    holdLabel.textContent = `${state.holdMinutes} min`;
    firePot();
  });

  /**
   * The firing sequence — the emotional center of the whole app.
   * Phase 1: the gallery dims to kiln-dark, embers rise from the bottom edge
   * (you can't watch a firing; you wait outside the kiln).
   * Phase 2: the new pot is thrown in the dark; the door opens and warm light
   * floods back over a pot you've never seen before.
   */
  function fireKiln() {
    fireBtn.disabled = true;
    kilnfire.classList.remove("open");
    kilnfire.classList.add("dim");
    setTimeout(() => {
      state.seed = newFiringSeed();
      firePot();
    }, 1200);
    setTimeout(() => {
      kilnfire.classList.add("open");
      kilnfire.classList.remove("dim");
    }, 1700);
    setTimeout(() => {
      kilnfire.classList.remove("open");
      fireBtn.disabled = false;
    }, 3000);
  }
  fireBtn.addEventListener("click", fireKiln);

  // ?debug=firing freezes phase 1 for design tuning/screenshots.
  if (params.get("debug") === "firing") kilnfire.classList.add("dim");

  chrome.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    const btn = chrome.querySelector<HTMLButtonElement>("#share")!;
    btn.textContent = "copied — same seed, same pot";
    setTimeout(() => (btn.textContent = "copy link to this firing"), 2000);
  });

  // ---------- resize + render loop ----------
  function resize() {
    const { clientWidth: w, clientHeight: h } = app!;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  addEventListener("resize", resize);
  resize();

  firePot();

  renderer.setAnimationLoop(() => {
    if (pot) pot.rotation.y += 0.004; // the wheel never quite stops
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
