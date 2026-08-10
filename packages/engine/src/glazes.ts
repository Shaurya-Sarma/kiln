/**
 * Glaze materials.
 *
 * Written in TSL (Three Shading Language): shader logic composed as node
 * expressions in TypeScript, which three.js compiles to WGSL on the WebGPU
 * backend and GLSL on the WebGL2 fallback. One material definition, both APIs.
 *
 * Design rule for every glaze here: parameters are POTTERY variables
 * (atmosphere, application thickness, firing seed), never raw shader knobs.
 * The translation from craft language to rendering math happens inside this
 * file and nowhere else.
 */

import { Color, DoubleSide } from "three";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import {
  attribute,
  color,
  dot,
  exp,
  float,
  hue,
  max,
  min,
  mix,
  mx_noise_float,
  oneMinus,
  positionViewDirection,
  saturation as saturationAdjust,
  smoothstep,
  texture,
  transformedNormalView,
  uv,
  vec3,
} from "three/tsl";
import { ashTexture, copperRedTexture, crystallineTexture, oilSpotTexture, shinoTexture } from "./textures.js";
import { mulberry32 } from "./rng.js";
import type Node from "three/src/nodes/core/Node.js";

/**
 * How far light travels through the glaze layer before it comes back out.
 *
 * This is the physical fact that makes a glaze look like glass rather than like
 * paint, and the one our first pass was missing. A glaze is a translucent
 * coloured layer over a pale clay body; you see its colour because light dives
 * in, crosses the layer, bounces off the body and crosses back. So the colour
 * you get depends on PATH LENGTH, and path length depends on viewing angle:
 * look straight at a wall and you cross the layer twice, look along it near the
 * silhouette and the same layer is optically many times thicker. That secant
 * falloff (1/cos of the view angle) is exactly why a celadon bowl looks white
 * at the middle and deep jade toward its edges — and why potters judge a glaze
 * by tilting the pot.
 *
 * Returned as a multiplier on the glaze's applied thickness. Clamped away from
 * zero because the secant goes to infinity precisely at the silhouette.
 */
function viewPathMultiplier() {
  const facing = dot(transformedNormalView, positionViewDirection).abs().clamp(0.09, 1);
  return float(1).div(facing);
}

/**
 * Absorption, Beer-Lambert style: colour saturates toward the deep tone as path
 * length grows, instead of increasing forever and clipping. `opacity` is the
 * glaze's absorption strength — how strongly coloured the melt is.
 */
function absorbed(thickness: ReturnType<typeof viewPathMultiplier>, opacity: number) {
  return oneMinus(exp(thickness.mul(-opacity)));
}

/**
 * Seamless surface noise, in cylindrical coordinates.
 *
 * Feeding uv().x straight into a noise function would put a hard vertical line
 * down the pot: u = 0 and u = 1 are the same points in space but different
 * numbers, so the noise disagrees with itself across the wrap seam. Sampling on
 * a RING instead — the actual circle the wall traces — makes the noise
 * seamless by construction, because the ring closes. Same rule the textures
 * module learned the hard way (see textures.ts), enforced here by geometry
 * rather than by care.
 */
function surfaceNoise(around: number, upward: number, shift = 0) {
  const theta = uv().x.mul(Math.PI * 2);
  // `shift` slides the sampling window along the axis: seed-derived shifts are
  // how the SAME noise field gives every firing different speckle placement.
  const ring = vec3(theta.cos().mul(around), theta.sin().mul(around), uv().y.mul(upward).add(shift));
  return mx_noise_float(ring).mul(0.5).add(0.5); // MaterialX noise is signed
}

export type Atmosphere = "oxidation" | "reduction";

/**
 * The colorant: which metal oxide is dissolved in the melt. This is how real
 * glazes get their colour — iron gives celadon its jade and tenmoku its black,
 * copper gives oxblood, cobalt gives every classic blue. Swapping the oxide
 * re-colours a base glaze, and (faithfully to real ceramics) the same oxide
 * lands differently in every base — cobalt celadon is a quiet winter blue,
 * cobalt shino goes lavender. Test tiles exist for a reason.
 */
