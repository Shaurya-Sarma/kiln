/**
 * Kiln's sound, synthesized from scratch.
 *
 * No audio files, ever — the same no-assets rule as the textures and the
 * environment map. Every sound below is built out of Web Audio primitives at
 * runtime: noise buffers, oscillators, biquad filters, gain envelopes, and one
 * convolution reverb whose impulse response is itself a generated noise burst.
 *
 * The aesthetic is RESTRAINT. A studio is a quiet room: a wheel, a shelf, a
 * kiln that is either roaring or silent. Most of the UI therefore says nothing
 * at all, and the things that do speak are traceable to a physical event in a
 * real pottery studio. Peaks stay well under 0.25; the whole palette is meant
 * to sit under conversation, not over it.
 *
 * ---------------------------------------------------------------------------
 * THE MAP — interaction → sound
 * ---------------------------------------------------------------------------
 * SPEAKS
 *   grab the pot            wet clay under a palm      band-passed white-noise
 *     clayGrab()            (hand meeting damp wall)   squelch, 620→260 Hz, plus
 *                                                      a 110 Hz body thud   [gesture]
 *   drag-spin (continuous)  wheel head + bearing       brown noise through a
 *     setSpinRate()         (stone rumble, not a       band-pass whose freq and
 *                           motor — this is a kick     gain track |rate|, over a
 *                           wheel)                     55–145 Hz bearing sine.
 *                                                      SILENT at idle speed  [gesture]
 *   release flick (fast)    air off a spun rim         noise through a band-pass
 *     flickRelease()                                   swept 900→2400→700 Hz;
 *                                                      only above a real flick,
 *                                                      else the spin loop's own
 *                                                      decay carries it      [gesture]
 *   pot settles             stoneware set on plaster   90 Hz thud + a DARK, short
 *     potSettle()                                      modal ring (1.35k/1.98k) —
 *                                                      the muted cousin of tink()
 *                                                                            [gesture]
 *   kiln reveal             struck high-fired          two detuned sine partials
 *     tink()                stoneware                  (2.09k/3.15k), fast decay
 *                                                                             [firing]
 *   FIRE pressed            gas burner catching        low noise whoomp + 62→38 Hz
 *     startRoar()           then a pressure roar       sine drop, into looped
 *                                                      brown noise under a 240 Hz
 *                                                      low-pass, plus sparse
 *                                                      brick/flame crackle pops
 *                                                                             [firing]
 *   kiln door opens         iron latch + heavy brick   68→46 Hz thud + lowpassed
 *     kilnDoor()            door                       noise body + one bright
 *                                                      latch tick               [firing]
 *   FIRE hover              embers breathing in the    very quiet high-passed
 *     emberWhisper()        firebox                    noise, slow swell, sparse
 *                                                      grain flicker            [ui]
 *   keep → shelf            pot set on a wooden board  two woody knocks (190 Hz /
 *     shelfPlace()                                     330 Hz lowpassed impulses)
 *                                                      + a faint ceramic tick   [ui]
 *   +table                  pot set beside another     the same knock, pitched up
 *     tablePlace()          on the work table          and shorter               [ui]
 *   load from shelf         dry hand lifting bisque    short high-passed rub that
 *     shelfLift()           off a board                swells and cuts            [ui]
 *   remove from shelf       pot lifted away, quietly   one soft woody tick, half
 *     shelfRemove()                                    the level of a place       [ui]
 *   clear the table         two pots carried off       two shelfLifts, spaced      [ui]
 *     tableClear()
 *   form/glaze/atmosphere   fingernail on a bisque     25 ms band-passed click +
 *     uiTick()              test tile                  one high partial; pitch
 *                                                      varies per control so the
 *                                                      family reads as one object [ui]
 *   hold slider step        ratchet on a kiln          1.2 kHz click with a small
 *     dialStep()            controller dial            resonant body, throttled so
 *                                                      a drag ratchets, never
 *                                                      clatters                    [ui]
 *   copy link               maker's stamp pressed      dull lowpassed press thud +
 *     stamp()               into leather-hard clay     a faint clay creak           [ui]
 *   room tone (bed)         the studio itself: air,    brown noise under a 180 Hz
 *     ambience()            a distant kiln fan         low-pass with a slow LFO on
 *                                                      cutoff, ~0.02 peak. Starts
 *                                                      with the first gesture and
 *                                                      DUCKS under a firing   [ambient]
 *
 * DELIBERATELY SILENT
 *   camera orbit drag       — a camera is not an object in the room. Giving the
 *                             viewpoint a voice is the one dishonest sound here.
 *   pot hover (cursor)      — a mouse sweeping the stage would machine-gun the
 *                             gesture bus. The cursor change is the feedback.
 *   inspection lamp         — light is silent. A hum would make it an appliance.
 *   pointer parallax        — ditto; it isn't an event, it's a continuous field.
 *   placard / masthead      — text does not speak.
 *   share button hover      — only FIRE, the one irreversible control, gets a
 *                             hover voice. If everything whispers, nothing does.
 *   sound toggle ON         — plays tink() as proof it works, which is the whole
 *                             point; toggling OFF is silent by definition.
 *
 * MIX
 *   master (0.85) → soft-clip limiter → destination. Four buses feed it dry and
 *   send to one shared reverb, so every sound lands in the same small room:
 *     ui 0.32 (send 0.14) · gesture 0.50 (0.10) · firing 0.85 (0.06) ·
 *     ambient 0.20 (0.00 — the bed is already diffuse)
 *   Rules: UI one-shots pass a throttle gate (nothing stacks into clatter);
 *   tink() and potSettle() share one "ceramic" gate so a firing's reveal never
 *   doubles with the entrance settle; the continuous spin loop only ever moves
 *   its gain via setTargetAtTime and tears down after a ramp, so it cannot click.
 *
 * Browsers only allow audio after a user gesture. Most entry points here are
 * click- or pointerdown-driven, but two (the entrance settle and the wheel
 * loop) are driven by the render loop and can fire before anyone has touched
 * the page — so the rig itself is gated on a real gesture rather than trusting
 * the call sites. Nothing exists, not even the AudioContext, until then.
 * (prefers-reduced-motion deliberately does NOT gate audio — it is a motion
 * preference — but the master enable toggle governs everything.)
 */

