/**
 * Kiln playground — the public demo at kiln.shaux.dev.
 *
 * Boot order matters with WebGPU: the renderer's init() is async (the browser
 * has to hand us a GPU adapter), so the whole app boots inside an async main().
 * If WebGPU is missing, three's WebGPURenderer falls back to WebGL2 by itself.
 */

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

const GLAZES = {
  celadon: (s: FiringState) => createCeladonMaterial(s),
  crystalline: (s: FiringState) => createCrystallineMaterial(s),
  tenmoku: (s: FiringState) => createTenmokuMaterial(s),
};
type GlazeName = keyof typeof GLAZES;
type FiringState = { atmosphere: Atmosphere; seed: number; holdMinutes: number };
import "./style.css";

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

  // ---------- the pot ----------
  // Every firing is shareable: the full state lives in the URL, so a link
  // reproduces the exact pot (the seed makes the randomness replayable).
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
    syncUrl();
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // don't go under the floor

  // ---------- UI panel ----------
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <h1>KILN</h1>
    <p class="tagline">throw · glaze · fire</p>
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
  `;
  app.appendChild(panel);

  const seedEl = panel.querySelector<HTMLSpanElement>("#seed")!;
  panel.querySelector<HTMLSelectElement>("#preset")!.addEventListener("change", (e) => {
    state.preset = (e.target as HTMLSelectElement).value as PresetName;
    firePot();
  });
  panel.querySelector<HTMLSelectElement>("#glaze")!.addEventListener("change", (e) => {
    state.glaze = (e.target as HTMLSelectElement).value as GlazeName;
    firePot();
  });
  panel.querySelector<HTMLSelectElement>("#atmosphere")!.addEventListener("change", (e) => {
    state.atmosphere = (e.target as HTMLSelectElement).value as Atmosphere;
    firePot();
  });
  const holdLabel = panel.querySelector<HTMLSpanElement>("#holdLabel")!;
  panel.querySelector<HTMLInputElement>("#hold")!.addEventListener("input", (e) => {
    state.holdMinutes = Number((e.target as HTMLInputElement).value);
    holdLabel.textContent = `${state.holdMinutes} min`;
    firePot();
  });
  panel.querySelector<HTMLButtonElement>("#fire")!.addEventListener("click", () => {
    state.seed = newFiringSeed();
    firePot();
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

  document.title = "Kiln — " + firingLabel(state.seed);
}

main().catch((err) => {
  console.error(err);
  const el = document.createElement("pre");
  el.textContent = String(err);
  document.body.appendChild(el);
});
