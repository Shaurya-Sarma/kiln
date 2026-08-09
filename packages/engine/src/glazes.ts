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

import { Color } from "three";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import { attribute, color, float, mix, smoothstep, uv } from "three/tsl";

export type Atmosphere = "oxidation" | "reduction";

export type GlazeParams = {
  /** Kiln atmosphere. Reduction (oxygen-starved) vs oxidation (oxygen-rich). */
  atmosphere: Atmosphere;
  /** This firing's seed — same seed, same pot. */
  seed: number;
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

  const pooling = attribute("aPooling", "float");
  const v = uv().y; // arc length up the wall: 0 = foot, 1 = rim

  // Grooves pool (positive concavity); the foot pools regardless of shape.
  const grooves = pooling.max(0).mul(0.9);
  const foot = smoothstep(float(0.3), float(0.0), v).mul(0.55);
  const poolAmount = grooves.add(foot).clamp(0, 1);

  material.colorNode = mix(color(palette.thin), color(palette.pooled), poolAmount);

  // Glassy surface: glaze IS glass. Clearcoat gives the wet-looking skin.
  material.roughness = 0.18;
  material.clearcoat = 1.0;
  material.clearcoatRoughness = 0.25;

  return material;
}
