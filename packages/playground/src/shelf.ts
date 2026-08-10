/**
 * The shelf: saved firings.
 *
 * A fired pot is never saved as pixels — a pot IS its recipe. Form, glaze,
 * atmosphere, hold time, seed: a few bytes that replay the exact firing,
 * because every stochastic decision keys off the seed. So the shelf is a
 * little array of recipes in localStorage, and "loading" a pot means firing
 * its recipe again — the same way a potter's glaze notebook works.
 *
 * Thumbnails are 2D potter's sketches (the mirrored profile silhouette, inked
 * on paper) rather than GPU captures: on-theme, instant, and immune to
 * canvas-readback timing questions.
 */

import { PRESETS, type Atmosphere, type PresetName, sampleProfile } from "@kiln/engine";

export type GlazeName = "celadon" | "crystalline" | "tenmoku" | "shino" | "copper-red" | "ash";

export type Recipe = {
  form: PresetName;
  glaze: GlazeName;
  atmosphere: Atmosphere;
  holdMinutes: number;
  seed: number;
};

export type ShelfEntry = {
  recipe: Recipe;
  savedAt: number;
};

const STORAGE_KEY = "kiln.shelf.v1";

export function loadShelf(): ShelfEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ShelfEntry[];
  } catch {
    return [];
  }
}

export function saveShelf(entries: ShelfEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

/** Ink-on-paper glaze tints for the sketch thumbnails. */
const GLAZE_TINTS: Record<GlazeName, { fill: string; ink: string }> = {
  celadon: { fill: "#cfdccc", ink: "#4b6b58" },
  crystalline: { fill: "#dde7ec", ink: "#5d7e93" },
  tenmoku: { fill: "#3a2a1e", ink: "#20150e" },
  shino: { fill: "#efd9b8", ink: "#b06a3c" },
  "copper-red": { fill: "#8c2420", ink: "#541114" },
  ash: { fill: "#a99a5e", ink: "#5e7042" },
};

/**
 * Draw the potter's-sketch thumbnail: the profile mirrored into a full
 * silhouette, filled with a glaze tint, on shelf paper.
 */
export function sketchThumbnail(recipe: Recipe, size = 96): string {
  const profile = PRESETS[recipe.form];
  if (!profile) throw new Error(`unknown form ${recipe.form}`);
  const sampled = sampleProfile(profile, 48);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#faf7f1";
  ctx.fillRect(0, 0, size, size);

  const maxRadius = Math.max(...sampled.points.map((p) => p.radius));
  const maxHeight = Math.max(...sampled.points.map((p) => p.height));
  const scale = (size * 0.72) / Math.max(maxRadius * 2, maxHeight);
  const cx = size / 2;
  const baseY = size / 2 + (maxHeight * scale) / 2;

  const tint = GLAZE_TINTS[recipe.glaze];
  ctx.beginPath();
  // Right wall up...
  sampled.points.forEach((p, i) => {
    const x = cx + p.radius * scale;
    const y = baseY - p.height * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  // ...then left wall back down (mirrored).
  [...sampled.points].reverse().forEach((p) => {
    ctx.lineTo(cx - p.radius * scale, baseY - p.height * scale);
  });
  ctx.closePath();
  ctx.fillStyle = tint.fill;
  ctx.fill();
  ctx.strokeStyle = tint.ink;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  return canvas.toDataURL("image/png");
}
