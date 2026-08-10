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
  max,
  min,
  mix,
  mx_noise_float,
  oneMinus,
  positionViewDirection,
  smoothstep,
  texture,
  transformedNormalView,
  uv,
  vec3,
} from "three/tsl";
import { crystallineTexture, oilSpotTexture } from "./textures.js";

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
function surfaceNoise(around: number, upward: number) {
  const theta = uv().x.mul(Math.PI * 2);
  const ring = vec3(theta.cos().mul(around), theta.sin().mul(around), uv().y.mul(upward));
  return mx_noise_float(ring).mul(0.5).add(0.5); // MaterialX noise is signed
}

export type Atmosphere = "oxidation" | "reduction";

export type GlazeParams = {
  /** Kiln atmosphere. Reduction (oxygen-starved) vs oxidation (oxygen-rich). */
  atmosphere: Atmosphere;
  /** This firing's seed — same seed, same pot. */
  seed: number;
};

export type FiringParams = GlazeParams & {
  /** Minutes held at the crystal-growth temperature (crystalline glazes). */
  holdMinutes: number;
};

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
export function createCeladonMaterial({ atmosphere }: GlazeParams): MeshPhysicalNodeMaterial {
  const palette =
    atmosphere === "reduction"
      ? { thin: new Color("#dee7dc"), pooled: new Color("#2f6d55") }
      : { thin: new Color("#eee0be"), pooled: new Color("#8c6320") };
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

  // Applied thickness: a dipped coat everywhere, plus wherever it pooled. Then
  // stretch it by the viewing angle and let the melt absorb along that path.
  const APPLIED_COAT = 0.52;
  const thickness = poolAmount.mul(1.5).add(APPLIED_COAT).mul(viewPathMultiplier());
  const depth = absorbed(thickness, 1.0);

  // Where the coat is thinnest, the speckled stoneware underneath shows through
  // as faint iron freckles — the tell that there is a clay body under the glass
  // and not just coloured plastic.
  const speckle = smoothstep(float(0.64), float(0.88), surfaceNoise(11, 52)).mul(oneMinus(depth)).mul(0.34);

  material.colorNode = mix(mix(color(palette.thin), color(palette.pooled), depth), color(clayBody), speckle);

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
  material.colorNode = mix(pooled, pooled.mul(0.62), depth.mul(0.68));

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
export function createTenmokuMaterial({ atmosphere, seed }: GlazeParams): MeshPhysicalNodeMaterial {
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

  const spots = texture(oilSpotTexture({ seed }));
  material.colorNode = mix(base, spots.rgb, spots.a);

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
