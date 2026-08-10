/**
 * Kiln — UI iframe side.
 *
 * Hosts the full engine (same code as the playground) inside the plugin
 * window. Two deliberate differences from the playground:
 *
 * 1. `forceWebGL: true`. Exports read the canvas back as a PNG immediately
 *    after a render; that same-task readback is rock-solid on WebGL2 and
 *    finicky on WebGPU swapchains. The playground stays WebGPU-first; the
 *    plugin trades the shiny backend for reliable exports. (TSL materials
 *    compile to GLSL here automatically — same material code.)
 *
 * 2. The profile can arrive from the sandbox (your selected pen-tool curve)
 *    instead of the preset dropdown. Selection changes re-throw live.
 */

import {
  ACESFilmicToneMapping,
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
  type FiringParams,
  PRESETS,
  type PresetName,
  type Profile,
  buildPotGeometry,
  createAshMaterial,
  createCeladonMaterial,
  createCopperRedMaterial,
  createCrystallineMaterial,
  createShinoMaterial,
  createTenmokuMaterial,
  firingLabel,
  newFiringSeed,
  sampleProfile,
  studioEnvironment,
} from "@kiln/engine";
import type { FiringSettings, SandboxMessage, UiMessage, WireProfilePoint } from "./messages.js";

// Typed against the engine's FiringParams (atmosphere/seed/hold) — the
// materials never see UI-only facts like which preset or curve is loaded.
const GLAZES = {
  celadon: (s: FiringParams) => createCeladonMaterial(s),
  crystalline: (s: FiringParams) => createCrystallineMaterial(s),
  tenmoku: (s: FiringParams) => createTenmokuMaterial(s),
  shino: (s: FiringParams) => createShinoMaterial(s),
  "copper-red": (s: FiringParams) => createCopperRedMaterial(s),
  ash: (s: FiringParams) => createAshMaterial(s),
};

function post(message: UiMessage, transfer?: Transferable[]) {
  parent.postMessage({ pluginMessage: message }, "*", transfer ?? []);
}

