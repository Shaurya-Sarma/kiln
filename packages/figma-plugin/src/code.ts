/**
 * Kiln — sandbox side.
 *
 * This file is the only code with document access, and it stays thin: read
 * the selected pen-tool curve, hand it to the UI, and place whatever the kiln
 * produces back onto the canvas. All rendering lives in the UI iframe.
 */

import type { FiringSettings, SandboxMessage, UiMessage } from "./messages.js";
import { profileFromFigmaPath } from "./profile-from-figma.js";

const PLUGIN_DATA_KEY = "kiln";
const URL_DATA_KEY = "kiln:url";
const PLAYGROUND_URL = "https://kiln.shaux.dev";

/**
 * The playground cross-link: every firing is reproducible from its recipe, so
 * every placed pot can carry a URL that replays it live in 3D. A preset pot's
 * URL reproduces the whole pot; a curve-thrown pot's URL reproduces the glaze
 * firing (the form itself lives only in the Figma file).
 */
function shareUrl(settings: FiringSettings): string {
  // Hand-rolled query string: the plugin sandbox has no DOM globals, so
  // URLSearchParams isn't available here. encodeURIComponent is plain ES.
  const parts = [
    ["glaze", settings.glaze],
    ["atmosphere", settings.atmosphere],
    ["hold", String(settings.holdMinutes)],
    ["seed", String(settings.seed)],
    ["colorant", settings.colorant],
    ...(settings.form ? [["form", settings.form] as const] : []),
  ];
  const q = parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${PLAYGROUND_URL}/?${q}`;
}

// "Open the playground" — from the plugin submenu (no UI needed) or from a
// pot's relaunch button (jump straight to that exact firing).
if (figma.command === "playground") {
  const stored = figma.currentPage.selection[0]?.getPluginData(URL_DATA_KEY);
  figma.openExternal(stored || PLAYGROUND_URL);
  figma.closePlugin();
}

figma.showUI(__html__, { width: 420, height: 660, themeColors: true });

function post(message: SandboxMessage) {
  figma.ui.postMessage(message);
}

/**
 * Find a usable profile in the current selection: the first vector node whose
 * path parses as a half-silhouette. Anything else (no selection, shapes,
 * arcs) returns null and the UI offers preset forms instead — the plugin
 * must never be unusable just because nothing valid is selected.
 */
function profileFromSelection(): { points: ReturnType<typeof profileFromFigmaPath>; name: string } | null {
  const candidates = figma.currentPage.selection.filter(
    (node): node is VectorNode => node.type === "VECTOR",
  );
  const failures: string[] = [];
  const found = candidates.reduce<{ points: ReturnType<typeof profileFromFigmaPath>; name: string } | null>(
    (hit, node) => {
      if (hit) return hit;
      const data = node.vectorPaths[0]?.data;
      if (!data) return null;
      try {
        return { points: profileFromFigmaPath(data), name: node.name };
      } catch (error) {
        failures.push(`${node.name}: ${String(error instanceof Error ? error.message : error)}`);
        return null;
      }
    },
    null,
  );
  if (!found && failures.length > 0) {
    figma.notify(`Kiln couldn't read that curve (${failures[0]}) — using preset forms`, {
      timeout: 4000,
    });
  }
  return found;
}

/** Firing settings stored on a pot exported earlier ("Re-fire in Kiln"). */
function restoreFromSelection(): FiringSettings | null {
  const node = figma.currentPage.selection[0];
  const raw = node?.getPluginData(PLUGIN_DATA_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FiringSettings;
  } catch {
    return null;
  }
}

function sendProfile() {
  const found = profileFromSelection();
  post({
    type: "profile",
    points: found?.points ?? null,
    sourceName: found?.name ?? null,
    restore: figma.command === "refire" ? restoreFromSelection() : null,
    // Launched via the "Test tiles ×9" menu entry: the UI fires the grid
    // immediately instead of waiting for a button press.
    autorun: figma.command === "tiles" ? "tiles" : null,
  });
}

