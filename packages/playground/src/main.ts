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
  type Atmosphere,
  firingLabel,
  newFiringSeed,
  sampleProfile,
} from "@kiln/engine";
import "./style.css";

async function main() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("missing #app");

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
  const state = {
    preset: "vase" as PresetName,
    atmosphere: "reduction" as Atmosphere,
    seed: newFiringSeed(),
  };

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
    const material = createCeladonMaterial({ atmosphere: state.atmosphere, seed: state.seed });
    pot = new Mesh(geometry, material);
    pot.castShadow = pot.receiveShadow = true;
    scene.add(pot);

    // Aim the camera at the pot's vertical center, whatever its height.
    const midY = sampled.points.reduce((m, p) => Math.max(m, p.height), 0) / 2;
    controls.target.set(0, midY, 0);

    seedEl.textContent = firingLabel(state.seed);
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
    <label>atmosphere
      <select id="atmosphere">
        <option value="reduction" selected>reduction</option>
        <option value="oxidation">oxidation</option>
      </select>
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
  panel.querySelector<HTMLSelectElement>("#atmosphere")!.addEventListener("change", (e) => {
    state.atmosphere = (e.target as HTMLSelectElement).value as Atmosphere;
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
