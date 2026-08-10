/**
 * Kiln — the studio cursor.
 *
 * ONE icon: a chunky, bold-outlined pointer arrow with two accent motifs that
 * come and go around it — a SPARKLE BURST off its shoulder (there is something
 * here) and CLICK RIPPLES behind its tail (contact / motion). Everything else a
 * state can change is the arrow's *fill*, which moves through the icon set's
 * three weights: outline-only, soft-tinted, solid. That is the entire
 * vocabulary. Nothing morphs, nothing deforms, nothing sprouts a second shape.
 *
 * Design constraints that shaped the code:
 *
 * - **The follower may never be a usability tax.** It's `pointer-events: none`
 *   on a zero-size root, so no state — however large it draws — can intercept
 *   a click. Native cursors are preserved on `<select>` and `<input>` (an OS
 *   dropdown next to a lagging icon reads as a broken widget), and the whole
 *   system refuses to start on coarse pointers or under
 *   `prefers-reduced-motion`, where a hidden native cursor is a real problem
 *   rather than a flourish.
 * - **One resolver, not scattered assignments.** State is derived every frame
 *   from three inputs — what the pointer is over in the DOM, what the 3D scene
 *   reports via {@link setPotGrip}, and whether the kiln overlay is up. main.ts
 *   only reports the fact it owns (is the hand on a pot?); it never picks a
 *   visual. That's also why DOM hovers outrank a stale pot hover in
 *   {@link resolveState}: leaving the canvas doesn't fire a canvas pointermove.
 * - **States are CSS selectors, not branches.** cursor.css restyles the same
 *   three layers per `data-cc` value; the loop here only ever writes position,
 *   drag tilt, and that one attribute.
 * - **The arrow never rotates to face travel.** The only rotation is a few
 *   degrees of tilt while you're actually turning a pot, and even that pivots
 *   about the hotspot — a pointer that swings its tip around stops pointing at
 *   what it's over, which is the one thing a pointer may never do.
 */

import "./cursor.css";

/** What the 3D scene knows and the DOM can't: is the hand on a pot? */
export type PotGrip = "none" | "over" | "grabbing";

/** A weight + accent combination of the one arrow. See resolveState. */
type CursorState = "idle" | "touch" | "grip" | "control" | "ember" | "dim" | "native";

/** What the pointer is over in the DOM, independent of the 3D scene. */
type HoverKind = "none" | "ui" | "fire" | "native";

let potGrip: PotGrip = "none";

/**
 * Report the 3D scene's grab state. Replaces main.ts writing
 * `domElement.style.cursor` directly — the pot raycast is a *fact* about the
 * scene, and picking a picture for it belongs here.
 *
 * Safe to call before {@link initCursor} (or when the cursor is disabled): the
 * value is just recorded, and nothing reads it if no follower is running.
 */
export function setPotGrip(grip: PotGrip): void {
  potGrip = grip;
}

/**
 * The arrow: the classic seven-point pointer polygon, drawn as fat rounded
 * strokes rather than as outlined geometry.
 *
 * Two passes over ONE path — a wide ink stroke, then a narrower stroke in the
 * fill colour on top of it. The difference between the two widths *is* the
 * outline (a constant 2.6 units all the way round, including into the concave
 * heel, which an offset second path could never hold), and `stroke-linejoin:
 * round` at that width is what rounds every corner into the friendly, chunky
 * silhouette instead of a crisp vector spike.
 *
 * Colours are NOT set here: cursor.css drives both passes off `--cc-fill` and
 * `--cc-ink`, so a state changes the icon's weight without swapping the markup.
 * (Presentation attributes can't read `var()`, hence the classes.)
 */
/**
 * The tail spike is longer and the heel notch deeper than the proportions of a
 * native arrow, because a 3.6-unit round join eats that much off both ends of
 * the spike: at the OS's proportions the tail rounded away almost entirely and
 * the silhouette read as a leaf rather than as a cursor.
 */
const ARROW_PATH = "M5 4.4L5 25.6L10.6 19.2L15.6 31.6L20.6 29.2L16.2 17.4L23.4 17.4Z";

const ARROW_SVG = `
<svg viewBox="0 0 34 36" aria-hidden="true">
  <g stroke-linejoin="round" stroke-linecap="round">
    <path class="cc-arrow-ink" d="${ARROW_PATH}" stroke-width="7.2"/>
    <path class="cc-arrow-fill" d="${ARROW_PATH}" stroke-width="2"/>
  </g>
</svg>`;

