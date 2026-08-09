/**
 * Procedural glaze textures.
 *
 * Some glaze features are patterns, not per-pixel math — crystalline blooms,
 * tenmoku oil spots. We synthesize those on a 2D canvas at firing time, from
 * the firing's seeded RNG, and hand the result to the material as a texture.
 * No image files anywhere: every pattern is grown from the seed, which is what
 * makes "fire again" produce a genuinely different pot.
 *
 * The canvas wraps horizontally (u = angle around the pot), so patterns that
 * cross the left edge must reappear on the right — see wrapX() below.
 */

import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import { mulberry32 } from "./rng.js";
import type { Atmosphere } from "./glazes.js";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(size: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx2D } {
  // OffscreenCanvas keeps the engine independent of the page's DOM (and works
  // in workers); fall back to a DOM canvas for older environments.
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas available");
  return { canvas, ctx };
}

function toTexture(canvas: HTMLCanvasElement | OffscreenCanvas): CanvasTexture {
  const texture = new CanvasTexture(canvas as HTMLCanvasElement);
  texture.wrapS = RepeatWrapping; // u is the angle around the pot — must wrap
  texture.colorSpace = SRGBColorSpace;
  // Fine needle strokes alias into moiré rings when the texture curves away
  // from the camera; anisotropic filtering samples the mip pyramid correctly
  // at grazing angles and kills the rings.
  texture.anisotropy = 8;
  return texture;
}

/** Run draw() at x, x - size and x + size so patterns wrap around the pot seam. */
function wrapX(size: number, x: number, draw: (x: number) => void) {
  draw(x);
  if (x < size * 0.25) draw(x + size);
  if (x > size * 0.75) draw(x - size);
}

export type CrystallineParams = {
  seed: number;
  atmosphere: Atmosphere;
  /**
   * Minutes held at the crystal-growth temperature. The real kinetics:
   * nucleation happens on the way down, then crystals grow only while the
   * kiln HOLDS in the growth window — longer hold, larger spherulites.
   */
  holdMinutes: number;
};

/**
 * Crystalline glaze: willemite-style spherulites as a seeded texture.
 *
 * Structure mirrors the real phenomenon:
 * 1. The seed scatters nucleation sites (where a crystal happens to start).
 * 2. Hold time sets growth radius (30 min = modest blooms, 90 = show-offs).
 * 3. Each spherulite is a fan of needle crystals radiating from its center —
 *    drawn as tapered strokes with a bright nucleus.
 */
