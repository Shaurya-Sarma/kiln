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
  glaze: "celadon" | "crystalline" | "tenmoku";
  atmosphere: "oxidation" | "reduction";
  holdMinutes: number;
  seed: number;
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
      /** Previous firing settings when relaunched from an exported pot. */
      restore: FiringSettings | null;
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
    }
  | {
      type: "place-test-tiles";
      tiles: { png: Uint8Array; label: string; seed: number }[];
      settings: FiringSettings;
    }
  | { type: "notify"; message: string };