/**
 * The sparkle burst: three short dashes radiating from a point just off the
 * arrow's shoulder, in the empty wedge above its diagonal edge.
 *
 * Dashes rather than stars because they have to read at ~28px, where a
 * four-pointed star turns into a blob. They share the arrow's stroke weight and
 * round caps so the burst looks cut from the same icon, and they're a separate
 * layer so a state can add the accent without touching the arrow's fill.
 *
 * They start a clear gap out from the arrow's outline rather than touching it:
 * a dash that lands on the ink reads as a rendering seam, and the burst has to
 * look thrown off the icon rather than welded to it.
 */
const SPARK_SVG = `
<svg viewBox="0 0 34 36" aria-hidden="true">
  <g class="cc-spark-ink" stroke-width="2.8" stroke-linecap="round" fill="none">
    <path d="M27.74 6.7L29.03 2.7"/>
    <path d="M30.66 9.92L34.22 9.42"/>
    <path d="M28.96 13.65L31.43 16.8"/>
  </g>
</svg>`;

/**
 * The click ripples: two concentric arcs sitting behind the arrow's tail, on
 * the side the arrow is *leaving*.
 *
 * They carry two jobs that happen to want the same picture — a held grip (the
 * arrow is in contact with something and moving it) shows them steadily, and
 * any click pulses them once. Because a running CSS animation outranks a plain
 * declaration, the one-shot pulse simply wins for its duration and then hands
 * the layer back to whatever the state was already saying.
 *
 * Its own viewBox and offset: the arcs live outside the arrow's box entirely,
 * and forcing them into it would mean either clipping or re-scaling the arrow.
 */
const RIPPLE_SVG = `
<svg viewBox="0 0 30 40" aria-hidden="true">
  <g stroke-linecap="round" fill="none">
    <path class="cc-ripple-arc" d="M10.43 12.34A10 10 0 0 1 10.43 27.66" stroke-width="2.8"/>
    <path class="cc-ripple-arc" d="M14.43 9.93A14.5 14.5 0 0 1 14.43 30.07" stroke-width="2.4"/>
  </g>
</svg>`;

// ---------- element construction ----------

/**
 * Build one complete follower. Shared by the live cursor and each cell of the
 * `?debug=cursor` contact sheet, so the board can never drift from the real
 * thing.
 *
 * Four layers, and every state is some combination of them: the arrow itself
 * (always drawn), the sparkle burst, the click ripples, and the one-time
 * "spin" hint.
 */
function buildFollower(): { root: HTMLDivElement; tilt: HTMLDivElement } {
  const root = document.createElement("div");
  root.className = "kilncursor";
  root.dataset["cc"] = "idle";

  const press = document.createElement("div");
  press.className = "cc-press";
  const tilt = document.createElement("div");
  tilt.className = "cc-tilt";

  const layers: readonly [string, string][] = [
    ["cc-ripples", RIPPLE_SVG],
    ["cc-arrow", ARROW_SVG],
    ["cc-spark", SPARK_SVG],
    ["cc-hint", "spin"],
  ];
  layers.forEach(([cls, content]) => {
    const layer = document.createElement("i");
    layer.className = cls;
    if (cls === "cc-hint") layer.textContent = content;
    else layer.innerHTML = content;
    tilt.appendChild(layer);
  });

  press.appendChild(tilt);
  root.appendChild(press);
  return { root, tilt };
}

// ---------- hover classification ----------

/**
 * What the pointer is over, by role rather than by tag. `native` wins outright:
 * those controls keep the browser's cursor, so the follower must get out of
 * the way instead of doubling up on it.
 */
function classifyHover(target: EventTarget | null): HoverKind {
  if (!(target instanceof Element)) return "none";
  if (target.closest("select, input, textarea, option")) return "native";
  if (target.closest("#fire")) return "fire";
  if (target.closest("button, a, .shelf-item img")) return "ui";
  return "none";
}

/**
 * The single place a state is chosen. Ordering carries real decisions:
 *
 * 1. A firing outranks everything — the room is dark, nothing else is visible.
 * 2. Native controls next, so nothing can draw a follower over a dropdown.
 * 3. An active grab beats any hover: a drag that slides off the canvas is
 *    still a drag, and the arrow must not go light before you let go.
 * 4. DOM hovers beat a *stale* pot hover. Leaving the canvas fires no canvas
 *    pointermove, so `potGrip` can still read "over" while you're on a button.
 */
function resolveState(hover: HoverKind, firing: boolean): CursorState {
  if (firing) return "dim";
  if (hover === "native") return "native";
  if (potGrip === "grabbing") return "grip";
  if (hover === "fire") return "ember";
  if (hover === "ui") return "control";
  if (potGrip === "over") return "touch";
  return "idle";
}

const HINT_KEY = "kiln.cursor.spinHint";

