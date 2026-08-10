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

// ---------------------------------------------------------------------------
// The finishing pass
// ---------------------------------------------------------------------------

/**
 * How thick, and how footed. All four are in pot units, and all four are
 * potter's measurements rather than rendering knobs.
 */
export type FinishOptions = {
  /**
   * Wall thickness at the lip. A thrown wall on a pot this size is a few
   * millimetres — small, but the difference between a vessel and a decal.
   */
  wallThickness?: number;
  /** How far down the inside the lip rolls before the wall thins out again. */
  rimReturn?: number;
  /** Height of the trimmed foot ring the pot stands on. */
  footHeight?: number;
  /** How far the underside is hollowed out above the ring's contact pad. */
  footRecess?: number;
};

/** A profile point carrying its pooling value, while the wall is under construction. */
type DetailedPoint = ProfilePoint & { concavity: number };

/** A direction in profile space. Same two axes as a ProfilePoint, no semantics. */
type Direction = { radius: number; height: number };

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Hermite ease, for tapering a wall without a visible crease at either end. */
function ease(k: number): number {
  const c = Math.min(Math.max(k, 0), 1);
  return c * c * (3 - 2 * c);
}

function normalize(d: Direction): Direction {
  const len = Math.hypot(d.radius, d.height) || 1;
  return { radius: d.radius / len, height: d.height / len };
}

/**
 * The outward-facing normal of the wall at sample `i` — i.e. which way is
 * "away from the clay". Rotate the local tangent a quarter turn; for a wall
 * climbing straight up this yields (+1, 0), pointing away from the axis.
 */
function outwardNormal(points: readonly ProfilePoint[], i: number): Direction {
  const before = points[Math.max(i - 1, 0)]!;
  const after = points[Math.min(i + 1, points.length - 1)]!;
  const tangent = normalize({ radius: after.radius - before.radius, height: after.height - before.height });
  return { radius: tangent.height, height: -tangent.radius };
}

/** Radius of the wall where it crosses a given height, walking foot -> rim. */
function radiusAtHeight(points: readonly DetailedPoint[], height: number): number | null {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (b.height >= height && a.height <= height) {
      const span = b.height - a.height || 1;
      return lerp(a.radius, b.radius, (height - a.height) / span);
    }
  }
  return null;
}

/**
 * Trim a foot ring.
 *
 * A pot straight off the wheel has a flat, slightly bulging base. Once it is
 * leather-hard the potter turns it upside down and cuts a **foot ring**: the
 * underside is hollowed out so the piece stands on a narrow raised ring rather
 * than on its whole bottom. Every thrown pot worth looking at has one, and it
 * shows up in two places even from above — a shadow line of undercut where the
 * wall tucks in, and a contact shadow that is a ring instead of a solid disc.
 *
 * Replaces everything below `footHeight` with the ring, so the pot still stands
 * on y = 0.
 */
function trimFootRing(body: readonly DetailedPoint[], footHeight: number, footRecess: number): DetailedPoint[] {
  const outer = radiusAtHeight(body, footHeight);
  // A profile too short to have a foot is left alone rather than mangled.
  if (outer === null || outer < 0.06) return [...body];

  const ringWidth = Math.min(0.085, outer * 0.38);
  const inner = outer - ringWidth;
  const padHeight = 0.012; // the ring's edges are rounded, not knife-cut
  const underside = footHeight + footRecess;

  const ring: DetailedPoint[] = [
    // The hollowed underside, running out from the axis...
    { radius: 0.001, height: underside, concavity: 0 },
    { radius: inner * 0.6, height: underside, concavity: 0 },
    { radius: inner, height: underside * 0.88, concavity: -0.1 },
    // ...then down the inside of the ring, across the pad it stands on, and
    // back up the outside.
    { radius: inner, height: padHeight, concavity: -0.3 },
    { radius: inner + ringWidth * 0.25, height: 0, concavity: -0.55 },
    { radius: outer - ringWidth * 0.25, height: 0, concavity: -0.55 },
    { radius: outer, height: padHeight, concavity: -0.3 },
    // Where the foot meets the wall, glaze running downhill collects in a bead.
    { radius: outer, height: footHeight, concavity: 0.4 },
  ];

  return [...ring, ...body.filter((p) => p.height > footHeight)];
}

/**
 * Roll the rim.
 *
 * The lathe surface is infinitely thin, so an unmodified rim renders as a
 * paper edge — the single most obvious tell that a pot is a spun curve and not
 * a vessel. A potter finishes a rim by compressing it with a chamois, leaving a
 * rounded lip with the wall's full thickness in it.
 *
 * So we do what the clay does: carry the surface over the top of the wall in a
 * semicircular cap one wall-thickness across, then bring it back DOWN the
 * inside. The inner wall then **tapers to a hairline** as it descends, so it
 * converges onto the outer surface and the lip melts into the single-thickness
 * wall below rather than ending in a visible ledge. (It tapers to a hairline
 * and not to exactly zero: coincident faces would z-fight.)
 */