export type Colorant = "iron" | "cobalt" | "chrome" | "manganese" | "rutile";

/** Hue rotation (radians) + saturation scale per oxide, applied to a glaze's
 * final colour. Iron is the identity: every base palette was authored as its
 * traditional iron-bearing self. */
const COLORANT_SHIFT: Record<Colorant, { hue: number; sat: number }> = {
  iron: { hue: 0, sat: 1 },
  cobalt: { hue: 1.2, sat: 1.2 },
  chrome: { hue: -0.9, sat: 1.05 },
  manganese: { hue: 2.9, sat: 0.9 },
  rutile: { hue: -0.35, sat: 0.8 },
};

/**
 * The same oxide shift, applied to a plain CSS colour on the CPU — for
 * thumbnails, swatches, anything that previews a glaze without running the
 * shader. Sharing the COLORANT_SHIFT table is what keeps a pot's shelf sketch
 * and the pot itself from ever disagreeing about what cobalt means.
 */
export function colorantTint(hex: string, colorant: Colorant): string {
  if (colorant === "iron") return hex;
  const shift = COLORANT_SHIFT[colorant];
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + shift.hue / (Math.PI * 2)) % 1, Math.min(hsl.s * shift.sat, 1), hsl.l);
  return `#${c.getHexString()}`;
}

/** Wrap a glaze's final colour in its colorant. Identity for iron — the
 * shader graph stays untouched for the traditional recipes. */
function withColorant(node: Node<"vec3">, colorant: Colorant): Node<"vec3"> {
  const shift = COLORANT_SHIFT[colorant];
  if (colorant === "iron") return node;
  return saturationAdjust(hue(node, shift.hue), shift.sat);
}

export type GlazeParams = {
  /** Kiln atmosphere. Reduction (oxygen-starved) vs oxidation (oxygen-rich). */
  atmosphere: Atmosphere;
  /** This firing's seed — same seed, same pot. */
  seed: number;
  /**
   * Minutes soaked at peak temperature. Crystals grow with it — but so does
   * everything else: a longer soak matures every melt, so glazes run further,
   * pool deeper, blush wider. Every material consumes this; a control that
   * only worked on one glaze out of six was a control that lied.
   */
  holdMinutes: number;
  /** Which metal oxide colours the melt. See {@link Colorant}. */
  colorant: Colorant;
};

/** @deprecated alias kept for the plugin's imports — same shape now. */
export type FiringParams = GlazeParams;

/**
 * Celadon.
 *
 * The classic East Asian iron glaze. Its entire beauty is depth-of-color:
 * translucent glass that reads pale where thin and saturated where it pools in
 * grooves and at the foot. Chemistry note that the atmosphere toggle encodes:
 * the SAME iron oxide fires jade-green in reduction but honey-amber in
 * oxidation — kiln oxygen, not recipe, decides the hue.
 *
 * Rendering: one idea, executed carefully — the colour is what the glaze
 * ABSORBS, so it follows the distance light travels inside the layer:
 *   finalColor = mix(bodyColour, deepColour, absorbed(thickness x viewPath))
 * Thickness comes from the geometry's baked aPooling attribute (grooves) plus a
 * boost near the foot (molten glaze runs downhill and collects there); viewPath
 * is the secant of the viewing angle. The second factor is what a flat
 * `mix(thin, pooled, pooling)` was missing, and it is most of the difference
 * between "pale green plastic" and "glass with something dissolved in it".
 */
