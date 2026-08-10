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
  /** Soak minutes: bubbles merge during a long hold — fewer, larger spots. */
  holdMinutes: number;
};

/**
 * Tenmoku oil spots: in the real glaze, iron oxide releases oxygen bubbles
 * during firing; each bubble drags metallic iron to the surface and leaves a
 * silvery freckle where it pops. So: seeded scatter of small bright spots,
 * denser on the upper body (bubbles rise), on a transparent canvas that the
 * tenmoku material blends over its base color.
 */
export function oilSpotTexture({ seed, holdMinutes }: OilSpotParams): CanvasTexture {
  const SIZE = 1024;
  const { canvas, ctx } = makeCanvas(SIZE);
  const rand = mulberry32(seed ^ 0x9e3779b9); // decorrelate from other users of the seed

  // Long soak: bubbles find each other and merge — fewer spots, each larger.
  const melt = Math.min(holdMinutes / 90, 1);
  const count = Math.round((380 + Math.floor(rand() * 160)) * (1.15 - melt * 0.55));
  for (let i = 0; i < count; i++) {
    // Plan before drawing — wrapX may stamp a spot twice for seam continuity,
    // and both stamps must be identical (no rand() inside the draw callback).
    // Bias spots toward the top of the pot (v=1 is the rim; canvas y=0 is v=1).
    const y = Math.pow(rand(), 1.6) * SIZE;
    const x = rand() * SIZE;
    const r = (1.5 + rand() * 5.5) * (0.8 + melt * 0.7);
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

export type SeededGlazeParams = {
  seed: number;
  atmosphere: Atmosphere;
  /** Soak minutes at peak — a longer hold matures every melt (see GlazeParams). */
  holdMinutes: number;
};

/**
 * Shino: the glaze that does what it wants.
 *
 * A thick feldspathic white that blushes orange where flame and soda vapor
 * found it, and traps grey carbon where reduction smoke got sealed under the
 * melt. Even experienced potters can't call a shino before opening the kiln —
 * which makes it the purest expression of this app's thesis. Per firing, the
 * SEED decides where the blushes bloom and where the carbon got trapped;
 * reduction firings trap far more carbon than oxidation ones.
 */
export function shinoTexture({ seed, atmosphere, holdMinutes }: SeededGlazeParams): CanvasTexture {
  const SIZE = 1024;
  const { canvas, ctx } = makeCanvas(SIZE);
  const rand = mulberry32(seed ^ 0x51142);
  const melt = Math.min(holdMinutes / 90, 1); // longer soak -> blushes spread

  // Base: warm feldspar cream — itself a per-firing fact. Some loads come out
  // milk-white, some toast all over; one lerp on the whole base sells that.
  const toastiness = rand();
  const top = toastiness > 0.6 ? "#efd6ae" : "#f2e3c9";
  const bottom = toastiness > 0.6 ? "#e0b98a" : "#e6cda6";
  const grad = ctx.createLinearGradient(0, 0, 0, SIZE);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Fire blushes: large soft salmon-orange clouds. Plan first, then stamp
  // (wrap-seam purity rule — see the note above crystallineTexture).
  const blushes = Array.from({ length: 8 + Math.floor(rand() * 9) }, () => ({
    x: rand() * SIZE,
    y: rand() * SIZE,
    r: SIZE * (0.12 + rand() * 0.26) * (0.75 + melt * 0.6),
    alpha: 0.4 + rand() * 0.35,
    warm: rand(), // 0 = salmon, 1 = burnt orange
  }));
  for (const blush of blushes) {
    wrapX(SIZE, blush.x, (x) => {
      const g = ctx.createRadialGradient(x, blush.y, 0, x, blush.y, blush.r);
      const tone = blush.warm > 0.5 ? "172,62,22" : "206,106,48";
      // Hold the colour out to mid-radius before fading — a plain radial
      // gradient collapses its alpha so fast the blush reads as a whisper
      // under the studio light (round one of this glaze proved it).
      g.addColorStop(0, `rgba(${tone},${blush.alpha})`);
      g.addColorStop(0.55, `rgba(${tone},${blush.alpha * 0.8})`);
      g.addColorStop(1, `rgba(${tone},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, blush.y, blush.r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Carbon trapping: sooty grey smudges sealed under the melt. Reduction
  // firings smoke far more; oxidation barely traps at all.
  const carbonCount = atmosphere === "reduction" ? 3 + Math.floor(rand() * 5) : Math.floor(rand() * 2);
  const smudges = Array.from({ length: carbonCount }, () => ({
    x: rand() * SIZE,
    y: rand() * SIZE,
    r: SIZE * (0.09 + rand() * 0.18),
    alpha: 0.18 + rand() * 0.3,
  }));
  for (const smudge of smudges) {
    wrapX(SIZE, smudge.x, (x) => {
      const g = ctx.createRadialGradient(x, smudge.y, 0, x, smudge.y, smudge.r);
      g.addColorStop(0, `rgba(74,66,64,${smudge.alpha})`);
      g.addColorStop(0.5, `rgba(74,66,64,${smudge.alpha * 0.7})`);
      g.addColorStop(1, "rgba(74,66,64,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, smudge.y, smudge.r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Pinholes: shino's thick coat boils tiny craters into the surface.
  for (let i = 0; i < 60 + rand() * 60; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const r = 0.8 + rand() * 1.6;
    const alpha = 0.18 + rand() * 0.25;
    wrapX(SIZE, x, (sx) => {
      ctx.fillStyle = `rgba(96,74,58,${alpha})`;
      ctx.beginPath();
      ctx.arc(sx, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  return toTexture(canvas);
}

/**
 * Copper red (oxblood / flambé) — the atmosphere glaze.
 *
 * The SAME copper that gives oxidation firings a quiet green turns blood-red
 * the moment the kiln is starved of oxygen; that flip is the most dramatic
 * atmosphere story in ceramics, so this texture renders two entirely
 * different glazes from one recipe. In reduction, the seed streaks the red
 * with flambé runs — violet-blue veils where the glaze re-oxidized as it ran.
 */
export function copperRedTexture({ seed, atmosphere, holdMinutes }: SeededGlazeParams): CanvasTexture {
  const SIZE = 1024;
  const { canvas, ctx } = makeCanvas(SIZE);
  const rand = mulberry32(seed ^ 0xc0bbe4);
  const melt = Math.min(holdMinutes / 90, 1); // longer soak -> veils run longer

  if (atmosphere === "oxidation") {
    // Copper in oxygen: a soft matte green, gently mottled.
    const grad = ctx.createLinearGradient(0, 0, 0, SIZE);
    grad.addColorStop(0, "#a9bd9a");
    grad.addColorStop(1, "#83a184");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
    const patches = Array.from({ length: 180 }, () => ({
      x: rand() * SIZE,
      y: rand() * SIZE,
      r: 10 + rand() * 30,
      alpha: 0.03 + rand() * 0.05,
    }));
    for (const patch of patches) {
      wrapX(SIZE, patch.x, (x) => {
        const g = ctx.createRadialGradient(x, patch.y, 0, x, patch.y, patch.r);
        g.addColorStop(0, `rgba(74,104,74,${patch.alpha})`);
        g.addColorStop(1, "rgba(74,104,74,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, patch.y, patch.r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    return toTexture(canvas);
  }

  // Reduction: oxblood. Deep red, darker in the depths, with flambé streaks.
  const grad = ctx.createLinearGradient(0, 0, 0, SIZE);
  grad.addColorStop(0, "#8c2420");
  grad.addColorStop(0.55, "#71191a");
  grad.addColorStop(1, "#541114");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Flambé: vertical veils where the melt ran and briefly re-oxidized.
  // Planned first (purity rule), then stamped with wrap copies.
  const streaks = Array.from({ length: 7 + Math.floor(rand() * 9) }, () => ({
    x: rand() * SIZE,
    top: rand() * SIZE * 0.5,
    length: SIZE * (0.25 + rand() * 0.5) * (0.7 + melt * 0.65),
    width: 14 + rand() * 46,
    drift: (rand() - 0.5) * 60,
    alpha: 0.1 + rand() * 0.22,
    cool: rand() > 0.35, // most veils cool to violet-blue; some stay pale
  }));
  for (const streak of streaks) {
    wrapX(SIZE, streak.x, (x) => {
      const g = ctx.createLinearGradient(x, streak.top, x + streak.drift, streak.top + streak.length);
      const tone = streak.cool ? "108,88,152" : "196,168,172";
      g.addColorStop(0, `rgba(${tone},0)`);
      g.addColorStop(0.45, `rgba(${tone},${streak.alpha})`);
      g.addColorStop(1, `rgba(${tone},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(
        x + streak.drift / 2,
        streak.top + streak.length / 2,
        streak.width,
        streak.length / 2,
        Math.atan2(streak.drift, streak.length),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    });
  }

  return toTexture(canvas);
}

/**
 * Ash glaze — gravity made visible.
 *
 * Wood ash melts into a runny green-amber glass that rivulets down the wall
 * and gathers wherever it can rest. The drips ARE the glaze: each firing the
 * seed decides where they start, how far they wander, and where they pool.
 */
export function ashTexture({ seed, holdMinutes }: SeededGlazeParams): CanvasTexture {
  const SIZE = 1024;
  const { canvas, ctx } = makeCanvas(SIZE);
  const rand = mulberry32(seed ^ 0xa54);
  const melt = Math.min(holdMinutes / 90, 1); // longer soak -> drips travel

  // Base: thin amber-olive wash, warmer where the coat is thin near the rim.
  const grad = ctx.createLinearGradient(0, 0, 0, SIZE);
  grad.addColorStop(0, "#bb9a5c");
  grad.addColorStop(0.4, "#998c52");
  grad.addColorStop(1, "#6d7647");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Rivulets: plan the full wander of every drip before drawing (purity rule).
  // Canvas y=0 is the rim; drips start high and run DOWN the wall.
  const drips = Array.from({ length: 10 + Math.floor(rand() * 8) }, () => {
    const startX = rand() * SIZE;
    const startY = SIZE * (0.02 + rand() * 0.3);
    const length = SIZE * (0.25 + rand() * 0.55) * (0.6 + melt * 0.8);
    // Enough steps that adjacent discs overlap into a continuous run — at 26
    // steps the discs read as a dotted line, which no melted glass ever did.
    const steps = 72;
    let x = startX;
    const path = Array.from({ length: steps }, (_, i) => {
      x += (rand() - 0.5) * 5;
      return {
        x,
        y: startY + (length * i) / (steps - 1),
        width: 5 + (i / steps) * (7 + rand() * 11),
      };
    });
    return { path, alpha: 0.42 + rand() * 0.33, poolR: 12 + rand() * 22 };
  });

  for (const drip of drips) {
    const first = drip.path[0]!;
    wrapX(SIZE, first.x, (wx) => {
      const dx = wx - first.x;
      // The drip body: stacked soft discs read as a run of melted glass.
      for (const p of drip.path) {
        const g = ctx.createRadialGradient(p.x + dx, p.y, 0, p.x + dx, p.y, p.width);
        g.addColorStop(0, `rgba(94,112,66,${drip.alpha})`);
        g.addColorStop(1, "rgba(94,112,66,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x + dx, p.y, p.width, 0, Math.PI * 2);
        ctx.fill();
      }
      // The pool where it came to rest — darker, glassier.
      const last = drip.path[drip.path.length - 1]!;
      const g = ctx.createRadialGradient(last.x + dx, last.y, 0, last.x + dx, last.y, drip.poolR);
      g.addColorStop(0, `rgba(64,84,48,${Math.min(drip.alpha + 0.2, 0.6)})`);
      g.addColorStop(1, "rgba(64,84,48,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(last.x + dx, last.y, drip.poolR, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  return toTexture(canvas);
}
