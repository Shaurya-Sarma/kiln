/**
 * The room the glaze reflects.
 *
 * A glaze is glass, and the only thing glass has to show you is a picture of
 * its surroundings. Lit by directional lights alone, our pots got two hard
 * specular dots and read as painted plastic — because a bare directional light
 * is an infinitely small light source, and there is nothing else in the world
 * for the clearcoat to mirror. Photographers of ceramics never work that way:
 * they build a room out of softboxes, because the *shape of the reflection* is
 * the shape of the light.
 *
 * So we build the room. This module assembles a small studio out of emissive
 * panels and pre-filters it into a PMREM (Prefiltered, Mipmapped Radiance
 * Environment Map) — the cubemap chain three uses for image-based lighting,
 * where each successively blurrier mip serves a rougher material. Assigned to
 * `scene.environment`, it gives every glaze a believable studio reflection
 * without touching `scene.background`, so the page's warm paper still shows
 * through the transparent canvas.
 *
 * Why procedural rather than a downloaded HDR: the same engine runs inside a
 * Figma plugin iframe with a null origin and no network access. Anything the
 * pots need to reflect has to be built out of arithmetic at runtime.
 *
 * The room's layout follows studio practice for glossy round objects:
 *
 * - A broad **overhead softbox** — the sheen that rolls across a shoulder.
 * - Two **vertical strip boxes**, one strong and one weak. Strips are the
 *   single most important light on a thrown pot: a tall narrow source smeared
 *   around a cylinder becomes the long vertical highlight streak that reads
 *   unmistakably as "wet".
 * - A dim, cooler **panel behind** the pot for edge separation.
 * - A warm **floor bounce**, standing in for the paper the pot sits on.
 * - Dark warm walls between all of it. This is the part that is easy to miss:
 *   what makes glass look like glass is not brightness, it is CONTRAST — bright
 *   bands with darkness between them. An evenly bright environment produces a
 *   uniformly lit object, which is the definition of looking matte.
 */

import { BackSide, BoxGeometry, Mesh, MeshLambertMaterial, MeshStandardMaterial, PointLight, Scene, type Texture } from "three";
import { PMREMGenerator, type WebGPURenderer } from "three/webgpu";

/**
 * A softbox: an emissive-only panel. The emissive term is what lands in the
 * environment map; emissive materials do not illuminate their neighbours, which
 * is why the room's walls need their own point light below.
 */
function softbox(intensity: number, tint = 0xffffff): MeshLambertMaterial {
  return new MeshLambertMaterial({ color: 0x000000, emissive: tint, emissiveIntensity: intensity });
}

/**
 * Build the studio as a Scene. Units are "room units" and only the ANGLES
 * matter: image-based lighting is sampled by direction, so what the pot sees is
 * how much of its sky each panel covers, not how far away it is. The room is
 * centred on the origin, which is where the PMREM camera sits.
 */
function studioScene(): Scene {
  const scene = new Scene();
  const panel = new BoxGeometry();
  panel.deleteAttribute("uv"); // nothing here is textured

  // Warm near-black walls. This is where the contrast comes from, and it has to
  // be genuinely dark: the walls cover most of the pot's sky, so their
  // brightness sets the diffuse floor for the whole scene. A "tastefully dim
  // grey" room still washes a pale celadon out to white, because a wide dim
  // source delivers far more total light than a narrow bright one.
  const room = new Mesh(panel, new MeshStandardMaterial({ color: 0x241f1a, roughness: 1, side: BackSide }));
  room.scale.set(17, 15, 17);
  scene.add(room);

  // The walls are only visible in the reflection if something lights them.
  const bounceLight = new PointLight(0xfff1dd, 70, 26, 2);
  bounceLight.position.set(0, 5.5, 2.5);
  scene.add(bounceLight);

  // Overhead softbox — the broad sheen down the shoulder of the pot.
  const overhead = new Mesh(panel, softbox(9, 0xfff4e6));
  overhead.position.set(0.4, 7.1, 0.6);
  overhead.scale.set(6.5, 0.1, 5.5);
  scene.add(overhead);

  // Key strip, front-left and tall: the long vertical highlight on the wall.
  // Strips can afford to be fierce — a narrow source subtends little of the sky,
  // so it buys a bright specular streak for very little diffuse spill. That
  // trade is the whole reason studio photographers reach for strip boxes.
  const keyStrip = new Mesh(panel, softbox(46, 0xfff6ea));
  keyStrip.position.set(-5.9, 1.4, 3.9);
  keyStrip.scale.set(0.12, 8.2, 1.5);
  scene.add(keyStrip);

  // Fill strip, opposite and much weaker — a second, quieter streak that keeps
  // the shadow side of a round form from going dead flat.
  const fillStrip = new Mesh(panel, softbox(14, 0xf2f4ff));
  fillStrip.position.set(6.1, 1.9, 2.4);
  fillStrip.scale.set(0.12, 6.4, 1.1);
  scene.add(fillStrip);

  // Cool panel behind, for the bright edge that separates a dark tenmoku from
  // the background.
  const backPanel = new Mesh(panel, softbox(10, 0xe8eeff));
  backPanel.position.set(1.4, 2.8, -6.6);
  backPanel.scale.set(2.6, 4.4, 0.12);
  scene.add(backPanel);

  // Floor bounce, standing in for the warm paper the pot is photographed on.
  const floorBounce = new Mesh(panel, softbox(1.4, 0xffe9cf));
  floorBounce.position.set(0, -5.9, 1.5);
  floorBounce.scale.set(12, 0.1, 12);
  scene.add(floorBounce);

  return scene;
}

/**
 * Pre-filter the studio into an environment map for `scene.environment`.
 *
 * `PMREMGenerator` comes from `three/webgpu` in r185 and runs on the WebGPU
 * backend and its WebGL2 fallback alike (the Figma plugin pins WebGL2), but it
 * renders through the backend, so `await renderer.init()` must already have
 * happened. `sigma` is a pre-blur in radians: a touch of it softens the panel
 * edges into believable softbox falloff while leaving the strips crisp enough
 * to still read as streaks.
 */
export function studioEnvironment(renderer: WebGPURenderer): Texture {
  const scene = studioScene();
  const pmrem = new PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.025);
  // The scene and the generator were scaffolding; only the cubemap outlives
  // them. (The render target owning `texture` must NOT be disposed.)
  pmrem.dispose();
  scene.traverse((object) => {
    if (object instanceof Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
  return target.texture;
}
