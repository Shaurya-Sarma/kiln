/**
 * The sandbox ↔ UI-iframe protocol.
 *
 * A Figma plugin is two programs that cannot touch each other's worlds: the
 * sandbox owns the document (no DOM, no rendering), the iframe owns rendering
 * (no document access). Everything crosses this postMessage boundary, so the
 * whole conversation is written down here as discriminated unions — both
 * sides import these types and the compiler keeps the two programs honest.
 */

/** A vessel profile point, mirrored from @kiln/engine (radius, height). */
export type WireProfilePoint = { radius: number; height: number };

export type FiringSettings = {
  glaze: "celadon" | "crystalline" | "tenmoku" | "shino" | "copper-red" | "ash";
  atmosphere: "oxidation" | "reduction";
  holdMinutes: number;
  seed: number;
  /** Which metal oxide colours the melt (mirrors the engine's Colorant). */
  colorant: "iron" | "cobalt" | "chrome" | "manganese" | "rutile";
  /**
   * Preset form name when the pot was thrown from a preset, or null when it
   * was thrown from a pen-tool curve. Drives the playground cross-link: a
   * preset pot's URL reproduces the whole pot; a curve pot's URL reproduces
   * the glaze firing but not the form (the form lives in the Figma file).
   */
  form: string | null;
};

/**
 * Everything needed to re-throw a pot exactly as it was fired: the recipe plus,
 * for a curve-thrown pot, the profile itself. A pot's form is half its identity,
 * and a pen-tool curve can be moved, edited or deleted after the firing — so the
 * profile travels with the placed pot rather than being looked up again.
 */
export type RestoredPot = {
  settings: FiringSettings;
  /** The thrown profile, or null for a preset pot (settings.form names it). */
  profile: WireProfilePoint[] | null;
};

/** Sandbox → UI. */
export type SandboxMessage =
  | {
      type: "profile";
      /** Foot-first profile extracted from the selected vector, or null when
       * nothing usable is selected (UI falls back to preset forms). */
      points: WireProfilePoint[] | null;
      /** Name of the source node, for the "thrown from …" status line. */
      sourceName: string | null;
      /** The whole previous pot — recipe and form — when relaunched from an
       * exported pot. Pots placed before the form was stored restore with
       * `profile: null`, i.e. the recipe alone. */
      restore: RestoredPot | null;
      /** Set when a menu command should run immediately on open. */
      autorun: "tiles" | null;
    }
  | { type: "error"; message: string };

/** UI → sandbox. */
export type UiMessage =
  | { type: "ready" }
  | {
      type: "place-render";
      png: Uint8Array;
      label: string;
      settings: FiringSettings;
      /** The profile that was thrown, or null when it came from a preset. */
      profile: WireProfilePoint[] | null;
    }
  | {
      type: "place-test-tiles";
      tiles: { png: Uint8Array; label: string; seed: number }[];
      settings: FiringSettings;
      /** Nine firings of one pot: the whole grid shares this profile. */
      profile: WireProfilePoint[] | null;
    }
  | { type: "notify"; message: string };