export function createCeladonMaterial({ atmosphere, seed, holdMinutes, colorant }: GlazeParams): MeshPhysicalNodeMaterial {
  const melt = Math.min(holdMinutes / 90, 1); // soak maturity, 0..1
  // The seed is the kiln's fingerprint, and celadon must carry it too: dip
  // thickness varies (nobody dips identically twice), speckles land elsewhere,
  // and the fired hue drifts with kiln position. Without this, "fire again"
  // on the DEFAULT glaze produced an identical pot — the thesis, broken
  // exactly where a first-time visitor tests it.
  const kiln = mulberry32(seed ^ 0xce1ad);
  const drift = (kiln() - 0.5) * 0.4; // warmer or cooler corner of the kiln
  const palette =
    atmosphere === "reduction"
      ? { thin: new Color("#dee7dc"), pooled: new Color("#2f6d55").lerp(new Color("#2f5d75"), drift + 0.11) }
      : { thin: new Color("#eee0be"), pooled: new Color("#8c6320").lerp(new Color("#a4491f"), drift + 0.11) };
  // Iron speckle in the stoneware body, visible only through thin glaze.
  const clayBody = new Color("#8d7357");

  const material = new MeshPhysicalNodeMaterial();
  // Lathe walls have no thickness (a deliberate scope cut) — render both faces
  // so open forms like bowls show their inside.
  material.side = DoubleSide;

  // Explicit generic: the typings widen attribute's inferred node type to
  // `string`, which unifies with nothing — pinning <"float"> restores the
  // typed chainable node.
  const pooling = attribute<"float">("aPooling", "float");
  const v = uv().y; // arc length up the wall: 0 = foot, 1 = rim

  // Grooves pool (positive concavity); the foot pools regardless of shape.
  const grooves = max(pooling, 0).mul(0.9);
  const foot = smoothstep(float(0.3), float(0.0), v).mul(0.55);
  const poolAmount = grooves.add(foot).clamp(0, 1);

  // Applied thickness: a dipped coat everywhere — but no two dips are equal
  // (this firing's coat is scaled by the seed), plus broad soft patches where
  // the dip ran thick, plus wherever gravity pooled it. Then stretch by the
  // viewing angle and let the melt absorb along that path.
  const APPLIED_COAT = 0.52 * (0.82 + kiln() * 0.4);
  const dipPatches = surfaceNoise(2.2, 6, kiln() * 73).sub(0.5).mul(0.85);
  // A longer soak runs the melt: pooling deepens with hold maturity.
  const thickness = poolAmount.mul(1.1 + melt * 0.9).add(APPLIED_COAT).add(dipPatches).max(0.12).mul(viewPathMultiplier());
  const depth = absorbed(thickness, 1.0);

  // Where the coat is thinnest, the speckled stoneware underneath shows through
  // as faint iron freckles — the tell that there is a clay body under the glass
  // and not just coloured plastic.
  const speckle = smoothstep(float(0.64), float(0.88), surfaceNoise(11, 52, kiln() * 97)).mul(oneMinus(depth)).mul(0.34);

  material.colorNode = withColorant(
    mix(mix(color(palette.thin), color(palette.pooled), depth), color(clayBody), speckle),
    colorant,
  );

  // Glassy surface: glaze IS glass. Clearcoat gives the wet-looking skin.
  material.roughness = 0.18;
  material.clearcoat = 1.0;
  // Not a constant: a dipped glaze dries with a faint orange-peel undulation,
  // so the clearcoat's sharpness wanders slightly. It is a small number doing a
  // lot of work — a perfectly uniform clearcoat is the look of a 3D render, and
  // breaking it up is what stops the highlight streaks reading as decals.
  material.clearcoatRoughnessNode = float(0.14).add(surfaceNoise(5, 26).mul(0.16));

  return material;
}

/**
 * Crystalline.
 *
 * Zinc-silicate glazes that grow visible flower-shaped crystals
 * ("spherulites"). The structure of the simulation mirrors the real physics:
 * the SEED decides where crystals nucleate, the firing's HOLD TIME decides how
 * big they grow (published kinetics: growth happens only while the kiln holds
 * in the growth-temperature window). The spherulite constellation is
 * synthesized as a seeded texture (textures.ts); the material samples it and
 * adds glassy depth on top.
 */