const STORAGE_KEY = "kiln.sound.v1";

type Bus = "ui" | "gesture" | "firing" | "ambient";

/** Relative bus levels. Quiet by design: the loudest peak in the palette is
 * the firing roar, and even that lands around 0.17 at the destination. */
const BUS_LEVEL: Record<Bus, number> = { ui: 0.32, gesture: 0.5, firing: 0.85, ambient: 0.2 };
/** How much of each bus goes to the shared room reverb. */
const BUS_SEND: Record<Bus, number> = { ui: 0.14, gesture: 0.1, firing: 0.06, ambient: 0 };
const MASTER_LEVEL = 0.85;

let enabled = localStorage.getItem(STORAGE_KEY) !== "off";

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  if (!on) {
    stopRoar();
    setSpinRate(0);
    stopAmbience();
  } else if (rig) {
    startAmbience();
  }
}

// ---------------------------------------------------------------------------
// the rig: master chain, buses, one shared room
// ---------------------------------------------------------------------------

type Rig = {
  ctx: AudioContext;
  bus: Record<Bus, GainNode>;
};

let rig: Rig | null = null;

/**
 * Gesture gate. Most of the palette is click-driven, but two voices are not:
 * the entrance settle and the wheel loop are driven by the render loop, and the
 * very first pot settles onto the pedestal before the visitor has touched
 * anything. Building an AudioContext there earns a console warning and a
 * permanently suspended context, so nothing may build the rig until a real
 * gesture has landed — which also means the pot you didn't ask for arrives
 * silently, as it should.
 */
let gestured = false;
(["pointerdown", "keydown", "touchstart"] as const).forEach((type) => {
  addEventListener(
    type,
    () => {
      gestured = true;
    },
    { capture: true, once: true, passive: true },
  );
});

