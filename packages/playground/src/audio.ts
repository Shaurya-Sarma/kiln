/**
 * Kiln's sound, synthesized from scratch.
 *
 * No audio files — both sounds are built out of Web Audio primitives at
 * runtime, the same no-assets rule as the textures and the environment map:
 *
 * - The ROAR of a firing: brown noise (each sample a small random step from
 *   the last — the deep rumble spectrum) through a low-pass filter, swelling
 *   while the kiln overlay is dark. A gas kiln at temperature really does
 *   sound like this: a pressure roar with no pitch.
 * - The TINK of unloading: two detuned sine partials with a fast exponential
 *   decay — the modal ring of struck ceramic. High-fired stoneware rings
 *   brighter than earthenware, so the partials sit high (~2.1k / 3.1kHz).
 *
 * Browsers only allow audio after a user gesture; every entry point here is
 * click-driven (FIRE, the toggle), so the context resumes naturally.
 */

const STORAGE_KEY = "kiln.sound.v1";

let context: AudioContext | null = null;
let roarStop: (() => void) | null = null;

let enabled = localStorage.getItem(STORAGE_KEY) !== "off";

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  if (!on) stopRoar();
}

function ensureContext(): AudioContext {
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
}

/** Two seconds of brown noise, looped. Built once, reused every firing. */
let brownBuffer: AudioBuffer | null = null;
function getBrownBuffer(ctx: AudioContext): AudioBuffer {
  if (brownBuffer) return brownBuffer;
  const length = ctx.sampleRate * 2;
  brownBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = brownBuffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02; // integrate white noise -> brown
    data[i] = last * 3.5; // make up the gain the integration lost
  }
  return brownBuffer;
}

/** Start the kiln roar; returns nothing — call stopRoar() (or let the firing
 * sequence do it) to wind it down. */
export function startRoar() {
  if (!enabled) return;
  const ctx = ensureContext();
  stopRoar();

  const source = ctx.createBufferSource();
  source.buffer = getBrownBuffer(ctx);
  source.loop = true;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 240;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 1.1); // swell with the dim

  source.connect(lowpass).connect(gain).connect(ctx.destination);
  source.start();

  roarStop = () => {
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9); // door opens, roar fades
    source.stop(t + 1);
    roarStop = null;
  };
}

export function stopRoar() {
  roarStop?.();
}

/** The ceramic ring of a pot being set down, played at the reveal. */
export function tink() {
  if (!enabled) return;
  const ctx = ensureContext();
  const t = ctx.currentTime;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.11, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  gain.connect(ctx.destination);

  // Struck ceramic isn't harmonic — its partials sit slightly off any whole-
  // number ratio, which is exactly what the small detunes recreate.
  [2093, 3151].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq * (1 + (i === 0 ? 0 : 0.004));
    const partial = ctx.createGain();
    partial.gain.value = i === 0 ? 1 : 0.45;
    osc.connect(partial).connect(gain);
    osc.start(t);
    osc.stop(t + 0.55);
  });
}