/** Degrees of tilt at full drag speed, and how fast the tilt itself eases. */
const TILT_MAX = 9;
const TILT_PER_PX = 1.1;

/**
 * Start the studio cursor. Called once from main.ts; returns early and leaves
 * the native cursor completely alone when the effect would hurt rather than
 * help.
 */
export function initCursor(): void {
  // Touch: there is no pointer to follow, and hiding the cursor would strand
  // a hybrid device's trackpad. Reduced motion: the whole feature is easing
  // and lag, and the honest response to that request is to not ship it.
  if (matchMedia("(pointer: coarse)").matches) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  if (new URLSearchParams(location.search).get("debug") === "cursor") {
    renderStateBoard();
    return;
  }

  const { root, tilt } = buildFollower();
  document.body.append(root);
  document.documentElement.classList.add("cc-on");

  const ripples = root.querySelector<HTMLElement>(".cc-ripples")!;
  const hint = root.querySelector<HTMLElement>(".cc-hint")!;
  // The hint is a one-time teaching moment, not a recurring label: a returning
  // visitor already knows the pot spins, and being told again is noise.
  let hintPending = localStorage.getItem(HINT_KEY) === null;
  hint.style.display = hintPending ? "" : "none";

  // Target (raw pointer) vs. rendered (eased) position. A small gap between
  // them is what keeps the icon feeling attached to a hand rather than nailed
  // to the pointer sample.
  let targetX = innerWidth / 2;
  let targetY = innerHeight / 2;
  let x = targetX;
  let y = targetY;
  let hover: HoverKind = "none";
  let onPage = false;

  addEventListener(
    "pointermove",
    (event) => {
      targetX = event.clientX;
      // The arrow tracks 1:1, written straight from the event — lag on the
      // pointer itself reads as input latency, not style (user verdict, and
      // they were right). All the personality lives in the accents' CSS
      // transitions; the position is just honest.
      x = targetX;
      y = event.clientY;
      root.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
      targetY = event.clientY;
      hover = classifyHover(event.target);
      // main.ts reports the pot hover from canvas pointermoves only, so it has
      // no way to know the pointer has left the canvas. Clearing it here keeps
      // that reporting one-directional and main.ts free of cursor bookkeeping.
      if (potGrip === "over" && !(event.target instanceof HTMLCanvasElement)) potGrip = "none";
      if (!onPage) {
        onPage = true;
        // Jump on first sight instead of easing in from wherever the page
        // happened to start — an arrow gliding in from the middle of the screen
        // looks like a bug, not a follower.
        x = targetX;
        y = targetY;
        root.style.opacity = "";
      }
    },
    { passive: true },
  );

  // Leaving the window should take the arrow with it, or it sits frozen at the
  // edge like a stuck sprite while you're in another app.
  document.addEventListener("pointerleave", () => {
    onPage = false;
    root.style.opacity = "0";
  });
  root.style.opacity = "0";

  addEventListener(
    "pointerdown",
    () => {
      root.classList.add("is-press");
      // Restart the one-shot ripple pulse: a CSS animation only re-runs if the
      // class leaves and re-enters across a reflow, and clicking twice in a row
      // must pulse twice.
      ripples.classList.remove("is-poked");
      void ripples.offsetWidth;
      ripples.classList.add("is-poked");
    },
    { passive: true },
  );
  const relax = () => root.classList.remove("is-press");
  addEventListener("pointerup", relax, { passive: true });
  addEventListener("pointercancel", relax, { passive: true });

  // The firing overlay is the one state owned by neither the DOM hover nor the
  // scene. Read it off the element main.ts already toggles rather than adding a
  // second signal to keep in sync — the class IS the source of truth for "the
  // room is dark", and there's exactly one of them.
  let kilnfire: Element | null = null;
  let firing = false;
  const observer = new MutationObserver(() => {
    firing = kilnfire?.classList.contains("dim") ?? false;
  });

  let state: CursorState = "idle";
  let tiltDeg = 0;

  const frame = () => {
    if (!kilnfire) {
      kilnfire = document.querySelector(".kilnfire");
      if (kilnfire) {
        observer.observe(kilnfire, { attributeFilter: ["class"] });
        firing = kilnfire.classList.contains("dim");
      }
    }

    // Position is written in the pointermove handler (1:1, sub-frame) — the
    // loop only tracks per-frame velocity for the drag tilt below.
    const prevX = x;

    const next = resolveState(hover, firing);
    if (next !== state) {
      state = next;
      root.dataset["cc"] = state;
      // Spend the hint the first time the arrow lights up over the pot: the
      // user has found it, which is precisely when "spin" means something.
      if (state === "touch" && hintPending) {
        hintPending = false;
        localStorage.setItem(HINT_KEY, "1");
        // Let it read, then retire it for good.
        setTimeout(() => (hint.style.display = "none"), 3200);
      }
    }

    // Tilt with the direction you're turning the pot, and ONLY while turning
    // it: this is the arrow leaning into the work, not a velocity effect. Any
    // other state eases it back to upright rather than snapping, so letting go
    // mid-drag doesn't look like the icon glitched.
    const target = state === "grip" ? clampTilt((x - prevX) * TILT_PER_PX) : 0;
    tiltDeg += (target - tiltDeg) * 0.16;
    tilt.style.setProperty("--cc-tilt", `${tiltDeg.toFixed(2)}deg`);

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function clampTilt(deg: number): number {
  return Math.max(-TILT_MAX, Math.min(TILT_MAX, deg));
}

/**
 * `?debug=cursor` — a contact sheet of every state, pinned at fixed points.
 *
 * A headless screenshot cannot photograph a cursor (there is no pointer), so
 * reviewing this feature from a screenshot needs the states laid out as
 * artwork. Built from the same {@link buildFollower} the live cursor uses, so
 * the sheet can't lie about what shipped. The dark states get a dark plate
 * behind them because that's the only room they ever appear in.
 *
 * `?debug=cursor&poke=1` also fires the click pulse on every cell, since a
 * one-shot animation is otherwise invisible in a still.
 */
function renderStateBoard(): void {
  document.documentElement.classList.add("cc-on");
  const poke = new URLSearchParams(location.search).get("poke") === "1";

  const board = document.createElement("div");
  board.className = "cc-board";
  const title = document.createElement("p");
  title.className = "cc-board-title";
  title.textContent = poke ? "studio cursor — the click ripple" : "studio cursor — states";
  board.appendChild(title);
  document.body.appendChild(board);

  // Three to a row: at four the labels ran into each other, and the label is
  // half of what the sheet is for. Kept clear of the recipe card on the left,
  // which the follower would otherwise sit on top of and make unreadable.
  //
  // Only `dim` gets the dark plate. `ember` is a hover on the FIRE button, which
  // sits on the paper panel — reviewing it against black would be reviewing it
  // somewhere it never appears, and it's precisely the ink accents that a wrong
  // background hides.
  const cells: readonly { state: CursorState; label: string; x: number; y: number; dark?: boolean }[] = [
    { state: "idle", label: "default · outline", x: 0.3, y: 0.26 },
    { state: "touch", label: "over the pot · tinted + sparkle", x: 0.53, y: 0.26 },
    { state: "grip", label: "spinning it · solid + ripples", x: 0.77, y: 0.26 },
    { state: "control", label: "over a control · sparkle", x: 0.34, y: 0.62 },
    { state: "ember", label: "over FIRE · brick + sparkle", x: 0.56, y: 0.62 },
    { state: "dim", label: "during the firing · faint outline", x: 0.79, y: 0.62, dark: true },
  ];

  cells.forEach((cell) => {
    const cx = innerWidth * cell.x;
    const cy = innerHeight * cell.y;
    if (cell.dark) {
      const plate = document.createElement("div");
      plate.className = "cc-cell-plate";
      plate.style.left = `${cx}px`;
      plate.style.top = `${cy}px`;
      board.appendChild(plate);
    }
    const { root, tilt } = buildFollower();
    root.dataset["cc"] = cell.state;
    root.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    // The grip cell is the one state that only ever exists mid-drag, so show it
    // the way it is actually seen: leaning into the turn.
    tilt.style.setProperty("--cc-tilt", cell.state === "grip" ? `${TILT_MAX}deg` : "0deg");
    if (cell.state !== "touch") root.querySelector<HTMLElement>(".cc-hint")!.style.display = "none";
    if (poke) {
      root.classList.add("is-press");
      const pulse = root.querySelector<HTMLElement>(".cc-ripples")!;
      pulse.classList.add("is-poked");
      // A one-shot 0.5s animation has already faded out by the time a headless
      // screenshot lands, so the still showed nothing. A negative delay plus a
      // paused play-state freezes it partway through the expansion instead.
      pulse.style.animationDelay = "-0.16s";
      pulse.style.animationPlayState = "paused";
    }
    document.body.appendChild(root);

    const label = document.createElement("p");
    label.className = "cc-cell-label";
    label.textContent = cell.label;
    label.style.left = `${cx}px`;
    // Clear of the dark plate's bottom edge where there is one.
    label.style.top = `${cy + (cell.dark ? 78 : 46)}px`;
    board.appendChild(label);
  });
}