/** A tanh-shaped transfer curve on the master. Not a real limiter — a safety
 * net, so no amount of stacked one-shots can hand the speaker a clipped edge. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
  }
  return curve;
}

function ensureRig(): Rig {
  if (rig) {
    if (rig.ctx.state === "suspended") void rig.ctx.resume();
    return rig;
  }
  const ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();

  const limiter = ctx.createWaveShaper();
  limiter.curve = softClipCurve();
  limiter.oversample = "2x";
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = MASTER_LEVEL;
  master.connect(limiter);

  // One room for everything. A shared reverb is what makes a wooden knock, a
  // ceramic tick and a kiln roar sound like they happened in the same studio
  // instead of in four different plugins.
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(ctx);
  const roomReturn = ctx.createGain();
  roomReturn.gain.value = 0.9;
  room.connect(roomReturn).connect(master);

  const bus = {} as Record<Bus, GainNode>;
  (Object.keys(BUS_LEVEL) as Bus[]).forEach((name) => {
    const gain = ctx.createGain();
    gain.gain.value = BUS_LEVEL[name];
    gain.connect(master);
    const send = ctx.createGain();
    send.gain.value = BUS_SEND[name];
    gain.connect(send).connect(room);
    bus[name] = gain;
  });

  rig = { ctx, bus };
  startAmbience(); // first gesture just happened, by construction
  return rig;
}

/**
 * A small plaster-and-brick room, synthesized: exponentially decaying noise is
 * the textbook impulse response, because that IS what a diffuse tail is — an
 * enormous number of reflections arriving at random times and dying off. Two
 * decorrelated channels give it width; a couple of louder early reflections in
 * the first 30 ms give it size.
 */
function roomImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 1.05;
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const k = i / length;
      // ^2.6 tail: fast early collapse, long quiet ring-out — a small hard room
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - k, 2.6) * 0.6;
    }
    // Early reflections: the near wall and the bench top.
    [0.009, 0.017, 0.028].forEach((t, n) => {
      const at = Math.floor(t * ctx.sampleRate) + ch * 37;
      if (at < length) data[at] = (n === 0 ? 0.7 : 0.4) * (Math.random() < 0.5 ? -1 : 1);
    });
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

type NoiseKind = "white" | "brown";

const noiseBuffers = new Map<NoiseKind, AudioBuffer>();

/** Two seconds of noise per flavour, built once and reused by every sound. */
function noise(ctx: AudioContext, kind: NoiseKind): AudioBuffer {
  const cached = noiseBuffers.get(kind);
  if (cached) return cached;
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    if (kind === "white") {
      data[i] = white;
    } else {
      // integrate white noise -> brown: each sample a small step from the last,
      // which is the deep rumble spectrum (-6 dB/octave)
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5; // make up the gain the integration lost
    }
  }
  noiseBuffers.set(kind, buffer);
  return buffer;
}

/** UI one-shots must never stack into clatter. `gate` is the whole policy. */
const lastPlayed = new Map<string, number>();
function gate(key: string, minMs: number): boolean {
  const now = performance.now();
  const prev = lastPlayed.get(key);
  if (prev !== undefined && now - prev < minMs) return false;
  lastPlayed.set(key, now);
  return true;
}

/** Every public sound starts here: nothing exists while sound is off. */
function open(bus: Bus): { ctx: AudioContext; out: GainNode; t: number } | null {
  if (!enabled || (!gestured && !rig)) return null;
  const r = ensureRig();
  return { ctx: r.ctx, out: r.bus[bus], t: r.ctx.currentTime };
}

type BurstOptions = {
  bus: Bus;
  peak: number;
  decay: number;
  /** Filter centre frequency, and where it sweeps to over the decay. */
  freq: number;
  freqTo?: number;
  type?: BiquadFilterType;
  q?: number;
  kind?: NoiseKind;
  attack?: number;
  delay?: number;
};