export function crystallineTexture({ seed, atmosphere, holdMinutes }: CrystallineParams): CanvasTexture {
  // 2048² so needle strokes stay crisp on a full-screen pot. Generated once
  // per firing, so the 4x pixel cost over 1024² is invisible in practice.
  const SIZE = 2048;
  const { canvas, ctx } = makeCanvas(SIZE);
  const rand = mulberry32(seed);

  const palette =
    atmosphere === "reduction"
      ? { top: "#e3ecef", bottom: "#a9c3cf", needle: "63,118,148", nucleus: "#f4fbff" }
      : { top: "#f0e7d2", bottom: "#d4bd8e", needle: "141,95,25", nucleus: "#fff7e2" };

  // Base glaze: vertical gradient (thicker/darker toward the foot) + faint mottle.
  const grad = ctx.createLinearGradient(0, 0, 0, SIZE);
  grad.addColorStop(0, palette.top);
  grad.addColorStop(1, palette.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Mottle: soft, sparse patches (hard 1px dots moiré badly when the texture
  // is minified on a curved surface — learned the hard way). Plan first, then
  // draw, so wrap duplicates are pixel-identical (see note on wrapX below).
  const patches = Array.from({ length: 260 }, () => ({
    x: rand() * SIZE,
    y: rand() * SIZE,
    r: 8 + rand() * 22,
    alpha: 0.03 + rand() * 0.04,
  }));
  for (const patch of patches) {
    wrapX(SIZE, patch.x, (x) => {
      const g = ctx.createRadialGradient(x, patch.y, 0, x, patch.y, patch.r);
      g.addColorStop(0, `rgba(${palette.needle},${patch.alpha})`);
      g.addColorStop(1, `rgba(${palette.needle},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, patch.y, patch.r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Growth: hold time → bloom radius, saturating like the real kinetics
  // (diffusion feeds crystals more slowly as they fatten).
  const growth = Math.min(holdMinutes / 90, 1);
  const baseRadius = SIZE * (0.04 + 0.1 * Math.sqrt(growth));
  const siteCount = Math.round(20 + rand() * 14);

  // Larger blooms first so late small ones overlap them, like a real surface.
  const sites = Array.from({ length: siteCount }, () => ({
    x: rand() * SIZE,
    y: rand() * SIZE,
    r: baseRadius * (0.6 + rand() * 0.85),
    rot: rand() * Math.PI * 2,
  })).sort((a, b) => b.r - a.r);

  for (const site of sites) {
    // Plan the whole spherulite BEFORE drawing. wrapX may stamp it 2–3 times
    // (for seam continuity), and every stamp must be pixel-identical — any
    // rand() call inside the draw would give each copy different needles and
    // paint a visible break along the texture's wrap seam. (This exact bug
    // shipped in the first version; the shifted-seam debug view caught it.)
    const plan = planSpherulite(site.r, rand);
    wrapX(SIZE, site.x, (x) => drawSpherulite(ctx, x, site.y, site.rot, plan, palette));
  }

  return toTexture(canvas);
}

type SpheruliteNeedle = {
  ex: number;
  ey: number;
  bodyWidth: number;
  spineWidth: number;
};

type SpherulitePlan = {
  haloR: number;
  nucleusR: number;
  needles: SpheruliteNeedle[];
};

function planSpherulite(r: number, rand: () => number): SpherulitePlan {
  const needles: SpheruliteNeedle[] = [];
  const count = 30 + Math.floor(rand() * 18);
  // Two layers — long primaries, short secondaries between them.
  for (let layer = 0; layer < 2; layer++) {
    const lengthScale = layer === 0 ? 1 : 0.55;
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * Math.PI * 2 + (rand() - 0.5) * 0.18 + layer * 0.11;
      const len = r * lengthScale * (0.65 + rand() * 0.35);
      needles.push({
        ex: Math.cos(angle) * len,
        ey: Math.sin(angle) * len,
        bodyWidth: 6.4 + rand() * 4.4,
        spineWidth: 2.4 + rand() * 2.4,
      });
    }
  }
  return { haloR: r * 1.15, nucleusR: Math.max(2.5, r * 0.045), needles };
}

function drawSpherulite(
  ctx: Ctx2D,
  x: number,
  y: number,
  rot: number,
  plan: SpherulitePlan,
  palette: { needle: string; nucleus: string },
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  // A halo of glassy clearing around the crystal (crystals rob the glaze
  // around them of colorant — a real, subtle effect that sells the look).
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, plan.haloR);
  halo.addColorStop(0, "rgba(255,255,255,0.28)");
  halo.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, plan.haloR, 0, Math.PI * 2);
  ctx.fill();

  // Each needle is drawn twice: a wide translucent pass (the crystal's body)
  // under a thin bright pass (its spine) — reads as a mineral, not a pen line.
  for (const needle of plan.needles) {
    const lineGrad = ctx.createLinearGradient(0, 0, needle.ex, needle.ey);
    lineGrad.addColorStop(0, `rgba(${palette.needle},0.95)`);
    lineGrad.addColorStop(1, `rgba(${palette.needle},0)`);
    ctx.strokeStyle = lineGrad;
    for (const [width, alpha] of [
      [needle.bodyWidth, 0.4],
      [needle.spineWidth, 1],
    ] as const) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(needle.ex, needle.ey);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Nucleus: the bright point where it all started.
  ctx.fillStyle = palette.nucleus;
  ctx.beginPath();
  ctx.arc(0, 0, plan.nucleusR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

export type OilSpotParams = {
  seed: number;
};

/**
 * Tenmoku oil spots: in the real glaze, iron oxide releases oxygen bubbles
 * during firing; each bubble drags metallic iron to the surface and leaves a
 * silvery freckle where it pops. So: seeded scatter of small bright spots,
 * denser on the upper body (bubbles rise), on a transparent canvas that the
 * tenmoku material blends over its base color.
 */
export function oilSpotTexture({ seed }: OilSpotParams): CanvasTexture {
  const SIZE = 1024;
  const { canvas, ctx } = makeCanvas(SIZE);
  const rand = mulberry32(seed ^ 0x9e3779b9); // decorrelate from other users of the seed

  const count = 380 + Math.floor(rand() * 160);
  for (let i = 0; i < count; i++) {
    // Plan before drawing — wrapX may stamp a spot twice for seam continuity,
    // and both stamps must be identical (no rand() inside the draw callback).
    // Bias spots toward the top of the pot (v=1 is the rim; canvas y=0 is v=1).
    const y = Math.pow(rand(), 1.6) * SIZE;
    const x = rand() * SIZE;
    const r = 1.5 + rand() * 5.5;
    const coreAlpha = 0.5 + rand() * 0.4;
    const edgeAlpha = 0.25 + rand() * 0.2;
    wrapX(SIZE, x, (sx) => {
      const g = ctx.createRadialGradient(sx, y, 0, sx, y, r);
      g.addColorStop(0, `rgba(214,196,150,${coreAlpha})`);
      g.addColorStop(0.7, `rgba(180,150,96,${edgeAlpha})`);
      g.addColorStop(1, "rgba(180,150,96,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  return toTexture(canvas);
}
