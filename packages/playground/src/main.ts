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
  AmbientLight,
  CircleGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  type Material,
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
import { type GlazeName, type Recipe, type ShelfEntry, loadShelf, saveShelf, sketchThumbnail } from "./shelf.js";
import "./style.css";

const GLAZES: Record<GlazeName, (r: Recipe) => Material> = {
  celadon: (r) => createCeladonMaterial({ atmosphere: r.atmosphere, seed: r.seed }),
  crystalline: (r) => createCrystallineMaterial({ atmosphere: r.atmosphere, seed: r.seed, holdMinutes: r.holdMinutes }),
  tenmoku: (r) => createTenmokuMaterial({ atmosphere: r.atmosphere, seed: r.seed }),
};

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
    // ?debug=texture&shift=1 rolls the texture by half its width so the wrap
    // seam lands center-screen — a break along the middle = doesn't tile.
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

  // ---------- state (shareable: the URL reproduces the exact pot) ----------
  const params = new URLSearchParams(location.search);
  const recipe: Recipe = {
    form: (params.get("form") ?? "vase") as PresetName,
    glaze: (params.get("glaze") ?? "celadon") as GlazeName,
    atmosphere: (params.get("atmosphere") ?? "reduction") as Atmosphere,
    holdMinutes: Number(params.get("hold") ?? 45),
    seed: Number(params.get("seed") ?? newFiringSeed()),
  };

  function syncUrl() {
    const q = new URLSearchParams({
      form: recipe.form,
      glaze: recipe.glaze,
      atmosphere: recipe.atmosphere,
      hold: String(recipe.holdMinutes),
      seed: String(recipe.seed),
    });
    history.replaceState(null, "", `?${q}`);
  }

  // ---------- renderer: TRANSPARENT so DOM typography sits behind the 3D ----------
  const renderer = new WebGPURenderer({ antialias: true, alpha: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;

  const scene = new Scene(); // no background — the page's paper shows through

  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0.4, 1.7, 5.2);

  const key = new DirectionalLight("#fff2e0", 2.4);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 8;
  const fill = new DirectionalLight("#dfe4f0", 0.6);
  fill.position.set(-5, 3, 2);
  const rim = new DirectionalLight("#ffffff", 1.1);
  rim.position.set(-2, 4, -6);
  scene.add(key, fill, rim, new AmbientLight("#e8e4f0", 0.4));

  // The exhibit stage: a plaster pedestal on a paper-toned floor disc.
  const PEDESTAL_TOP = 0;
  const pedestal = new Mesh(
    new CylinderGeometry(1.15, 1.2, 1.1, 64),
    new MeshStandardMaterial({ color: "#e9e2d6", roughness: 0.92 }),
  );
  pedestal.position.y = PEDESTAL_TOP - 0.55;
  pedestal.castShadow = pedestal.receiveShadow = true;
  const floor = new Mesh(
    new CircleGeometry(30).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: "#ece6db", roughness: 0.96 }),
  );
  floor.position.y = PEDESTAL_TOP - 1.1;
  floor.receiveShadow = true;
  scene.add(pedestal, floor);

  // ---------- pots on stage (index 0 = the working pot; 1..2 = companions) ----------
  const stage = new Group();
  stage.position.y = PEDESTAL_TOP;
  scene.add(stage);
  const STAND_X = [0, -1.55, 1.55];

  type StagePot = { mesh: Mesh; recipe: Recipe };
  let stagePots: StagePot[] = [];

  function buildPotMesh(r: Recipe): Mesh {
    const profile = PRESETS[r.form];
    if (!profile) throw new Error(`unknown form: ${r.form}`);
    const sampled = sampleProfile(profile);
    const mesh = new Mesh(buildPotGeometry(sampled), GLAZES[r.glaze](r));
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  function layoutStage() {
    stagePots.forEach((pot, i) => {
      pot.mesh.position.x = STAND_X[i] ?? 0;
    });
  }

  function setWorkingPot(r: Recipe) {
    const old = stagePots[0];
    if (old) {
      old.mesh.geometry.dispose();
      stage.remove(old.mesh);
    }
    const mesh = buildPotMesh(r);
    stagePots = [{ mesh, recipe: { ...r } }, ...stagePots.slice(1)];
    stage.add(mesh);
    layoutStage();
    Object.assign(recipe, r);
    updatePlacard();
    syncUrl();
  }

  function standCompanion(r: Recipe) {
    if (stagePots.length >= 3) {
      const dropped = stagePots.pop()!;
      dropped.mesh.geometry.dispose();
      stage.remove(dropped.mesh);
    }
    const mesh = buildPotMesh(r);
    stagePots = [stagePots[0]!, { mesh, recipe: { ...r } }, ...stagePots.slice(1)];
    stage.add(mesh);
    layoutStage();
    clearTableBtn.style.display = "";
  }

  function clearCompanions() {
    stagePots.slice(1).forEach((pot) => {
      pot.mesh.geometry.dispose();
      stage.remove(pot.mesh);
    });
    stagePots = stagePots.slice(0, 1);
    clearTableBtn.style.display = "none";
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.target.set(0, 0.9, 0);

  // ---------- chrome ----------
  const pieceTitle = (r: Recipe) => `${r.form[0]!.toUpperCase()}${r.form.slice(1)} — ${r.glaze}`;

  const chrome = document.createElement("div");
  chrome.innerHTML = `
    <div class="bignum" id="bignum"></div>
    <div class="vignette"></div>
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
          .map((n) => `<option value="${n}" ${n === recipe.form ? "selected" : ""}>${n}</option>`)
          .join("")}</select>
      </label>
      <label>glaze
        <select id="glaze">${Object.keys(GLAZES)
          .map((n) => `<option value="${n}" ${n === recipe.glaze ? "selected" : ""}>${n}</option>`)
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
    <button class="share cleartable" id="clearTable" style="display:none">clear the table</button>
    <div class="shelf" id="shelf">
      <p class="shelf-label">THE SHELF</p>
      <div class="shelf-items" id="shelfItems"></div>
    </div>
    <div class="kilnfire" id="kilnfire"><span class="ember-label">firing</span></div>
  `;
  app.appendChild(renderer.domElement);
  app.appendChild(chrome);

  const seedEl = chrome.querySelector<HTMLSpanElement>("#seed")!;
  const bignumEl = chrome.querySelector<HTMLDivElement>("#bignum")!;
  const fireBtn = chrome.querySelector<HTMLButtonElement>("#fire")!;
  const kilnfire = chrome.querySelector<HTMLDivElement>("#kilnfire")!;
  const clearTableBtn = chrome.querySelector<HTMLButtonElement>("#clearTable")!;

  function updatePlacard() {
    chrome.querySelector("#placardTitle")!.textContent = pieceTitle(recipe);
    chrome.querySelector("#placardMeta")!.textContent =
      `${recipe.atmosphere} fire · ${recipe.holdMinutes} min hold · ${firingLabel(recipe.seed)}`;
    seedEl.textContent = firingLabel(recipe.seed);
    bignumEl.textContent = firingLabel(recipe.seed).replace("no. ", "");
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
      item.innerHTML = `
        <img src="${sketchThumbnail(entry.recipe)}" alt="" title="load onto the pedestal" />
        <p class="shelf-name">${firingLabel(entry.recipe.seed)}</p>
        <div class="shelf-actions">
          <button title="stand next to the current pot">+table</button>
          <button title="remove from shelf">×</button>
        </div>
      `;
      item.querySelector("img")!.addEventListener("click", () => {
        setWorkingPot(entry.recipe);
        syncControls();
      });
      const [standBtn, removeBtn] = item.querySelectorAll("button");
      standBtn!.addEventListener("click", () => standCompanion(entry.recipe));
      removeBtn!.addEventListener("click", () => {
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
    }
  });

  // ?demo=1 pre-stocks the shelf (screenshots, first-visit demos).
  if (params.get("demo") === "1" && shelf.length === 0) {
    shelf = [
      { recipe: { form: "bowl", glaze: "celadon", atmosphere: "reduction", holdMinutes: 30, seed: 1204 }, savedAt: 0 },
      { recipe: { form: "bottle", glaze: "crystalline", atmosphere: "reduction", holdMinutes: 75, seed: 417 }, savedAt: 0 },
      { recipe: { form: "vase", glaze: "crystalline", atmosphere: "oxidation", holdMinutes: 60, seed: 2024 }, savedAt: 0 },
      { recipe: { form: "mug", glaze: "tenmoku", atmosphere: "oxidation", holdMinutes: 20, seed: 88 }, savedAt: 0 },
    ];
    saveShelf(shelf);
  }
  renderShelf();

  // ---------- control wiring ----------
  function syncControls() {
    chrome.querySelector<HTMLSelectElement>("#preset")!.value = recipe.form;
    chrome.querySelector<HTMLSelectElement>("#glaze")!.value = recipe.glaze;
    chrome.querySelector<HTMLSelectElement>("#atmosphere")!.value = recipe.atmosphere;
    chrome.querySelector<HTMLInputElement>("#hold")!.value = String(recipe.holdMinutes);
    chrome.querySelector<HTMLSpanElement>("#holdLabel")!.textContent = `${recipe.holdMinutes} min`;
  }

  chrome.querySelector<HTMLSelectElement>("#preset")!.addEventListener("change", (e) => {
    setWorkingPot({ ...recipe, form: (e.target as HTMLSelectElement).value as PresetName });
  });
  chrome.querySelector<HTMLSelectElement>("#glaze")!.addEventListener("change", (e) => {
    setWorkingPot({ ...recipe, glaze: (e.target as HTMLSelectElement).value as GlazeName });
  });
  chrome.querySelector<HTMLSelectElement>("#atmosphere")!.addEventListener("change", (e) => {
    setWorkingPot({ ...recipe, atmosphere: (e.target as HTMLSelectElement).value as Atmosphere });
  });
  chrome.querySelector<HTMLInputElement>("#hold")!.addEventListener("input", (e) => {
    const holdMinutes = Number((e.target as HTMLInputElement).value);
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
    setTimeout(() => setWorkingPot({ ...recipe, seed: newFiringSeed() }), 1200);
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
  if (params.get("debug") === "firing") kilnfire.classList.add("dim");

  chrome.querySelector<HTMLButtonElement>("#share")!.addEventListener("click", async () => {
    await navigator.clipboard.writeText(location.href);
    const btn = chrome.querySelector<HTMLButtonElement>("#share")!;
    btn.textContent = "copied — same seed, same pot";
    setTimeout(() => (btn.textContent = "copy link to this firing"), 2000);
  });
  clearTableBtn.addEventListener("click", clearCompanions);

  // ---------- resize + render loop ----------
  function resize() {
    const { clientWidth: w, clientHeight: h } = app!;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  addEventListener("resize", resize);
  resize();

  setWorkingPot(recipe);

  renderer.setAnimationLoop(() => {
    stagePots.forEach((pot) => (pot.mesh.rotation.y += 0.004)); // the wheel never quite stops
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