/** A filtered noise burst — the workhorse behind every impact, rub and whoosh. */
function burst(o: BurstOptions) {
  const ctx = rig?.ctx;
  if (!ctx || !enabled) return;
  const out = rig!.bus[o.bus];
  const t = ctx.currentTime + (o.delay ?? 0);
  const attack = o.attack ?? 0.002;

  const src = ctx.createBufferSource();
  src.buffer = noise(ctx, o.kind ?? "white");
  src.loop = true;
  // Random read offset: two clicks from the same buffer are otherwise the
  // identical waveform, which the ear hears as a machine rather than a hand.
  const offset = Math.random() * 1.5;

  const filter = ctx.createBiquadFilter();
  filter.type = o.type ?? "bandpass";
  filter.Q.value = o.q ?? 1;
  filter.frequency.setValueAtTime(o.freq, t);
  if (o.freqTo !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(o.freqTo, 20), t + o.decay);
  }

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(o.peak, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + o.decay);

  src.connect(filter).connect(gain).connect(out);
  src.start(t, offset);
  src.stop(t + attack + o.decay + 0.02);
}

type RingOptions = {
  bus: Bus;
  peak: number;
  decay: number;
  /** Modal frequencies, loudest first. */
  partials: number[];
  amps?: number[];
  delay?: number;
  type?: OscillatorType;
};

/** Struck-body modal ring: a few sine partials sharing one decay envelope. */
function ring(o: RingOptions) {
  const ctx = rig?.ctx;
  if (!ctx || !enabled) return;
  const out = rig!.bus[o.bus];
  const t = ctx.currentTime + (o.delay ?? 0);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(o.peak, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
  gain.connect(out);

  o.partials.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    // Struck ceramic isn't harmonic — its partials sit slightly off any whole-
    // number ratio, which is exactly what the small detunes recreate.
    osc.frequency.value = freq * (1 + i * 0.004);
    const partial = ctx.createGain();
    partial.gain.value = o.amps?.[i] ?? (i === 0 ? 1 : 0.45);
    osc.connect(partial).connect(gain);
    osc.start(t);
    osc.stop(t + o.decay + 0.05);
  });
}

/** A pitched thud: the body of an impact, under whatever noise sits on top. */
function thud(bus: Bus, from: number, to: number, peak: number, decay: number, delay = 0) {
  const ctx = rig?.ctx;
  if (!ctx || !enabled) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + decay);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  osc.connect(gain).connect(rig!.bus[bus]);
  osc.start(t);
  osc.stop(t + decay + 0.05);
}

// ---------------------------------------------------------------------------
// the ambient bed — the room itself
// ---------------------------------------------------------------------------
// A studio is never truly silent: there is air, a fan somewhere, the building.
// This bed is barely audible on purpose (peak ~0.02 before the ambient bus
// attenuates it); its job is to make the SILENCE feel like a room, so that the
// gaps between sounds read as quiet rather than as "audio is broken".

let ambience: { src: AudioBufferSourceNode; lfo: OscillatorNode } | null = null;

export function startAmbience() {
  if (!enabled || ambience || !rig) return;
  const { ctx } = rig;
  const t = ctx.currentTime;

  const src = ctx.createBufferSource();
  src.buffer = noise(ctx, "brown");
  src.loop = true;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 180;
  lowpass.Q.value = 0.4;

  // Slow drift on the cutoff: still air still moves. Without it the bed reads
  // as a synthesizer holding a note rather than as a room breathing.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.06;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 55;
  lfo.connect(lfoDepth).connect(lowpass.frequency);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.1, t + 4); // fade in over the entrance

  src.connect(lowpass).connect(gain).connect(rig.bus.ambient);
  src.start();
  lfo.start();
  ambience = { src, lfo };
}

export function stopAmbience() {
  if (!ambience || !rig) return;
  const { ctx } = rig;
  ambience.src.stop(ctx.currentTime + 0.4);
  ambience.lfo.stop(ctx.currentTime + 0.4);
  ambience = null;
}

