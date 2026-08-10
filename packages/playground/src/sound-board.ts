/**
 * ?debug=sound — the audition board.
 *
 * You cannot hear a screenshot, and the palette in audio.ts is entirely
 * synthesized, so there is no waveform to eyeball either. This board is the
 * only honest way to check the sound design: one button per sound, plus a
 * slider for the continuous wheel loop, all in one place with the physical
 * source printed next to each so a wrong sound is obvious by comparison.
 */

import {
  clayGrab,
  dialStep,
  emberWhisper,
  flickRelease,
  kilnDoor,
  potSettle,
  setSoundEnabled,
  setSpinRate,
  shelfLift,
  shelfPlace,
  shelfRemove,
  soundEnabled,
  stamp,
  startRoar,
  stopRoar,
  tableClear,
  tablePlace,
  tink,
  uiTick,
} from "./audio.js";

type Entry = { label: string; source: string; bus: string; play: () => void };

const ENTRIES: Entry[] = [
  { label: "clayGrab", source: "palm on a damp wall", bus: "gesture", play: clayGrab },
  { label: "flickRelease (soft)", source: "air off a rim, barely", bus: "gesture", play: () => flickRelease(0.05) },
  { label: "flickRelease (hard)", source: "air off a spun rim", bus: "gesture", play: () => flickRelease(0.16) },
  { label: "potSettle", source: "stoneware onto plaster", bus: "gesture", play: potSettle },
  { label: "tink", source: "struck high-fired stoneware", bus: "firing", play: tink },
  { label: "startRoar", source: "gas burner catching + roar", bus: "firing", play: startRoar },
  { label: "stopRoar", source: "burner off, roar decays", bus: "firing", play: stopRoar },
  { label: "kilnDoor", source: "iron latch, brick slab", bus: "firing", play: kilnDoor },
  { label: "emberWhisper", source: "embers in the firebox", bus: "ui", play: emberWhisper },
  { label: "shelfPlace", source: "pot onto a wooden board", bus: "ui", play: shelfPlace },
  { label: "tablePlace", source: "pot beside another", bus: "ui", play: tablePlace },
  { label: "shelfLift", source: "dry hand lifting bisque", bus: "ui", play: shelfLift },
  { label: "shelfRemove", source: "pot carried away", bus: "ui", play: shelfRemove },
  { label: "tableClear", source: "two pots carried off", bus: "ui", play: tableClear },
  { label: "uiTick(form)", source: "nail on a bisque tile", bus: "ui", play: () => uiTick("form") },
  { label: "uiTick(glaze)", source: "nail on a bisque tile", bus: "ui", play: () => uiTick("glaze") },
  { label: "uiTick(atmosphere)", source: "nail on a bisque tile", bus: "ui", play: () => uiTick("atmosphere") },
  { label: "dialStep", source: "kiln controller ratchet", bus: "ui", play: dialStep },
  { label: "stamp", source: "maker's stamp into clay", bus: "ui", play: stamp },
];

export function mountSoundBoard(app: HTMLElement) {
  const board = document.createElement("div");
  board.className = "soundboard";
  board.innerHTML = `
    <p class="soundboard-title">SOUND BOARD <em>— press one, listen</em></p>
    <p class="soundboard-note">
      Master toggle: <button id="sbToggle">sound ${soundEnabled() ? "on" : "off"}</button>
      &nbsp;·&nbsp; the ambient room tone starts with the first press and ducks under a firing.
    </p>
    <div class="soundboard-grid" id="sbGrid"></div>
    <div class="soundboard-spin">
      <label>wheel spin — <span id="sbSpinValue">0.000</span> rad/frame
        <input id="sbSpin" type="range" min="0" max="0.14" step="0.002" value="0" />
      </label>
      <p class="soundboard-note">
        idle is 0.004 and must be <em>silent</em>; audible from 0.012 up. Release the slider
        to hear it ramp down and tear itself down without a click.
      </p>
    </div>
  `;
  app.appendChild(board);

  const grid = board.querySelector<HTMLDivElement>("#sbGrid")!;
  ENTRIES.forEach((entry) => {
    const cell = document.createElement("button");
    cell.className = "soundboard-cell";
    cell.innerHTML = `<b>${entry.label}</b><i>${entry.source}</i><u>${entry.bus}</u>`;
    cell.addEventListener("click", entry.play);
    grid.appendChild(cell);
  });

  const toggle = board.querySelector<HTMLButtonElement>("#sbToggle")!;
  toggle.addEventListener("click", () => {
    setSoundEnabled(!soundEnabled());
    toggle.textContent = `sound ${soundEnabled() ? "on" : "off"}`;
  });

  const spin = board.querySelector<HTMLInputElement>("#sbSpin")!;
  const spinValue = board.querySelector<HTMLSpanElement>("#sbSpinValue")!;
  // The real thing is driven from the render loop, so drive it on a timer here
  // rather than only on input events — that is what exposes clicks and buzzes.
  setInterval(() => {
    const rate = Number(spin.value);
    spinValue.textContent = rate.toFixed(3);
    setSpinRate(rate);
  }, 16);
}