async function main() {
  const app = document.querySelector<HTMLDivElement>("#app")!;

  // `form` is deliberately absent from state: it's DERIVED at export time
  // (preset name, or null when thrown from a curve) — see settingsOnly().
  const state: Omit<FiringSettings, "form"> & {
    preset: PresetName;
    selectionProfile: Profile | null;
    sourceName: string | null;
  } = {
    glaze: "celadon",
    atmosphere: "reduction",
    holdMinutes: 45,
    seed: newFiringSeed(),
    colorant: "iron",
    preset: "vase",
    selectionProfile: null,
    sourceName: null,
  };

  // ---------- renderer & scene (compact gallery) ----------
  // alpha:true so transparent exports work — and so the LIVE viewport takes its
  // paper from CSS like the playground does. A tone-mapped scene.background
  // renders that same paper cold and grey, which read as a different product
  // from the warm notebook half an inch below it. It goes back on only for an
  // opaque export, where there's no page behind the pixels (see capture()).
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL: true, alpha: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  app.querySelector("#viewport")!.appendChild(renderer.domElement);

  const scene = new Scene();
  const paper = new Color("#f4f1ec");

  const camera = new PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 1.6, 4.6);

  // Same procedural studio the playground uses, for the same reason: the glazes
  // get their glassiness from what they reflect, and the engine's materials are
  // balanced against this environment. Sharing it is what keeps an exported test
  // tile looking like the pot on the site. Also the proof that the environment is
  // backend-agnostic — PMREM generation runs here on WebGL2 (forceWebGL above).
  scene.environment = studioEnvironment(renderer);
  scene.environmentIntensity = 0.9;

  const key = new DirectionalLight("#fff2e0", 1.35);
  key.position.set(4, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 8;
  key.shadow.normalBias = 0.045;
  const fill = new DirectionalLight("#dfe4f0", 0.25);
  fill.position.set(-5, 3, 2);
  const rim = new DirectionalLight("#ffffff", 0.5);
  rim.position.set(-2, 4, -6);
  scene.add(key, fill, rim);

  const ground = new Mesh(
    new CircleGeometry(30).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ color: "#efeae2", roughness: 0.95 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;

  // ---------- pot lifecycle ----------
  let pot: Mesh | null = null;

  function firePot() {
    if (pot) {
      pot.geometry.dispose();
      scene.remove(pot);
    }
    const profile = state.selectionProfile ?? PRESETS[state.preset]!;
    const sampled = sampleProfile(profile);
    pot = new Mesh(buildPotGeometry(sampled), GLAZES[state.glaze](state));
    pot.castShadow = pot.receiveShadow = true;
    scene.add(pot);
    const midY = sampled.points.reduce((m, p) => Math.max(m, p.height), 0) / 2;
    controls.target.set(0, midY, 0);
    seedEl.textContent = firingLabel(state.seed);
    statusEl.textContent = state.sourceName
      ? `thrown from “${state.sourceName}”`
      : "no curve selected — preset forms";
    formRow.style.display = state.selectionProfile ? "none" : "";
  }

  // ---------- export: render → PNG bytes ----------
  /**
   * Renders one square frame at `size` px and reads it back. The readback
   * must happen in the same task as the render (before the browser composits
   * a new frame), which is why this is synchronous after render().
   */
  function capture(size: number, transparent: boolean): Uint8Array {
    const el = renderer.domElement;
    const prevW = el.width;
    const prevH = el.height;
    // Transparent export: drop the floor so the pot (and its own shadow-free
    // silhouette) lands as a clean design asset. An opaque export is the one
    // case that needs a real backdrop — nothing sits behind an exported PNG the
    // way the panel's paper sits behind the live canvas.
    if (transparent) {
      ground.visible = false;
    } else {
      scene.background = paper;
    }
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const dataUrl = el.toDataURL("image/png");
    if (transparent) {
      ground.visible = true;
    } else {
      scene.background = null;
    }
    renderer.setSize(prevW, prevH, false);
    resize();
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const binary = atob(base64);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  }

  const transparentBox = app.querySelector<HTMLInputElement>("#transparent")!;

  function currentLabel(): string {
    return `${state.glaze} · ${state.atmosphere} · firing ${firingLabel(state.seed)}`;
  }

  // ---------- UI wiring ----------
  const statusEl = app.querySelector<HTMLParagraphElement>("#status")!;
  const seedEl = app.querySelector<HTMLSpanElement>("#seed")!;
  const formRow = app.querySelector<HTMLLabelElement>("#formRow")!;
  const formSel = app.querySelector<HTMLSelectElement>("#preset")!;
  formSel.innerHTML = Object.keys(PRESETS)
    .map((n) => `<option value="${n}" ${n === state.preset ? "selected" : ""}>${n}</option>`)
    .join("");

  formSel.addEventListener("change", () => {
    state.preset = formSel.value as PresetName;
    firePot();
  });
  app.querySelector<HTMLSelectElement>("#glaze")!.addEventListener("change", (e) => {
    state.glaze = (e.target as HTMLSelectElement).value as FiringSettings["glaze"];
    firePot();
  });
  app.querySelector<HTMLSelectElement>("#atmosphere")!.addEventListener("change", (e) => {
    state.atmosphere = (e.target as HTMLSelectElement).value as FiringSettings["atmosphere"];
    firePot();
  });
  app.querySelector<HTMLSelectElement>("#colorant")!.addEventListener("change", (e) => {
    state.colorant = (e.target as HTMLSelectElement).value as FiringSettings["colorant"];
    firePot();
  });
  const holdLabel = app.querySelector<HTMLSpanElement>("#holdLabel")!;
  app.querySelector<HTMLInputElement>("#hold")!.addEventListener("input", (e) => {
    state.holdMinutes = Number((e.target as HTMLInputElement).value);
    holdLabel.textContent = `${state.holdMinutes} min`;
    firePot();
  });
  app.querySelector<HTMLButtonElement>("#fire")!.addEventListener("click", () => {
    state.seed = newFiringSeed();
    firePot();
  });

  app.querySelector<HTMLButtonElement>("#place")!.addEventListener("click", () => {
    const png = capture(1024, transparentBox.checked);
    post({ type: "place-render", png, label: currentLabel(), settings: settingsOnly(), profile: profileOnly() }, [
      png.buffer,
    ]);
  });

  function runTestTiles() {
    // Nine firings of the current setup — same pot, same glaze, nine seeds.
    // The grid IS the point: this is how potters (test tiles) and designers
    // (variant grids) both explore an option space — the sandbox places them
    // as a component set with a `firing` variant property.
    const keepSeed = state.seed;
    const tiles = Array.from({ length: 9 }, () => {
      state.seed = newFiringSeed();
      firePot();
      return { png: capture(512, transparentBox.checked), label: currentLabel(), seed: state.seed };
    });
    state.seed = keepSeed;
    firePot();
    post(
      { type: "place-test-tiles", tiles, settings: settingsOnly(), profile: profileOnly() },
      tiles.map((t) => t.png.buffer),
    );
  }
  app.querySelector<HTMLButtonElement>("#tiles")!.addEventListener("click", runTestTiles);

  function settingsOnly(): FiringSettings {
    return {
      glaze: state.glaze,
      atmosphere: state.atmosphere,
      holdMinutes: state.holdMinutes,
      seed: state.seed,
      colorant: state.colorant,
      // Preset pots are fully reproducible in the playground; curve-thrown
      // pots aren't (their form lives in the Figma file), so form is null.
      form: state.selectionProfile ? null : state.preset,
    };
  }

  /**
   * The form that was actually thrown, for the sandbox to store on the pot. A
   * preset pot sends null — settings.form names it, and the preset table is code
   * we ship. A curve pot sends its points, because they exist nowhere else.
   */
  function profileOnly(): WireProfilePoint[] | null {
    return state.selectionProfile?.map(({ radius, height }) => ({ radius, height })) ?? null;
  }

  // ---------- messages from the sandbox ----------
  /** The form a re-fired pot brought with it, kept until a new curve replaces it. */
  let restoredForm: WireProfilePoint[] | null = null;

  onmessage = (event: MessageEvent<{ pluginMessage?: SandboxMessage }>) => {
    const message = event.data.pluginMessage;
    if (!message) return;
    if (message.type === "profile") {
      if (message.restore) {
        // Pots exported before the colorant existed restore as traditional iron.
        Object.assign(state, { colorant: "iron" }, message.restore.settings);
        // Curve pots carry their own form; a preset pot names one we still ship.
        restoredForm = message.restore.profile;
        if (restoredPreset(message.restore.settings.form)) state.preset = message.restore.settings.form;
        syncControls();
      }
      // A re-fired pot's form outlives the selection. What's selected at re-fire
      // time is the pot, not the curve it was thrown from — and that curve may
      // have moved or been deleted since the firing — so a stray click elsewhere
      // mustn't quietly turn the pot back into a preset. Selecting a usable
      // curve is the one thing that replaces a restored form.
      if (message.points) {
        restoredForm = null;
        state.selectionProfile = message.points;
        state.sourceName = message.sourceName;
      } else if (restoredForm) {
        state.selectionProfile = restoredForm;
        state.sourceName = "re-fired pot";
      } else {
        state.selectionProfile = null;
        state.sourceName = null;
      }
      firePot();
      if (message.autorun === "tiles" && !autoranTiles) {
        autoranTiles = true;
        runTestTiles();
      }
    }
  };
  let autoranTiles = false;

  /** A stored form name only names a preset if we still ship that preset. */
  function restoredPreset(form: string | null): form is PresetName {
    return form !== null && form in PRESETS;
  }

  function syncControls() {
    formSel.value = state.preset;
    app.querySelector<HTMLSelectElement>("#glaze")!.value = state.glaze;
    app.querySelector<HTMLSelectElement>("#atmosphere")!.value = state.atmosphere;
    app.querySelector<HTMLSelectElement>("#colorant")!.value = state.colorant;
    const hold = app.querySelector<HTMLInputElement>("#hold")!;
    hold.value = String(state.holdMinutes);
    holdLabel.textContent = `${state.holdMinutes} min`;
  }

  // ---------- resize + loop ----------
  function resize() {
    const viewport = app.querySelector<HTMLDivElement>("#viewport")!;
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  addEventListener("resize", resize);
  resize();
  firePot();

  renderer.setAnimationLoop(() => {
    if (pot) pot.rotation.y += 0.004;
    controls.update();
    renderer.render(scene, camera);
  });

  post({ type: "ready" });
}

main().catch((error) => {
  document.body.innerHTML = `<pre style="padding:12px;white-space:pre-wrap">${String(error)}</pre>`;
});
