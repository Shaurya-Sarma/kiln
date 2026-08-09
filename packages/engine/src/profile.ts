/**
 * A pot is a 2D curve, spun.
 *
 * The engine's core data type is a vessel profile: a list of (radius, height)
 * points describing the pot's cross-section from foot (bottom) to rim (top) —
 * exactly the silhouette a potter draws before sitting at the wheel. Everything
 * else (geometry, glaze pooling, drips) derives from this one array.
 */

export type ProfilePoint = {
  /** Distance from the axis of rotation, in pot units. Must be >= 0. */
  radius: number;
  /** Height above the foot, in pot units. Must increase foot -> rim. */
  height: number;
};

/** Raw input profile: what a pen tool or preset gives us. Foot first, rim last. */
export type Profile = readonly ProfilePoint[];

/**
 * A profile after resampling: uniform spacing along the curve, plus the
 * per-sample facts every glaze needs. This is the engine's working format.
 */
export type SampledProfile = {
  points: ProfilePoint[];
  /** Cumulative distance along the curve, normalized 0 (foot) -> 1 (rim). */
  t: number[];
  /**
   * How concave the surface is at each sample, in [-1, 1].
   * Positive = curves inward (a groove — glaze pools here, gets thicker).
   * Negative = curves outward (a ridge — glaze thins, "breaks" on rims).
   */
  concavity: number[];
  /** Total curve length in pot units (useful for scaling drip distances). */
  length: number;
};

/**
 * Catmull-Rom interpolation for one segment. A Catmull-Rom spline is the
 * standard "smooth curve through ALL the given points" (unlike a bezier, whose
 * control points pull the curve without lying on it). We use it so a handful
 * of profile points becomes a silky curve, the way a rib smooths a wall.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * u +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  );
}

function at(profile: Profile, i: number): ProfilePoint {
  // Clamp instead of wrapping: duplicating the end points makes the spline
  // pass through the first and last profile points exactly.
  const p = profile[Math.min(Math.max(i, 0), profile.length - 1)];
  if (!p) throw new Error("profile must have at least one point");
  return p;
}

/**
 * Resample a raw profile to `count` points spaced UNIFORMLY BY DISTANCE along
 * the smoothed curve (arc-length parameterization).
 *
 * Why this matters: pen-tool input is unevenly spaced — dense where the user
 * fiddled, sparse elsewhere. Texture coordinates derived from raw point index
 * would stretch and bunch glaze patterns. After this, "v = 0.2" always means
 * "20% of the way up the actual surface", so drips flow at a constant rate.
 */
export function sampleProfile(profile: Profile, count = 96): SampledProfile {
  if (profile.length < 2) throw new Error("profile needs at least 2 points");

  // 1. Densely evaluate the spline (way more points than we'll keep).
  const dense: ProfilePoint[] = [];
  const DENSITY = 16;
  for (let i = 0; i < profile.length - 1; i++) {
    for (let s = 0; s < DENSITY; s++) {
      const u = s / DENSITY;
      dense.push({
        radius: Math.max(
          catmullRom(at(profile, i - 1).radius, at(profile, i).radius, at(profile, i + 1).radius, at(profile, i + 2).radius, u),
          0.001, // a lathe point exactly on the axis creates degenerate triangles
        ),
        height: catmullRom(at(profile, i - 1).height, at(profile, i).height, at(profile, i + 1).height, at(profile, i + 2).height, u),
      });
    }
  }
  dense.push(at(profile, profile.length - 1));

  // 2. Cumulative arc length of the dense polyline.
  const cumulative = [0];
  for (let i = 1; i < dense.length; i++) {
    const a = dense[i - 1]!;
    const b = dense[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b.radius - a.radius, b.height - a.height));
  }
  const total = cumulative[cumulative.length - 1]!;

  // 3. Walk the polyline picking `count` points at equal length intervals.
  const points: ProfilePoint[] = [];
  const t: number[] = [];
  let cursor = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * total;
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1]! < target) cursor++;
    const segStart = cumulative[cursor]!;
    const segLen = cumulative[cursor + 1]! - segStart || 1;
    const u = (target - segStart) / segLen;
    const a = dense[cursor]!;
    const b = dense[cursor + 1]!;
    points.push({
      radius: a.radius + (b.radius - a.radius) * u,
      height: a.height + (b.height - a.height) * u,
    });
    t.push(k / (count - 1));
  }

  return { points, t, concavity: computeConcavity(points), length: total };
}

/**
 * Where does glaze pool?
 *
 * Molten glaze runs into grooves and sits thicker there; it thins over ridges
 * and rims. Geometrically: a point is in a groove when its neighbors stick out
 * further than it does — i.e. the radius curve is locally concave. We measure
 * that with a second difference (the discrete second derivative), then smooth
 * it so one noisy sample doesn't read as a groove.
 *
 * Every glaze material consumes this: celadon deepens where it's positive,
 * tenmoku breaks to rust where it's negative.
 */
function computeConcavity(points: ProfilePoint[]): number[] {
  const raw = points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return 0;
    const neighborAvg = (points[i - 1]!.radius + points[i + 1]!.radius) / 2;
    return neighborAvg - p.radius; // + = neighbors stick out = groove
  });

  // Normalize to [-1, 1] against the profile's own scale so shallow bowls and
  // deep vases both get a full range of pooling.
  const max = Math.max(...raw.map(Math.abs), 1e-6);

  // 3-tap box blur, two passes: cheap smoothing against sample noise.
  let smoothed = raw.map((v) => v / max);
  for (let pass = 0; pass < 2; pass++) {
    smoothed = smoothed.map((v, i) => {
      const prev = smoothed[i - 1] ?? v;
      const next = smoothed[i + 1] ?? v;
      return (prev + v + next) / 3;
    });
  }
  return smoothed;
}