/** Duck the room under the kiln (1) or let it back up (0). */
function duckAmbience(amount: number) {
  if (!rig) return;
  const g = rig.bus.ambient.gain;
  const t = rig.ctx.currentTime;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(BUS_LEVEL.ambient * (1 - 0.85 * amount), t, 0.35);
}

// ---------------------------------------------------------------------------
// the firing
// ---------------------------------------------------------------------------

let roarStop: (() => void) | null = null;

/**
 * The kiln at temperature: a gas burner catching, then a pressure roar with no
 * pitch — brown noise through a low-pass, swelling while the overlay is dark —
 * with sparse crackle from brick and flame front. Call stopRoar() (or let the
 * firing sequence do it) to wind it down.
 */
export function startRoar() {
  const o = open("firing");
  if (!o) return;
  const { ctx, out, t } = o;
  stopRoar();

  // Ignition: the whoomp of gas catching in the firebox.
  burst({ bus: "firing", peak: 0.16, decay: 0.5, freq: 320, freqTo: 90, type: "lowpass", q: 0.6, kind: "brown" });
  thud("firing", 62, 38, 0.1, 0.45);

  const source = ctx.createBufferSource();
  source.buffer = noise(ctx, "brown");
  source.loop = true;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 240;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.2, t + 1.1); // swell with the dim

  source.connect(lowpass).connect(gain).connect(out);
  source.start();

  // Crackle: expansion ticks in the brickwork and the flame front snapping.
  // Scheduled up front through their own gain so a short firing can silence
  // pops that haven't sounded yet.
  const crackle = ctx.createGain();
  crackle.gain.value = 1;
  crackle.connect(out);
  const pops: AudioBufferSourceNode[] = [];
  for (let i = 0; i < 16; i++) {
    const at = t + 0.35 + Math.random() * 2.4;
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx, "white");
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 500 + Math.random() * 1800;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    const peak = 0.02 + Math.random() * 0.05;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    src.connect(bp).connect(g).connect(crackle);
    src.start(at, Math.random() * 1.5);
    src.stop(at + 0.08);
    pops.push(src);
  }

  duckAmbience(1);

  roarStop = () => {
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9); // door opens, roar fades
    source.stop(now + 1);
    crackle.gain.setTargetAtTime(0.0001, now, 0.15);
    pops.forEach((src) => {
      try {
        src.stop(now + 0.6);
      } catch {
        // already finished — nothing to cancel
      }
    });
    duckAmbience(0);
    roarStop = null;
  };
}

export function stopRoar() {
  roarStop?.();
}

/** The kiln door: an iron latch and a heavy brick-lined slab swinging open. */
export function kilnDoor() {
  if (!open("firing")) return;
  thud("firing", 68, 46, 0.14, 0.3);
  burst({ bus: "firing", peak: 0.09, decay: 0.22, freq: 400, freqTo: 130, type: "lowpass", q: 0.7 });
  burst({ bus: "firing", peak: 0.05, decay: 0.03, freq: 2600, q: 4 }); // the latch
}

/** The ceramic ring of a pot being set down, played at the reveal. */
export function tink() {
  if (!open("firing")) return;
  if (!gate("ceramic", 320)) return;
  ring({ bus: "firing", peak: 0.15, decay: 0.5, partials: [2093, 3151], amps: [1, 0.45] });
}

/** Embers breathing in the firebox — the whisper under a hovered FIRE button. */
export function emberWhisper() {
  if (!open("ui")) return;
  if (!gate("ember", 900)) return;
  // Slow swell of high, airy noise...
  burst({ bus: "ui", peak: 0.045, decay: 0.55, freq: 2600, freqTo: 1600, q: 0.7, attack: 0.18 });
  // ...with a few grains of actual crackle riding on it.
  for (let i = 0; i < 4; i++) {
    burst({
      bus: "ui",
      peak: 0.02 + Math.random() * 0.02,
      decay: 0.04,
      freq: 1400 + Math.random() * 2200,
      q: 3,
      delay: 0.1 + Math.random() * 0.45,
    });
  }
}

