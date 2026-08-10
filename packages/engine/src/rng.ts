/**
 * The kiln's fingerprint: seeded randomness.
 *
 * Every firing gets one seed. All stochastic decisions in a firing (where
 * crystals nucleate, how far a drip wanders, oil-spot placement) draw from a
 * generator started at that seed — so the same pot + same settings + same seed
 * reproduces EXACTLY the same firing, while "fire again" just draws a new seed.
 *
 * Why not Math.random(): it can't be replayed. Reproducibility is what makes a
 * firing an identity ("firing № 0417") instead of a one-off — you can store the
 * seed on the exported Figma node and re-open the exact same pot later, or
 * share a seed like a recipe.
 */

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Not cryptographic
 * (doesn't need to be); chosen because it's 4 lines, deterministic across
 * JS engines, and plenty random for visual work.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw a fresh firing seed (this is the ONLY place Math.random is allowed). */
export function newFiringSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/** Kiln-load label for a seed, e.g. "no. 0417" — potters number their firings.
 * ("no." not "№": U+2116 is missing from IBM Plex Mono, our label face.) */
export function firingLabel(seed: number): string {
  return `no. ${String(seed % 10000).padStart(4, "0")}`;
}
