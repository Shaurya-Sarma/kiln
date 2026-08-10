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

/*
 * The panel wears the same clothes as the playground ("a potter's studio
 * notebook in a gallery"): warm paper, clay-ink brown, kiln-brick red, the
 * controls as a dashed glaze-recipe card with stamped mono values.
 *
 * Three deliberate departures, all forced by the 420x660 plugin window:
 *
 * 1. System font stacks instead of Fraunces + IBM Plex Mono. Bundling the
 *    webfonts into a self-contained html file is possible but costs ~100kb of
 *    base64 per face; Georgia stands in for the soft serif and the platform
 *    mono for the workshop voice.
 * 2. The four recipe selects sit in a 2-up grid, and the export row lives
 *    inside the card under a dashed rule. The whole notebook has 280px below
 *    the 380px gallery, and nothing may need scrolling.
 * 3. Crop-mark ticks sit out (they'd bracket a panel, not a gallery), and the
 *    paper grain covers only the notebook half — the gallery stays clean glass
 *    so the pot is never dusty at thumbnail size.
 */
const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --paper: #f4f1ec;
    --paper-raised: #faf7f1;
    --ink: #2b2118;
    --ink-soft: #6b5d4f;
    --ink-faint: #a1927f;
    --brick: #b0492e;
    --brick-deep: #93381f;
    --line: rgba(107,93,79,.35);
    --serif: Georgia, "Times New Roman", serif;
    --mono: ui-monospace, Menlo, Monaco, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--paper); color: var(--ink); font-family: var(--serif); }
  #app { display: flex; flex-direction: column; height: 100%; }

  /* ---------- the gallery ---------- */
  /* The pot is the exhibit and the canvas is transparent, so this paper — the
     same paper as the notebook below — is what it stands against. */
  .gallery { position: relative; height: 380px; flex: none; background: var(--paper); border-bottom: 1px solid var(--line); }
  #viewport { position: absolute; inset: 0; }
  #viewport canvas { display: block; }

  .masthead { position: absolute; top: 14px; left: 16px; z-index: 20; user-select: none; }
  .masthead h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 22px; font-weight: 400; letter-spacing: 0.01em; line-height: 1; }
  .masthead .mark { width: 20px; height: 20px; flex: none; }
  #status { margin: 5px 0 0 1px; font-size: 10.5px; font-style: italic; letter-spacing: 0.02em; color: var(--ink-faint); }

  /* ---------- the notebook ---------- */
  /* Sized to need no scrolling at 420x660 — overflow-y is the safety net for a
     host whose font metrics run a hair larger, not the expected state. */
  .controls { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 7px 12px 8px; }
  /* Paper grain, this half only. */
  .controls::after {
    content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0.45; mix-blend-mode: multiply;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.42 0 0 0 0 0.36 0 0 0 0 0.30 0 0 0 0.05 0'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  /* ---------- the recipe card ---------- */
  .panel { padding: 9px 13px 10px; background: var(--paper-raised); border: 1px dashed var(--line); box-shadow: 3px 4px 0 rgba(43,33,24,.06); }
  .recipe-title { margin: 0 0 7px; padding-bottom: 6px; font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.28em; color: var(--ink-soft); border-bottom: 1px solid var(--line); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 11px; }
  label { display: block; margin-bottom: 7px; font-family: var(--mono); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-soft); }
  select { display: block; width: 100%; margin-top: 3px; padding: 3px 5px; font-family: var(--serif); font-size: 13px; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 0; }
  input[type="range"] { display: block; width: 100%; margin-top: 3px; accent-color: var(--brick); }
  #holdLabel { float: right; text-transform: none; letter-spacing: 0.06em; color: var(--ink-faint); }

  /* ---------- FIRE, and the stamp under it ---------- */
  button { width: 100%; font-family: var(--mono); cursor: pointer; }
  #fire { padding: 8px 0; margin-top: 1px; font-size: 12px; letter-spacing: 0.42em; text-indent: 0.42em; color: var(--paper-raised); background: var(--brick); border: none; transition: background .2s; }
  #fire:hover { background: var(--brick-deep); }
  #fire:disabled { background: var(--ink-faint); cursor: wait; }
  .stamp { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 0; }
  .seed { margin: 0; font-family: var(--mono); font-size: 10px; letter-spacing: 0.16em; color: var(--ink-faint); }
  .seed span { color: var(--ink-soft); }
  .check { display: flex; align-items: center; gap: 5px; margin: 0; font-size: 9px; letter-spacing: 0.1em; }
  .check input { accent-color: var(--brick); margin: 0; }

  /* ---------- out of the kiln, onto the canvas ---------- */
  .row2 { display: flex; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); }
  /* width:100% above would become each item's flex-basis and blow the row past
     the panel — these two share the row instead. */
  .secondary { flex: 1; width: auto; min-width: 0; padding: 7px 0; font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-soft); background: var(--paper); border: 1px solid var(--line); transition: color .15s, border-color .15s; }
  .secondary:hover { color: var(--brick); border-color: var(--brick); }
</style>
</head>
<body>
  <div id="app">
    <div class="gallery">
      <div id="viewport"></div>
      <header class="masthead">
        <h1><svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#6F4930"/><path fill="#F4EAD5" d="M 25 11 L 40 10 L 38 15 L 37 20 L 45 26 L 48 35 L 44 47 L 40 51 L 42 56 L 23 57 L 26 51 L 21 46 L 16 34 L 20 25 L 27 19 L 26 14 Z"/></svg>Kiln</h1>
        <p id="status">…</p>
      </header>
    </div>
    <div class="controls">
      <div class="panel">
        <p class="recipe-title">FIRING RECIPE</p>
        <div class="grid2">
          <label id="formRow">form
            <select id="preset"></select>
          </label>
          <label>glaze
            <select id="glaze">
              <option value="celadon" selected>celadon</option>
              <option value="crystalline">crystalline</option>
              <option value="tenmoku">tenmoku</option>
              <option value="shino">shino</option>
              <option value="copper-red">copper red</option>
              <option value="ash">ash</option>
            </select>
          </label>
          <label>colorant
            <select id="colorant">
              <option value="iron" selected>iron</option>
              <option value="cobalt">cobalt</option>
              <option value="chrome">chrome</option>
              <option value="manganese">manganese</option>
              <option value="rutile">rutile</option>
            </select>
          </label>
          <label>atmosphere
            <select id="atmosphere">
              <option value="reduction" selected>reduction</option>
              <option value="oxidation">oxidation</option>
            </select>
          </label>
        </div>
        <label>hold at peak <span id="holdLabel">45 min</span>
          <input id="hold" type="range" min="10" max="90" step="5" value="45" />
        </label>
        <button id="fire">FIRE</button>
        <div class="stamp">
          <p class="seed">firing <span id="seed"></span></p>
          <label class="check"><input type="checkbox" id="transparent" /> transparent bg</label>
        </div>
        <div class="row2">
          <button id="place" class="secondary">place on canvas</button>
          <button id="tiles" class="secondary">test tiles &times;9</button>
        </div>
      </div>
    </div>
  </div>
  <script>${js}</script>
</body>
</html>`;

writeFileSync("dist/ui.html", html);
console.log("built dist/code.js + dist/ui.html");
