/**
 * Pen-tool curve → vessel profile.
 *
 * Figma hands a vector's geometry to plugins as SVG-style path text
 * (`node.vectorPaths[n].data`, e.g. "M 0 0 C 10 20 30 40 50 60 Z") using only
 * absolute M / L / C / Q / Z commands. This module turns that into the
 * engine's profile format with the potter's interpretation:
 *
 *   - The LEFTMOST point of the drawing is the wheel's axis of rotation:
 *     radius = x - minX. (You draw the right half of the silhouette.)
 *   - Figma's y grows DOWNWARD; a pot's height grows UP: height = maxY - y.
 *   - The drawing is normalized so the pot is always ~2 units tall — draw
 *     your curve at any size.
 *   - Profiles are foot-first: if the curve was drawn rim-to-foot, reverse it.
 *
 * Pure functions, zero dependencies — runs identically in the plugin sandbox
 * and under plain Node for testing.
 */

import type { WireProfilePoint } from "./messages.js";

type Point2 = { x: number; y: number };

/** How many straight segments approximate each curve command. The engine
 * arc-length-resamples afterwards, so this only needs to be "dense enough". */
const CURVE_STEPS = 12;

/**
 * Flatten Figma path data to a polyline. Supports the exact command set
 * Figma emits for vectorPaths (absolute M L C Q Z); anything else throws so
 * the caller can fall back to presets instead of building a mangled pot.
 */
export function flattenFigmaPath(data: string): Point2[] {
  const tokens = data.trim().split(/[\s,]+/);
  const points: Point2[] = [];
  let cursor: Point2 = { x: 0, y: 0 };
  let i = 0;

  const num = (): number => {
    const token = tokens[i++];
    const value = Number(token);
    if (token === undefined || Number.isNaN(value)) {
      throw new Error(`expected number, got "${token}" at token ${i - 1}`);
    }
    return value;
  };

  while (i < tokens.length) {
    const command = tokens[i++];
    switch (command) {
      case "M":
      case "L": {
        cursor = { x: num(), y: num() };
        points.push(cursor);
        break;
      }
      case "C": {
        const c1 = { x: num(), y: num() };
        const c2 = { x: num(), y: num() };
        const end = { x: num(), y: num() };
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          points.push({
            x: u * u * u * cursor.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
            y: u * u * u * cursor.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
          });
        }
        cursor = end;
        break;
      }
      case "Q": {
        const c = { x: num(), y: num() };
        const end = { x: num(), y: num() };
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          points.push({
            x: u * u * cursor.x + 2 * u * t * c.x + t * t * end.x,
            y: u * u * cursor.y + 2 * u * t * c.y + t * t * end.y,
          });
        }
        cursor = end;
        break;
      }
      case "Z":
        // A closed profile makes no sense for a half-silhouette; ignore the
        // closing segment rather than folding the wall back on itself.
        break;
      default:
        throw new Error(`unsupported path command "${command}"`);
    }
  }

  return points;
}

/** Target pot height in engine units (matches the preset scale). */
const POT_HEIGHT = 2;

/**
 * Interpret a flattened drawing as a vessel profile (see module docs for the
 * conventions). Throws when the drawing can't be a wall — degenerate height,
 * or fewer than 2 points.
 */
export function profileFromPolyline(polyline: Point2[]): WireProfilePoint[] {
  if (polyline.length < 2) throw new Error("need at least 2 points");

  const minX = Math.min(...polyline.map((p) => p.x));
  const minY = Math.min(...polyline.map((p) => p.y));
  const maxY = Math.max(...polyline.map((p) => p.y));
  const heightRange = maxY - minY;
  if (heightRange < 1e-3) throw new Error("curve has no vertical extent");

  const scale = POT_HEIGHT / heightRange;
  let profile = polyline.map((p) => ({
    radius: Math.max((p.x - minX) * scale, 0.001),
    height: (maxY - p.y) * scale, // flip: Figma y-down -> pot height-up
  }));

  // Foot-first: potters read profiles bottom-up.
  const first = profile[0]!;
  const last = profile[profile.length - 1]!;
  if (first.height > last.height) profile = profile.reverse();

  return profile;
}

/** One call for the sandbox: path text in, engine-ready profile out. */
export function profileFromFigmaPath(data: string): WireProfilePoint[] {
  return profileFromPolyline(flattenFigmaPath(data));
}