export function createCrystallineMaterial(params: FiringParams): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  // Lathe walls have no thickness (a deliberate scope cut) — render both faces
  // so open forms like bowls show their inside.
  material.side = DoubleSide;

  const blooms = texture(crystallineTexture(params));

  // Slight darkening where the glaze pools — crystalline glazes are runny
  // glass too, and the pooled edge grounds the pot visually.
  const pooling = max(attribute<"float">("aPooling", "float"), 0).mul(0.25);
  const pooled = mix(blooms.rgb, blooms.rgb.mul(0.72), pooling);

  // The matrix between the crystals is glass too, so it darkens toward the
  // silhouette for the same reason celadon does — just weakly, because a
  // crystalline glaze gets most of its colour from the crystals themselves
  // rather than from a dissolved colourant.
  const depth = absorbed(viewPathMultiplier(), 0.42);
  material.colorNode = withColorant(mix(pooled, pooled.mul(0.62), depth.mul(0.68)), params.colorant);

  // Crystals sit in a very fluid, high-gloss glaze.
  material.roughness = 0.12;
  material.clearcoat = 1.0;
  // A crystalline glaze is fired so runny that its surface visibly flows, so
  // its clearcoat wanders more than a well-behaved celadon's — coarser noise,
  // wider swing.
  material.clearcoatRoughnessNode = float(0.08).add(surfaceNoise(3.5, 14).mul(0.17));

  return material;
}

/**
 * Tenmoku.
 *
 * The iron-saturated near-black of Song-dynasty tea bowls. Two signatures:
 * it "breaks" to rust where the glaze runs thin (rims and ridges — exactly
 * where our pooling attribute goes NEGATIVE), and "oil spots" — silvery
 * freckles left where oxygen bubbles dragged iron to the surface. Breaking is
 * pure geometry math; the spots are a seeded texture blended by its alpha.
 */
export function createTenmokuMaterial({ atmosphere, seed, holdMinutes, colorant }: GlazeParams): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  // Lathe walls have no thickness (a deliberate scope cut) — render both faces
  // so open forms like bowls show their inside.
  material.side = DoubleSide;

  const iron = new Color("#1d1410");
  const rust = atmosphere === "reduction" ? new Color("#8a4a24") : new Color("#a2551d");

  const pooling = attribute<"float">("aPooling", "float");
  const v = uv().y;

  // Thin glaze = ridges (negative pooling) + the rim itself. Both break to rust.
  const ridges = min(pooling, 0).negate().mul(1.4);
  const rim = smoothstep(float(0.82), float(1.0), v).mul(0.9);
  const breaking = ridges.add(rim).clamp(0, 1);

  const base = mix(color(iron), color(rust), breaking);

  const spots = texture(oilSpotTexture({ seed, holdMinutes }));
  material.colorNode = withColorant(mix(base, spots.rgb, spots.a), colorant);

  material.roughness = 0.3;
  material.clearcoat = 0.9;
  // Tenmoku is a thick, stiff glaze that does not level out the way a fluid one
  // does, so its skin is the least even of the three.
  material.clearcoatRoughnessNode = float(0.22).add(surfaceNoise(4.5, 20).mul(0.22));

  // Oil spots are iron crystals that surfaced out of the melt, and crystals
  // scatter where glass reflects — so the freckles are satin against the wet
  // black around them. Without this they read as painted-on dots.
  material.roughnessNode = float(0.3).add(spots.a.mul(0.22));

  return material;
}

/**
 * Shino — the glaze that does what it wants.
 *
 * A thick feldspathic white that blushes orange where the flame licked it and
 * traps grey carbon where reduction smoke got sealed under the melt. Famously
 * uncallable before the kiln opens, which makes it this app's thesis glaze.
 * All the event placement lives in the seeded texture; the material's job is
 * shino's SKIN: satin, not glassy — a thick coat that ate its own shine.
 */
