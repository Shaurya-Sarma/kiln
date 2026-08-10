/**
 * Plugin build: two esbuild bundles + one HTML inlining step.
 *
 * Figma loads exactly two artifacts: `main` (the sandbox script, one file)
 * and `ui` (one SELF-CONTAINED html file — the iframe has a null origin, so
 * external <script src> is off the table; everything, three.js included,
 * must be inlined). esbuild does both bundles in well under a second, which
 * keeps the edit → reload loop in Figma instant.
 */

import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });

// 1. Sandbox: no DOM, Figma's JS VM — plain iife.
await build({
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  format: "iife",
  target: "es2020",
});

// 2. UI: bundle in-memory, then inline into the HTML shell below.
const ui = await build({
  entryPoints: ["src/ui.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2020",
  minify: true,
});
// A literal "</script>" inside the bundle would terminate our inline tag
// early — escape it (the classic inline-script footgun).
const js = ui.outputFiles[0].text.replace(/<\/script>/g, "<\\/script>");

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #f4f1ec; font-family: Georgia, "Times New Roman", serif; color: #4a4036; }
  #app { display: flex; flex-direction: column; height: 100vh; }
  #viewport { height: 380px; flex: none; }
  #viewport canvas { display: block; }
  .controls { padding: 12px 16px 16px; overflow-y: auto; }
  h1 { margin: 0; font-size: 15px; font-weight: 400; letter-spacing: 0.45em; }
  #status { margin: 2px 0 10px; font-size: 10.5px; letter-spacing: 0.08em; color: #a1927f; font-style: italic; }
  label { display: block; margin-bottom: 9px; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #6b5d4f; }
  select, input[type="range"] { display: block; width: 100%; margin-top: 4px; }
  select { padding: 5px 7px; font-family: inherit; font-size: 12px; color: #4a4036; background: #fffdf9; border: 1px solid rgba(107,93,79,.3); border-radius: 3px; }
  input[type="range"] { accent-color: #b0492e; }
  #holdLabel { float: right; text-transform: none; color: #a1927f; }
  button { width: 100%; padding: 8px 0; margin-top: 6px; font-family: inherit; font-size: 12px; letter-spacing: 0.3em; border: none; border-radius: 3px; cursor: pointer; }
  #fire { color: #fffdf9; background: #b0492e; }
  #fire:hover { background: #93381f; }
  .secondary { color: #6b5d4f; background: #fffdf9; border: 1px solid rgba(107,93,79,.3); letter-spacing: 0.14em; }
  .secondary:hover { background: #f2ede4; }
  .seed { margin: 8px 0 0; font-size: 10.5px; letter-spacing: 0.14em; color: #a1927f; }
  .check { display: flex; align-items: center; gap: 6px; margin: 8px 0 2px; text-transform: none; letter-spacing: 0.08em; font-size: 10.5px; }
  .check input { accent-color: #b0492e; margin: 0; }
  .row2 { display: flex; gap: 8px; }
</style>
</head>
<body>
  <div id="app">
    <div id="viewport"></div>
    <div class="controls">
      <h1>KILN</h1>
      <p id="status">…</p>
      <label id="formRow">form
        <select id="preset"></select>
      </label>
      <label>glaze
        <select id="glaze">
          <option value="celadon" selected>celadon</option>
          <option value="crystalline">crystalline</option>
          <option value="tenmoku">tenmoku</option>
        </select>
      </label>
      <label>atmosphere
        <select id="atmosphere">
          <option value="reduction" selected>reduction</option>
          <option value="oxidation">oxidation</option>
        </select>
      </label>
      <label>hold at peak <span id="holdLabel">45 min</span>
        <input id="hold" type="range" min="10" max="90" step="5" value="45" />
      </label>
      <button id="fire">FIRE</button>
      <p class="seed">firing <span id="seed"></span></p>
      <label class="check"><input type="checkbox" id="transparent" /> transparent background</label>
      <div class="row2">
        <button id="place" class="secondary">place on canvas</button>
        <button id="tiles" class="secondary">test tiles ×9</button>
      </div>
    </div>
  </div>
  <script>${js}</script>
</body>
</html>`;

writeFileSync("dist/ui.html", html);
console.log("built dist/code.js + dist/ui.html");