// ---------------------------------------------------------------------------
// the wheel: grab, spin, release, settle
// ---------------------------------------------------------------------------

/** Palm meeting a damp wall: a wet clay squelch with a little body behind it. */
export function clayGrab() {
  if (!open("gesture")) return;
  if (!gate("grab", 120)) return;
  burst({ bus: "gesture", peak: 0.08, decay: 0.11, freq: 620, freqTo: 260, q: 1.6, attack: 0.006 });
  thud("gesture", 110, 70, 0.05, 0.09);
}

/**
 * Air coming off a rim that's just been let go. Only above a genuine flick —
 * a slow release should be carried by the spin loop's own decay, not announced.
 */
export function flickRelease(radPerFrame: number) {
  const speed = Math.abs(radPerFrame);
  if (speed < 0.03) return;
  if (!open("gesture")) return;
  const drive = Math.min((speed - 0.03) / 0.12, 1);
  burst({
    bus: "gesture",
    peak: 0.03 + 0.055 * drive,
    decay: 0.16 + 0.1 * drive,
    freq: 900,
    freqTo: 700,
    q: 0.8,
    attack: 0.05,
  });
}

/** Stoneware coming to rest on plaster: a thud plus the DARK, damped cousin of
 * tink() — a pot set down still holds its glaze-side ring back. */
export function potSettle() {
  if (!open("gesture")) return;
  if (!gate("ceramic", 320)) return; // shared with tink(): a reveal never doubles
  thud("gesture", 90, 58, 0.07, 0.13);
  ring({ bus: "gesture", peak: 0.05, decay: 0.22, partials: [1348, 1979], amps: [1, 0.3] });
}

/**
 * The continuous voice of the wheel, driven from the render loop.
 *
 * A kick wheel is a stone flywheel on a greased bearing: mostly low broadband
 * rumble whose brightness rises with speed, over a faint bearing tone. Called
 * every frame, so it does nothing but move two params — and it is SILENT at
 * idle speed, because a wheel ticking over under its own inertia makes no
 * sound you'd notice in a quiet room, and an endless hum would be intolerable.
 */
const SPIN_FLOOR = 0.012; // rad/frame — below this the wheel is inaudible
const SPIN_RANGE = 0.09;

let spinLoop: {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  tone: OscillatorNode;
  toneGain: GainNode;
} | null = null;
let spinIdleSince = 0;

export function setSpinRate(radPerFrame: number) {
  const drive = Math.min(Math.max((Math.abs(radPerFrame) - SPIN_FLOOR) / SPIN_RANGE, 0), 1);
  if (!enabled || (!gestured && !rig) || (drive === 0 && !spinLoop)) return;

  if (!spinLoop) {
    const { ctx, bus } = ensureRig();
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx, "brown");
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.8;
    filter.frequency.value = 400;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    // The bearing: one quiet sine that rises with the flywheel.
    const tone = ctx.createOscillator();
    tone.frequency.value = 55;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.0001;
    src.connect(filter).connect(gain).connect(bus.gesture);
    tone.connect(toneGain).connect(bus.gesture);
    src.start();
    tone.start();
    spinLoop = { src, filter, gain, tone, toneGain };
  }

  const { ctx } = rig!;
  const t = ctx.currentTime;
  // Everything moves via setTargetAtTime: a param jumped per-frame is a buzz,
  // and a param stopped without a ramp is a click.
  spinLoop.gain.gain.setTargetAtTime(0.075 * Math.pow(drive, 1.5), t, 0.08);
  spinLoop.filter.frequency.setTargetAtTime(400 + 1400 * drive, t, 0.1);
  spinLoop.tone.frequency.setTargetAtTime(55 + 90 * drive, t, 0.12);
  spinLoop.toneGain.gain.setTargetAtTime(0.02 * drive, t, 0.1);

  // Tear down once it has been silent for a moment — after the ramp has landed,
  // never during it.
  if (drive > 0) {
    spinIdleSince = 0;
  } else {
    spinIdleSince ||= performance.now();
    if (performance.now() - spinIdleSince > 700) {
      const loop = spinLoop;
      loop.src.stop(t + 0.1);
      loop.tone.stop(t + 0.1);
      spinLoop = null;
    }
  }
}