export function createShinoMaterial(params: GlazeParams): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  // Lathe walls have no thickness (a deliberate scope cut) — render both faces
  // so open forms like bowls show their inside.
  material.side = DoubleSide;
  const kiln = mulberry32(params.seed ^ 0x5711);

  const blushes = texture(shinoTexture(params));
  // Where the coat thins over ridges and the rim, shino toasts orange — the
  // same geometry facts tenmoku uses, warmed instead of rusted.
  const pooling = attribute<"float">("aPooling", "float");
  const toastRidges = smoothstep(float(0.18), float(0.6), min(pooling, 0).negate());
  const toast = toastRidges.mul(0.8).add(smoothstep(float(0.88), float(1.0), uv().y).mul(0.5)).clamp(0, 1);
  material.colorNode = withColorant(mix(blushes.rgb, blushes.rgb.mul(vec3(1.12, 0.82, 0.6)), toast), params.colorant);

  material.roughness = 0.42;
  material.clearcoat = 0.35;
  material.clearcoatRoughnessNode = float(0.3).add(surfaceNoise(6, 30, kiln() * 83).mul(0.25));
  return material;
}

/**
 * Copper red (oxblood) — the atmosphere glaze.
 *
 * One recipe, two pots: starve the kiln of oxygen and copper turns blood-red
 * with violet flambé veils; give it air and the same copper settles into a
 * quiet green. The rim breaks pale where the red ran thin — the classic
 * "white lip" of an oxblood — using the same geometry facts as tenmoku's rust.
 */
export function createCopperRedMaterial(params: GlazeParams): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  // Lathe walls have no thickness (a deliberate scope cut) — render both faces
  // so open forms like bowls show their inside.
  material.side = DoubleSide;
  const kiln = mulberry32(params.seed ^ 0xb100d);

  const base = texture(copperRedTexture(params));
  const pooling = attribute<"float">("aPooling", "float");
  // Deadzone on the ridge term: a gently convex belly is NOT a ridge, and
  // without the threshold the whole body washed pale. Only genuinely sharp
  // convexity (the lip roll, the foot turn) lets the red run thin.
  const ridges = smoothstep(float(0.18), float(0.6), min(pooling, 0).negate());
  const lip = ridges.mul(0.9).add(smoothstep(float(0.86), float(1.0), uv().y).mul(0.85)).clamp(0, 1);
  const lipColor = params.atmosphere === "reduction" ? new Color("#ded2c2") : new Color("#e7e3d2");
  material.colorNode = withColorant(mix(base.rgb, color(lipColor), lip.mul(0.8)), params.colorant);

  // Oxblood is deep wet glass; the oxidation green is drier, closer to satin.
  const glassy = params.atmosphere === "reduction";
  material.roughness = glassy ? 0.14 : 0.34;
  material.clearcoat = glassy ? 1.0 : 0.5;
  material.clearcoatRoughnessNode = float(glassy ? 0.1 : 0.26).add(surfaceNoise(4, 18, kiln() * 59).mul(0.18));
  return material;
}

/**
 * Ash — gravity made visible.
 *
 * Wood ash melts into runny green-amber glass that rivulets down the wall.
 * The seeded texture carries the drips; the material deepens wherever the
 * geometry pools (drips and grooves agree: that is where the glass is thick)
 * and keeps a coarse, orchard-fired skin.
 */
export function createAshMaterial(params: GlazeParams): MeshPhysicalNodeMaterial {
  const material = new MeshPhysicalNodeMaterial();
  // Lathe walls have no thickness (a deliberate scope cut) — render both faces
  // so open forms like bowls show their inside.
  material.side = DoubleSide;
  const kiln = mulberry32(params.seed ^ 0xa511e);

  const runs = texture(ashTexture(params));
  const pooling = max(attribute<"float">("aPooling", "float"), 0);
  // Thick ash glass goes deep olive — multiply toward green rather than black.
  material.colorNode = withColorant(mix(runs.rgb, runs.rgb.mul(vec3(0.55, 0.72, 0.45)), pooling.mul(0.8).clamp(0, 1)), params.colorant);

  material.roughness = 0.3;
  material.clearcoat = 0.7;
  material.clearcoatRoughnessNode = float(0.18).add(surfaceNoise(5, 24, kiln() * 71).mul(0.24));
  return material;
}