/** Place one rendered pot on the canvas as an image-filled rectangle. */
async function placeRender(png: Uint8Array, label: string, settings: FiringSettings): Promise<SceneNode> {
  const image = figma.createImage(png);
  const size = await image.getSizeAsync();

  const rect = figma.createRectangle();
  const DISPLAY = 480; // canvas pixels for the placed render
  rect.resize(DISPLAY, (DISPLAY * size.height) / size.width);
  rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  rect.name = `Kiln — ${label}`;

  // Everything needed to re-open this exact pot later travels on the node —
  // the recipe (for re-firing in the plugin) and the live playground link.
  rect.setPluginData(PLUGIN_DATA_KEY, JSON.stringify(settings));
  rect.setPluginData(URL_DATA_KEY, shareUrl(settings));
  rect.setRelaunchData({
    refire: "Re-open this firing in Kiln",
    playground: "See it live in 3D",
  });

  // Land just right of the current viewport center so it's always visible.
  rect.x = Math.round(figma.viewport.center.x);
  rect.y = Math.round(figma.viewport.center.y - rect.height / 2);
  figma.currentPage.appendChild(rect);
  return rect;
}

figma.ui.onmessage = async (message: UiMessage) => {
  switch (message.type) {
    case "ready": {
      sendProfile();
      break;
    }
    case "place-render": {
      const rect = await placeRender(message.png, message.label, message.settings);
      figma.viewport.scrollAndZoomIntoView([rect]);
      figma.notify(`Unloaded the kiln — ${message.label}`);
      break;
    }
    case "place-test-tiles": {
      // Potters explore glaze space with grids of small test tiles; designers
      // explore options with VARIANTS. Same artifact — so the grid lands as a
      // real component set: each firing is a variant with a `firing` property,
      // swappable anywhere the component is used. One recipe, nine variants,
      // the kiln's randomness expressed in Figma's own native vocabulary.
      const TILE = 220;
      const GAP = 16;
      const COLS = 3;

      const components = await Promise.all(
        message.tiles.map(async (tile, index) => {
          const image = figma.createImage(tile.png);
          await image.getSizeAsync(); // validates decode before we attach it
          const component = figma.createComponent();
          component.resize(TILE, TILE);
          // Grid layout before combining: combineAsVariants preserves the
          // children's relative positions inside the set.
          component.x = Math.round(figma.viewport.center.x) + (index % COLS) * (TILE + GAP);
          component.y = Math.round(figma.viewport.center.y) + Math.floor(index / COLS) * (TILE + GAP);
          component.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
          // "prop=value" naming is Figma's variant grammar: these nine become
          // a single `firing` property with nine values.
          component.name = `firing=${String(tile.seed % 10000).padStart(4, "0")}`;
          const settings = { ...message.settings, seed: tile.seed };
          component.setPluginData(PLUGIN_DATA_KEY, JSON.stringify(settings));
          component.setPluginData(URL_DATA_KEY, shareUrl(settings));
          component.setRelaunchData({
            refire: "Re-open this firing in Kiln",
            playground: "See it live in 3D",
          });
          return component;
        }),
      );

      const set = figma.combineAsVariants(components, figma.currentPage);
      set.name = `Kiln test tiles — ${message.settings.glaze}`;
      set.description =
        `${message.settings.glaze} · ${message.settings.atmosphere} fire · ` +
        `${message.settings.holdMinutes} min hold. Nine firings of one recipe — the kiln decides.\n` +
        shareUrl(message.settings);
      figma.viewport.scrollAndZoomIntoView([set]);
      figma.notify(`Unloaded ${message.tiles.length} firings as variants`);
      break;
    }
    case "notify": {
      figma.notify(message.message);
      break;
    }
  }
};

// Re-read the selection while the plugin is open, so drawing a new curve and
// selecting it re-throws the pot live.
figma.on("selectionchange", sendProfile);