// ---------------------------------------------------------------------------
// the shelf and the work table
// ---------------------------------------------------------------------------

/** A fired pot set down on a wooden shelf board: two knocks, wood then foot. */
export function shelfPlace() {
  if (!open("ui")) return;
  if (!gate("shelf", 90)) return;
  burst({ bus: "ui", peak: 0.13, decay: 0.09, freq: 190, freqTo: 120, type: "lowpass", q: 0.9 });
  burst({ bus: "ui", peak: 0.07, decay: 0.05, freq: 330, freqTo: 220, type: "lowpass", q: 1.2, delay: 0.035 });
  ring({ bus: "ui", peak: 0.03, decay: 0.13, partials: [1720], delay: 0.01 });
}

/** The same knock on the work table beside another pot: shorter, brighter. */
export function tablePlace() {
  if (!open("ui")) return;
  if (!gate("shelf", 90)) return;
  burst({ bus: "ui", peak: 0.1, decay: 0.06, freq: 300, freqTo: 190, type: "lowpass", q: 1 });
  ring({ bus: "ui", peak: 0.035, decay: 0.1, partials: [2180], delay: 0.008 });
}

/** A dry hand lifting bisque off a board: a rub that swells and cuts. */
export function shelfLift() {
  if (!open("ui")) return;
  if (!gate("lift", 90)) return;
  burst({ bus: "ui", peak: 0.05, decay: 0.1, freq: 1500, freqTo: 2600, q: 0.9, attack: 0.05 });
}

/** Taking a pot off the shelf for good — the quietest gesture in the app. */
export function shelfRemove() {
  if (!open("ui")) return;
  if (!gate("lift", 90)) return;
  burst({ bus: "ui", peak: 0.05, decay: 0.07, freq: 240, freqTo: 160, type: "lowpass", q: 0.9 });
}

/** Clearing the table: two pots carried off, one after the other. */
export function tableClear() {
  if (!open("ui")) return;
  shelfLift();
  burst({ bus: "ui", peak: 0.04, decay: 0.09, freq: 1400, freqTo: 2300, q: 0.9, attack: 0.05, delay: 0.13 });
}

// ---------------------------------------------------------------------------
// the recipe card
// ---------------------------------------------------------------------------

/** Fingernail against a bisque test tile. One family, pitched per control, so
 * the recipe card sounds like a single object being handled. */
const TICK_PITCH = { form: 3400, glaze: 4200, atmosphere: 3800 } as const;

export function uiTick(control: keyof typeof TICK_PITCH = "form") {
  if (!open("ui")) return;
  if (!gate("tick", 60)) return;
  const freq = TICK_PITCH[control];
  burst({ bus: "ui", peak: 0.05, decay: 0.025, freq, q: 3 });
  ring({ bus: "ui", peak: 0.025, decay: 0.07, partials: [freq * 1.42] });
}

/** The ratchet of a kiln controller dial, one detent per step. Throttled: a
 * fast slider drag should ratchet like a real dial, never clatter. */
export function dialStep() {
  if (!open("ui")) return;
  if (!gate("dial", 45)) return;
  burst({ bus: "ui", peak: 0.055, decay: 0.02, freq: 1200, q: 5 });
  burst({ bus: "ui", peak: 0.03, decay: 0.045, freq: 320, freqTo: 240, type: "lowpass", q: 1.4 });
}

/** The maker's stamp pressed into leather-hard clay: a dull thud and a creak. */
export function stamp() {
  if (!open("ui")) return;
  if (!gate("stamp", 250)) return;
  thud("ui", 150, 90, 0.1, 0.11);
  burst({ bus: "ui", peak: 0.06, decay: 0.13, freq: 520, freqTo: 300, q: 1.2, attack: 0.012 });
}