function rollRim(body: readonly DetailedPoint[], wallThickness: number, rimReturn: number): DetailedPoint[] {
  const lip = body[body.length - 1]!;
  const outward = outwardNormal(body, body.length - 1);
  const tangent = normalize({ radius: -outward.height, height: outward.radius });
  const radius = wallThickness / 2;
  // Centre of the cap: half a wall in from the outer surface at the lip.
  const center = {
    radius: lip.radius - outward.radius * radius,
    height: lip.height - outward.height * radius,
  };

  const CAP_STEPS = 10;
  const cap: DetailedPoint[] = [];
  for (let s = 1; s <= CAP_STEPS; s++) {
    const theta = (s / CAP_STEPS) * Math.PI; // 0 = outer surface, PI = inner
    const half = theta / (Math.PI / 2);
    cap.push({
      radius: center.radius + radius * (outward.radius * Math.cos(theta) + tangent.radius * Math.sin(theta)),
      height: center.height + radius * (outward.height * Math.cos(theta) + tangent.height * Math.sin(theta)),
      // A lip is the sharpest ridge on the whole pot: glaze is pulled thinnest
      // over the crown (which is why tenmoku always breaks to rust there), then
      // pools again just inside where the surface turns back downhill.
      concavity: theta <= Math.PI / 2 ? lerp(lip.concavity, -1, half) : lerp(-1, 0.45, half - 1),
    });
  }

  const innerWall: DetailedPoint[] = [];
  let descended = 0;
  for (let i = body.length - 2; i >= 1 && descended < rimReturn; i--) {
    const point = body[i]!;
    const above = body[i + 1]!;
    descended += Math.hypot(above.radius - point.radius, above.height - point.height);
    const taper = ease(descended / rimReturn);
    const thickness = wallThickness * (1 - taper) + 0.003;
    const normal = outwardNormal(body, i);
    innerWall.push({
      radius: Math.max(point.radius - normal.radius * thickness, 0.001),
      height: point.height - normal.height * thickness,
      concavity: lerp(0.45, point.concavity, taper),
    });
  }

  return [...cap, ...innerWall];
}

/**
 * Resample a finished polyline to uniform arc-length spacing, carrying pooling
 * along by interpolation.
 *
 * Deliberately NOT the spline resampler above, and the two must not be merged:
 * `sampleProfile` smooths its input, which is exactly right for pen-tool points
 * and exactly wrong here — the foot ring's corners and the rim cap's curvature
 * are the *intent*, and a spline would round them away.
 */
function resampleFinished(poly: readonly DetailedPoint[], count: number): SampledProfile {
  const cumulative = [0];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    cumulative.push(cumulative[i - 1]! + Math.hypot(b.radius - a.radius, b.height - a.height));
  }
  const total = cumulative[cumulative.length - 1]!;

  const points: ProfilePoint[] = [];
  const t: number[] = [];
  const concavity: number[] = [];
  let cursor = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1)) * total;
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1]! < target) cursor++;
    const segStart = cumulative[cursor]!;
    const segLen = cumulative[cursor + 1]! - segStart || 1;
    const u = (target - segStart) / segLen;
    const a = poly[cursor]!;
    const b = poly[cursor + 1]!;
    points.push({
      radius: Math.max(lerp(a.radius, b.radius, u), 0.001),
      height: lerp(a.height, b.height, u),
    });
    t.push(k / (count - 1));
    concavity.push(lerp(a.concavity, b.concavity, u));
  }

  return { points, t, concavity, length: total };
}

/**
 * The finishing pass: give a thrown profile a foot to stand on and a lip with
 * real thickness, then re-establish the engine's two contracts on the result.
 *
 * Pure: same sampled profile in, same finished profile out. Both hosts get it
 * through `buildPotGeometry`, so a pot looks identical on the web and on the
 * Figma canvas.
 *
 * Both invariants are recomputed rather than inherited, because both changed:
 * the curve is longer now, so uniform spacing has to be re-established across
 * the new total length (or uv.y stops meaning arc length), and pooling has to
 * be authored for the added surfaces — which is where the rim's "breaking"
 * ridge and the bead above the foot come from.
 */
export function finishProfile(sampled: SampledProfile, options: FinishOptions = {}): SampledProfile {
  const { wallThickness = 0.045, rimReturn = 0.13, footHeight = 0.055, footRecess = 0.03 } = options;

  const body: DetailedPoint[] = sampled.points.map((p, i) => ({ ...p, concavity: sampled.concavity[i] ?? 0 }));
  const finished = [
    ...trimFootRing(body, footHeight, footRecess),
    ...rollRim(body, wallThickness, rimReturn),
  ];

  // Uniform spacing is a hard contract (uv.y IS arc length), so the rim cap
  // cannot be densified locally to resolve its curvature — the whole profile
  // has to be sampled finely enough to resolve the smallest feature on it. The
  // cap is a semicircle of arc length PI * wallThickness / 2; asking for ten
  // samples across it sets a floor on samples-per-pot-unit for everything.
  const CAP_SAMPLES = 10;
  const perUnit = Math.max(sampled.points.length / sampled.length, (2 * CAP_SAMPLES) / (Math.PI * wallThickness));
  const totalLength = finished.reduce(
    (sum, point, i) => (i === 0 ? 0 : sum + Math.hypot(point.radius - finished[i - 1]!.radius, point.height - finished[i - 1]!.height)),
    0,
  );

  return resampleFinished(finished, Math.max(sampled.points.length, Math.round(totalLength * perUnit)));
}
