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

  // Everything needed to re-open this exact pot later travels on the node.
  rect.setPluginData(PLUGIN_DATA_KEY, JSON.stringify(settings));
  rect.setRelaunchData({ refire: "Re-open this firing in Kiln" });

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
      // explore options with variant grids. Same artifact — place a frame.
      const frame = figma.createFrame();
      frame.name = `Kiln test tiles — ${message.settings.glaze}`;
      const TILE = 220;
      const GAP = 16;
      const COLS = 3;
      const rows = Math.ceil(message.tiles.length / COLS);
      frame.resize(COLS * TILE + (COLS + 1) * GAP, rows * TILE + (rows + 1) * GAP);
      frame.fills = [{ type: "SOLID", color: { r: 0.98, g: 0.97, b: 0.95 } }];
      frame.x = Math.round(figma.viewport.center.x);
      frame.y = Math.round(figma.viewport.center.y - frame.height / 2);

      const placed = await Promise.all(
        message.tiles.map(async (tile, index) => {
          const image = figma.createImage(tile.png);
          await image.getSizeAsync(); // validates decode before we attach it
          const rect = figma.createRectangle();
          rect.resize(TILE, TILE);
          rect.x = GAP + (index % COLS) * (TILE + GAP);
          rect.y = GAP + Math.floor(index / COLS) * (TILE + GAP);
          rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
          rect.name = `${tile.label}`;
          rect.setPluginData(PLUGIN_DATA_KEY, JSON.stringify({ ...message.settings, seed: tile.seed }));
          rect.setRelaunchData({ refire: "Re-open this firing in Kiln" });
          return rect;
        }),
      );
      placed.forEach((rect) => frame.appendChild(rect));
      figma.currentPage.appendChild(frame);
      figma.viewport.scrollAndZoomIntoView([frame]);
      figma.notify(`Unloaded ${message.tiles.length} test tiles`);
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
