/**
 * Profile -> 3D pot.
 *
 * A potter's wheel is a machine that sweeps a 2D silhouette through 360°.
 * The 3D version of that sweep is a "surface of revolution", which three.js
 * ships as LatheGeometry: give it the profile points, it places a copy of the
 * profile at N angles around the Y axis and stitches neighboring copies into
 * triangles.
 */

import { BufferAttribute, LatheGeometry, Vector2 } from "three";
import { type FinishOptions, type SampledProfile, finishProfile } from "./profile.js";

export type PotGeometryOptions = {
  /** How many angular steps around the axis. More = rounder silhouette. */
  radialSegments?: number;
  /** Wall thickness and foot, passed to the finishing pass (see profile.ts). */
  finish?: FinishOptions;
};

/**
 * Build the pot mesh geometry, with two guarantees the glaze materials rely on:
 *
 * 1. **uv.y is arc length.** LatheGeometry assigns v = j / (points - 1), i.e.
 *    by point index — which is only meaningful because we resampled the
 *    profile to uniform spacing first (profile.ts). Result: v measures real
 *    distance along the wall, so textures don't stretch and drips advance at
 *    a constant visual rate.
 *
 * 2. **A custom `aPooling` vertex attribute** carries the profile's concavity
 *    (where glaze pools) onto every vertex. We map it via uv.y rather than
 *    assuming LatheGeometry's vertex ordering, so this survives any internal
 *    reordering three might do between versions.
 */
export function buildPotGeometry(
  sampled: SampledProfile,
  { radialSegments = 128, finish }: PotGeometryOptions = {},
): LatheGeometry {
  // Spin the FINISHED profile, never the raw one. A thrown pot has a foot to
  // stand on and a lip with a wall's thickness in it; a bare sampled profile is
  // a zero-thickness ribbon whose rim renders as a paper edge. The finishing
  // pass re-establishes both contracts below on its longer curve, so everything
  // downstream is unchanged. Done here rather than at the call sites so the
  // playground and the Figma plugin cannot drift apart.
  const finished = finishProfile(sampled, finish ?? {});

  const points = finished.points.map((p) => new Vector2(p.radius, p.height));
  const geometry = new LatheGeometry(points, radialSegments);
  // NOTE: do NOT call computeVertexNormals() here. LatheGeometry already
  // computes normals that are averaged across the wrap seam (its first and
  // last vertex columns share positions); recomputing from face adjacency
  // gives the seam columns one-sided normals and paints a vertical lighting
  // line down the pot. (Found the hard way; kept as a warning.)

  const uv = geometry.getAttribute("uv");
  const pooling = new Float32Array(uv.count);
  const last = finished.concavity.length - 1;
  for (let i = 0; i < uv.count; i++) {
    const v = uv.getY(i); // 0 at foot, 1 at the inside of the lip (arc length)
    // Interpolate between the two nearest profile samples rather than snapping
    // to the closest one. Snapping quantised pooling into one flat band per
    // sample, and since the glazes drive COLOUR from this value, those bands
    // showed up on a smooth wall as faint horizontal contour rings.
    const j = Math.min(Math.max(v * last, 0), last);
    const low = Math.floor(j);
    const high = Math.min(low + 1, last);
    const frac = j - low;
    pooling[i] = finished.concavity[low]! * (1 - frac) + finished.concavity[high]! * frac;
  }
  geometry.setAttribute("aPooling", new BufferAttribute(pooling, 1));

  return geometry;
}
