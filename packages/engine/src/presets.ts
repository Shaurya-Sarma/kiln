/**
 * Preset vessel profiles, foot -> rim, hand-tuned.
 *
 * These play two roles: the playground's starting shapes (it has no pen tool),
 * and the fallback inside the Figma plugin when nothing is selected. Units are
 * arbitrary "pot units" — consumers scale the mesh, not the profile.
 *
 * Shapes reference real thrown forms: the bowl flares open like a teabowl, the
 * vase carries a classic shoulder, the bottle necks in hard (crystalline
 * glazes love the long flat shoulder), the mug is a straight cylinder with a
 * slight waist, the amphora is the fat-bellied narrow-foot Greek form.
 */

import type { Profile, ProfilePoint } from "./profile.js";

function p(radius: number, height: number): ProfilePoint {
  return { radius, height };
}

export const PRESETS: Record<string, Profile> = {
  bowl: [p(0.02, 0), p(0.32, 0.02), p(0.42, 0.08), p(0.55, 0.35), p(0.78, 0.72), p(0.93, 1.02), p(0.98, 1.18)],
  vase: [p(0.02, 0), p(0.3, 0.02), p(0.42, 0.1), p(0.6, 0.5), p(0.62, 0.9), p(0.45, 1.35), p(0.28, 1.6), p(0.26, 1.78), p(0.3, 1.94), p(0.34, 2.02)],
  bottle: [p(0.02, 0), p(0.34, 0.02), p(0.5, 0.12), p(0.62, 0.55), p(0.58, 1.0), p(0.34, 1.3), p(0.16, 1.5), p(0.14, 1.85), p(0.18, 1.98)],
  mug: [p(0.02, 0), p(0.38, 0.02), p(0.44, 0.1), p(0.42, 0.55), p(0.44, 1.0), p(0.46, 1.25)],
  amphora: [p(0.02, 0), p(0.18, 0.02), p(0.24, 0.12), p(0.55, 0.55), p(0.66, 0.95), p(0.55, 1.4), p(0.32, 1.7), p(0.26, 1.9), p(0.34, 2.05), p(0.38, 2.12)],
  // Round two, derived from the hand-drawn Figma test curves that proved out:
  // the Korean full-moon form, the domed Chinese ginger jar, a stemmed goblet
  // (the extreme thin-radius test that ships), and a plate (the widest, lowest
  // form — crystalline blooms love the flat real estate).
  "moon-jar": [p(0.02, 0), p(0.18, 0.02), p(0.21, 0.1), p(0.5, 0.5), p(0.58, 0.86), p(0.6, 1.2), p(0.5, 1.55), p(0.38, 1.74), p(0.16, 1.92), p(0.11, 1.98)],
  "ginger-jar": [p(0.02, 0), p(0.24, 0.02), p(0.26, 0.06), p(0.45, 0.4), p(0.54, 0.68), p(0.57, 1.2), p(0.5, 1.72), p(0.3, 1.94), p(0.24, 1.98)],
  goblet: [p(0.02, 0), p(0.4, 0.03), p(0.42, 0.1), p(0.14, 0.35), p(0.07, 0.55), p(0.06, 1.0), p(0.1, 1.12), p(0.38, 1.32), p(0.56, 1.55), p(0.62, 1.8), p(0.6, 1.98), p(0.61, 2.04)],
  plate: [p(0.02, 0), p(0.3, 0.02), p(0.32, 0.06), p(0.9, 0.16), p(1.3, 0.3), p(1.38, 0.38)],
};

export type PresetName = keyof typeof PRESETS;
