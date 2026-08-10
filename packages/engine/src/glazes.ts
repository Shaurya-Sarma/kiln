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
import { attribute, color, float, max, min, mix, smoothstep, texture, uv } from "three/tsl";
import { crystallineTexture, oilSpotTexture } from "./textures.js";

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
 * Rendering: one idea, executed carefully —
 *   finalColor = mix(thinColor, pooledColor, pooling)
 * where pooling = the geometry's baked aPooling attribute (grooves) plus a
 * boost near the foot (molten glaze runs downhill and collects there).
 */
export function createCeladonMaterial({ atmosphere }: GlazeParams): MeshPhysicalNodeMaterial {
  const palette =
    atmosphere === "reduction"
      ? { thin: new Color("#cadcca"), pooled: new Color("#3f7d61") }
      : { thin: new Color("#e3d3ae"), pooled: new Color("#a67c2e") };

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

  material.colorNode = mix(color(palette.thin), color(palette.pooled), poolAmount);

  // Glassy surface: glaze IS glass. Clearcoat gives the wet-looking skin.
  material.roughness = 0.18;
  material.clearcoat = 1.0;
  material.clearcoatRoughness = 0.25;

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
  material.colorNode = mix(blooms.rgb, blooms.rgb.mul(0.72), pooling);

  // Crystals sit in a very fluid, high-gloss glaze.
  material.roughness = 0.12;
  material.clearcoat = 1.0;
  material.clearcoatRoughness = 0.15;

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
  material.clearcoatRoughness = 0.35;

  return material;
}
