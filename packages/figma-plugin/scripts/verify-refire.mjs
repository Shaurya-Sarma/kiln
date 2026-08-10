/**
 * A placed pot must be self-contained.
 *
 * Firing settings alone don't reproduce a pot thrown from a pen-tool curve — the
 * form is half its identity, and the curve it came from can be moved, edited or
 * deleted after the firing. So the profile travels on the node too, and this
 * script proves the round-trip: run the built sandbox bundle against a stub
 * Figma API, place pots, then re-fire them with nothing but the pot selected.
 *
 * Run after `pnpm build` (it reads dist/code.js):
 *   node packages/figma-plugin/scripts/verify-refire.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../dist/code.js", import.meta.url), "utf8");

function makeNode(type) {
  const data = new Map();
  return {
    type,
    name: "",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    fills: [],
    resize(w, h) {
      this.width = w;
      this.height = h;
    },
    setPluginData(k, v) {
      data.set(k, v);
    },
    getPluginData(k) {
      return data.get(k) ?? "";
    },
    setRelaunchData() {},
  };
}

const posted = [];
const created = [];
const figma = {
  command: "refire",
  currentPage: { selection: [], appendChild() {} },
  viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
  showUI() {},
  notify() {},
  openExternal() {},
  closePlugin() {},
  ui: { postMessage: (m) => posted.push(m), onmessage: null },
  on() {},
  createImage: () => ({ hash: "h", getSizeAsync: async () => ({ width: 1024, height: 1024 }) }),
  createRectangle: () => {
    const n = makeNode("RECTANGLE");
    created.push(n);
    return n;
  },
  createComponent: () => {
    const n = makeNode("COMPONENT");
    created.push(n);
    return n;
  },
  combineAsVariants: (children) => ({ name: "", description: "", children }),
};
globalThis.figma = figma;
globalThis.__html__ = "";

// The bundle is an IIFE that talks to the `figma` global set up above; running
// it here is the closest thing to loading the plugin without opening Figma.
new Function(bundle)();

const settings = {
  glaze: "shino",
  atmosphere: "reduction",
  holdMinutes: 30,
  seed: 4242,
  colorant: "rutile",
  form: null, // curve-thrown
};
const profile = [
  { radius: 0.02, height: 0 },
  { radius: 0.4, height: 0.5 },
  { radius: 0.3, height: 1.2 },
];

// 1. Place a curve pot, then re-fire it with nothing else selected.
await figma.ui.onmessage({ type: "place-render", png: new Uint8Array(8), label: "l", settings, profile });
const pot = created.at(-1);
figma.currentPage.selection = [pot];
posted.length = 0;
await figma.ui.onmessage({ type: "ready" });
const curveRestore = posted.at(-1).restore;
assert.deepEqual(curveRestore, { settings, profile }, "curve pot must restore recipe AND form");

// 2. Preset pot: no profile stored, recipe names the form.
const presetSettings = { ...settings, form: "vase" };
await figma.ui.onmessage({
  type: "place-render",
  png: new Uint8Array(8),
  label: "l",
  settings: presetSettings,
  profile: null,
});
figma.currentPage.selection = [created.at(-1)];
posted.length = 0;
await figma.ui.onmessage({ type: "ready" });
assert.deepEqual(posted.at(-1).restore, { settings: presetSettings, profile: null });

// 3. Legacy pot: recipe key only, no profile key at all.
const legacy = makeNode("RECTANGLE");
legacy.setPluginData("kiln", JSON.stringify(settings));
figma.currentPage.selection = [legacy];
posted.length = 0;
await figma.ui.onmessage({ type: "ready" });
assert.deepEqual(posted.at(-1).restore, { settings, profile: null }, "legacy pot restores recipe only");

// 4. Garbage in the profile key degrades to the recipe, never throws.
for (const junk of ["{", "[]", '[{"radius":1}]', '[{"radius":"x","height":1},{"radius":1,"height":2}]', "null"]) {
  const bad = makeNode("RECTANGLE");
  bad.setPluginData("kiln", JSON.stringify(settings));
  bad.setPluginData("kiln:profile", junk);
  figma.currentPage.selection = [bad];
  posted.length = 0;
  await figma.ui.onmessage({ type: "ready" });
  assert.deepEqual(posted.at(-1).restore, { settings, profile: null }, `junk profile ${junk}`);
}

// 5. Every test tile carries the shared form and its own seed.
created.length = 0;
await figma.ui.onmessage({
  type: "place-test-tiles",
  tiles: [1, 2, 3].map((seed) => ({ png: new Uint8Array(8), label: "l", seed })),
  settings,
  profile,
});
for (const tile of created) {
  assert.deepEqual(JSON.parse(tile.getPluginData("kiln:profile")), profile);
}
assert.deepEqual(
  created.map((t) => JSON.parse(t.getPluginData("kiln")).seed),
  [1, 2, 3],
);

console.log("ok — re-fire round-trips form + recipe, legacy and junk degrade cleanly");
