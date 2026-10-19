import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AudioEngine,
  buildEqualPowerCurve,
  computeMasterGain,
  computeMusicTargetGain,
  DEFAULT_MIX,
  DUCK_ATTACK_MS,
  DUCK_RELEASE_MS,
  duckFactor,
  equalPowerGains,
  normalizeMix,
  rampTimeConstant,
  shouldDuck,
  valueAfterTargetRamp,
  type AnalyserNodeLike,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioParamLike,
  type GainNodeLike,
  type MediaElementLike
} from '../../src/renderer/src/services/audioEngine';
import type { AudioMix, MediaItem } from '../../src/renderer/src/types';

/* ------------------------------ Test doubles ------------------------------ */

type ParamCall =
  | { fn: 'setValueAtTime'; value: number; time: number }
  | { fn: 'linearRampToValueAtTime'; value: number; time: number }
  | { fn: 'setTargetAtTime'; value: number; time: number; timeConstant: number }
  | { fn: 'setValueCurveAtTime'; values: number[]; time: number; duration: number }
  | { fn: 'cancelScheduledValues'; time: number };

class FakeParam implements AudioParamLike {
  value = 1;
  calls: ParamCall[] = [];
  setValueAtTime(value: number, time: number): void {
    this.calls.push({ fn: 'setValueAtTime', value, time });
    this.value = value;
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push({ fn: 'linearRampToValueAtTime', value, time });
  }
  setTargetAtTime(value: number, time: number, timeConstant: number): void {
    this.calls.push({ fn: 'setTargetAtTime', value, time, timeConstant });
  }
  setValueCurveAtTime(values: Float32Array, time: number, duration: number): void {
    this.calls.push({ fn: 'setValueCurveAtTime', values: Array.from(values), time, duration });
  }
  cancelScheduledValues(time: number): void {
    this.calls.push({ fn: 'cancelScheduledValues', time });
  }
  last<F extends ParamCall['fn']>(fn: F): Extract<ParamCall, { fn: F }> | undefined {
    for (let i = this.calls.length - 1; i >= 0; i -= 1) {
      const call = this.calls[i];
      if (call.fn === fn) return call as Extract<ParamCall, { fn: F }>;
    }
    return undefined;
  }
  count(fn: ParamCall['fn']): number {
    return this.calls.filter((c) => c.fn === fn).length;
  }
}

class FakeNode implements AudioNodeLike {
  connections: AudioNodeLike[] = [];
  connect(destination: AudioNodeLike): void {
    this.connections.push(destination);
  }
  disconnect(): void {
    this.connections = [];
  }
}

class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam();
}

class FakeAnalyser extends FakeNode implements AnalyserNodeLike {
  fftSize = 2048;
  peakValue = 0;
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(0);
    array[3] = -this.peakValue;
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 10;
  state = 'running';
  readonly destination = new FakeNode();
  gains: FakeGain[] = [];
  analysers: FakeAnalyser[] = [];
  sources: FakeNode[] = [];
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  createMediaElementSource(): FakeNode {
    const node = new FakeNode();
    this.sources.push(node);
    return node;
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

class FakeMediaElement implements MediaElementLike {
  src = '';
  loop = false;
  currentTime = 0;
  duration = 120;
  paused = true;
  crossOrigin: string | null = null;
  preload = '';
  error: { code: number; message: string } | null = null;
  private listeners = new Map<string, Array<() => void>>();
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {
    this.currentTime = 0;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener)
    );
  }
  emit(type: string): void {
    (this.listeners.get(type) ?? []).forEach((l) => l());
  }
}

interface Harness {
  engine: AudioEngine;
  ctx: FakeContext;
  elements: FakeMediaElement[];
  master: FakeGain;
  music: FakeGain;
  video: FakeGain;
  errors: Array<{ media: MediaItem | null; message: string }>;
}

/** Graph creation order in AudioEngine.ensureGraph: master, music, video, then per-deck gains. */
function createHarness(mix: Partial<AudioMix> = {}): Harness {
  const ctx = new FakeContext();
  const elements: FakeMediaElement[] = [];
  const errors: Array<{ media: MediaItem | null; message: string }> = [];
  const engine = new AudioEngine({
    createContext: () => ctx,
    createMediaElement: () => {
      const el = new FakeMediaElement();
      elements.push(el);
      return el;
    },
    onMediaError: (media, message) => errors.push({ media, message })
  });
  engine.init();
  engine.setMix({ ...DEFAULT_MIX, ...mix });
  const [master, music, video] = ctx.gains;
  return { engine, ctx, elements, master, music, video, errors };
}

const track = (id: string): MediaItem => ({
  id,
  name: `${id}.mp3`,
  filePath: `/media/${id}.mp3`,
  fileUrl: `local-media://media/${id}.mp3`,
  type: 'audio'
});

/* --------------------------------- Tests --------------------------------- */

describe('ducking & gain formulas', () => {
  it('80 % attenuation leaves 20 % of the music level', () => {
    expect(duckFactor(80)).toBeCloseTo(0.2, 10);
    expect(computeMusicTargetGain({ bgMusicVolume: 0.8, isDucked: true, duckAttenuationPercent: 80 })).toBeCloseTo(0.16, 10);
    expect(computeMusicTargetGain({ bgMusicVolume: 0.8, isDucked: false, duckAttenuationPercent: 80 })).toBeCloseTo(0.8, 10);
  });

  it('clamps attenuation and volume into range', () => {
    expect(duckFactor(-20)).toBe(1);
    expect(duckFactor(150)).toBe(0);
    expect(computeMusicTargetGain({ bgMusicVolume: 1.7, isDucked: false, duckAttenuationPercent: 0 })).toBe(1);
    expect(computeMusicTargetGain({ bgMusicVolume: -1, isDucked: true, duckAttenuationPercent: 50 })).toBe(0);
  });

  it('master gain respects mute', () => {
    expect(computeMasterGain({ masterVolume: 0.7, isMuted: false })).toBeCloseTo(0.7);
    expect(computeMasterGain({ masterVolume: 0.7, isMuted: true })).toBe(0);
  });

  it('ramp time constants settle ~95 % within the attack/release windows', () => {
    const attack = rampTimeConstant(DUCK_ATTACK_MS);
    const release = rampTimeConstant(DUCK_RELEASE_MS);
    expect(attack).toBeCloseTo(0.1333, 3);
    expect(release).toBeCloseTo(0.4, 6);

    const duckedAt400ms = valueAfterTargetRamp(1, 0.2, attack, DUCK_ATTACK_MS / 1000);
    expect((1 - duckedAt400ms) / (1 - 0.2)).toBeGreaterThan(0.94);

    const restoredAt1200ms = valueAfterTargetRamp(0.2, 1, release, DUCK_RELEASE_MS / 1000);
    expect((restoredAt1200ms - 0.2) / (1 - 0.2)).toBeGreaterThan(0.94);
  });

  it('only ducks when every condition holds', () => {
    const base = { autoDuckEnabled: true, cueDuckEnabled: true, videoPlaying: true, videoAudioVolume: 1 };
    expect(shouldDuck(base)).toBe(true);
    expect(shouldDuck({ ...base, autoDuckEnabled: false })).toBe(false);
    expect(shouldDuck({ ...base, cueDuckEnabled: false })).toBe(false);
    expect(shouldDuck({ ...base, videoPlaying: false })).toBe(false);
    expect(shouldDuck({ ...base, videoAudioVolume: 0 })).toBe(false);
  });

  it('equal-power crossfade keeps constant power', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const { fadeIn, fadeOut } = equalPowerGains(p);
      expect(fadeIn ** 2 + fadeOut ** 2).toBeCloseTo(1, 10);
    }
    const curveIn = buildEqualPowerCurve(16, 'in');
    const curveOut = buildEqualPowerCurve(16, 'out', 0.5);
    expect(curveIn[0]).toBeCloseTo(0);
    expect(curveIn[15]).toBeCloseTo(1);
    expect(curveOut[0]).toBeCloseTo(0.5);
    expect(curveOut[15]).toBeCloseTo(0);
  });

  it('normalizes untrusted mixes', () => {
    expect(
      normalizeMix({
        bgMusicVolume: 3,
        videoAudioVolume: -1,
        masterVolume: Number.NaN,
        isMuted: false,
        autoDuckEnabled: true,
        duckAttenuationPercent: 500
      })
    ).toEqual({
      bgMusicVolume: 1,
      videoAudioVolume: 0,
      masterVolume: 0,
      isMuted: false,
      autoDuckEnabled: true,
      duckAttenuationPercent: 100
    });
  });
});

describe('AudioEngine graph & ducking', () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    h = createHarness({ bgMusicVolume: 0.5, duckAttenuationPercent: 80 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes music and video buses through the master bus', () => {
    expect(h.music.connections).toContain(h.master);
    expect(h.video.connections).toContain(h.master);
    expect(h.master.connections).toContain(h.ctx.destination);
    // two music decks are wired into the music bus with their own gain stage
    const deckGains = h.ctx.gains.slice(3, 5);
    deckGains.forEach((g) => expect(g.connections).toContain(h.music));
  });

  it('ramps the music bus down over 400 ms when video starts and back over 1200 ms when it stops', () => {
    const changed = h.engine.setVideoActivity(true, true);
    expect(changed).toBe(true);
    expect(h.engine.isDucked()).toBe(true);

    const duck = h.music.gain.last('setTargetAtTime');
    expect(duck).toBeDefined();
    expect(duck?.value).toBeCloseTo(0.5 * 0.2, 10);
    expect(duck?.time).toBe(h.ctx.currentTime);
    expect(duck?.timeConstant).toBeCloseTo(rampTimeConstant(400), 10);

    h.ctx.currentTime = 42;
    h.engine.setVideoActivity(false, true);
    const release = h.music.gain.last('setTargetAtTime');
    expect(release?.value).toBeCloseTo(0.5, 10);
    expect(release?.time).toBe(42);
    expect(release?.timeConstant).toBeCloseTo(rampTimeConstant(1200), 10);
    expect(h.engine.isDucked()).toBe(false);
  });

  it('anchors the current value before ramping so there is never a jump', () => {
    h.music.gain.value = 0.37;
    h.engine.setVideoActivity(true, true);
    const tail = h.music.gain.calls.slice(-3);
    expect(tail[0]).toEqual({ fn: 'cancelScheduledValues', time: h.ctx.currentTime });
    expect(tail[1]).toEqual({ fn: 'setValueAtTime', value: 0.37, time: h.ctx.currentTime });
    expect(tail[2].fn).toBe('setTargetAtTime');
  });

  it('does not reschedule when the duck state is unchanged', () => {
    h.engine.setVideoActivity(true, true);
    const before = h.music.gain.count('setTargetAtTime');
    expect(h.engine.setVideoActivity(true, true)).toBe(false);
    expect(h.music.gain.count('setTargetAtTime')).toBe(before);
  });

  it('respects the auto-duck switch and the per-cue flag', () => {
    h.engine.setMix({ ...h.engine.getMix(), autoDuckEnabled: false });
    expect(h.engine.setVideoActivity(true, true)).toBe(false);
    expect(h.engine.isDucked()).toBe(false);

    h.engine.setMix({ ...h.engine.getMix(), autoDuckEnabled: true });
    expect(h.engine.isDucked()).toBe(true);

    h.engine.setVideoActivity(true, false);
    expect(h.engine.isDucked()).toBe(false);
  });

  it('keeps the ducked level when the music fader moves during a video', () => {
    h.engine.setVideoActivity(true, true);
    h.engine.setMix({ ...h.engine.getMix(), bgMusicVolume: 1 });
    expect(h.music.gain.last('setTargetAtTime')?.value).toBeCloseTo(0.2, 10);
  });

  it('mutes through the master bus only', () => {
    h.engine.setMix({ ...h.engine.getMix(), isMuted: true });
    expect(h.master.gain.last('setTargetAtTime')?.value).toBe(0);
    expect(h.music.gain.last('setTargetAtTime')?.value).toBeCloseTo(0.5);
  });

  it('crossfades between music decks with equal-power curves', () => {
    h.engine.loadMusic(track('walk-in'), { loop: true, autoplay: true, crossfadeMs: 1000 });
    const deckB = h.ctx.gains[4];
    expect(deckB.gain.last('setValueCurveAtTime')?.duration).toBeCloseTo(1);

    deckB.gain.value = 1;
    h.engine.loadMusic(track('anthem-bed'), { loop: false, autoplay: true, crossfadeMs: 2000 });
    const deckA = h.ctx.gains[3];
    const fadeIn = deckA.gain.last('setValueCurveAtTime');
    const fadeOut = deckB.gain.last('setValueCurveAtTime');
    expect(fadeIn?.values[0]).toBeCloseTo(0);
    expect(fadeIn?.values[fadeIn.values.length - 1]).toBeCloseTo(1);
    expect(fadeOut?.values[0]).toBeCloseTo(1);
    expect(fadeOut?.values[fadeOut.values.length - 1]).toBeCloseTo(0);
    expect(fadeOut?.duration).toBeCloseTo(2);

    expect(h.engine.getTelemetry().bgMusicMediaId).toBe('anthem-bed');

    // the outgoing deck is released after the crossfade
    const outgoingElement = h.elements[1];
    expect(outgoingElement.src).not.toBe('');
    vi.advanceTimersByTime(2100);
    expect(outgoingElement.src).toBe('');
    expect(outgoingElement.paused).toBe(true);
  });

  it('F9 fades the music bus to silence over 3 s, then pauses and restores the bus level', () => {
    h.engine.loadMusic(track('bed'), { loop: true, autoplay: true, crossfadeMs: 0 });
    expect(h.engine.fadeOutMusic(3000)).toBe(true);
    const ramp = h.music.gain.last('linearRampToValueAtTime');
    expect(ramp?.value).toBe(0);
    expect(ramp?.time).toBeCloseTo(h.ctx.currentTime + 3);
    expect(h.engine.getTelemetry().isFadingOut).toBe(true);

    // ducking during the fade must not fight the fade
    const targetsBefore = h.music.gain.count('setTargetAtTime');
    h.engine.setVideoActivity(true, true);
    expect(h.music.gain.count('setTargetAtTime')).toBe(targetsBefore);

    vi.advanceTimersByTime(3100);
    const telemetry = h.engine.getTelemetry();
    expect(telemetry.isFadingOut).toBe(false);
    expect(telemetry.isBgMusicPlaying).toBe(false);
    // bus restored to the (ducked) target so the next Play is audible
    expect(h.music.gain.last('setValueAtTime')?.value).toBeCloseTo(0.5 * 0.2);
  });

  it('refuses to fade when nothing is playing', () => {
    expect(h.engine.fadeOutMusic()).toBe(false);
  });

  it('wires each video element once and ramps slot gains linearly', () => {
    const el = new FakeMediaElement();
    h.engine.registerVideoElement(0, el);
    h.engine.registerVideoElement(0, el);
    expect(h.ctx.sources.length).toBe(2 + 1); // two music decks + one video element
    const slotGain = h.ctx.gains[h.ctx.gains.length - 1];
    expect(slotGain.connections).toContain(h.video);

    h.engine.setVideoSlotGain(0, 1, 500);
    expect(slotGain.gain.last('linearRampToValueAtTime')).toEqual({
      fn: 'linearRampToValueAtTime',
      value: 1,
      time: h.ctx.currentTime + 0.5
    });
  });

  it('reports peak levels from the analysers', () => {
    const [musicAnalyser, videoAnalyser, masterAnalyser] = h.ctx.analysers;
    musicAnalyser.peakValue = 0.5;
    videoAnalyser.peakValue = 0.25;
    masterAnalyser.peakValue = 2;
    const { levels } = h.engine.getTelemetry();
    expect(levels.music).toBeCloseTo(0.5);
    expect(levels.video).toBeCloseTo(0.25);
    expect(levels.master).toBe(1);
  });

  it('surfaces decode errors for the loaded track', () => {
    h.engine.loadMusic(track('broken'), { loop: false, autoplay: false, crossfadeMs: 0 });
    const deck = h.elements[1];
    deck.error = { code: 3, message: 'DEMUXER_ERROR' };
    deck.emit('error');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].media?.id).toBe('broken');
    expect(h.errors[0].message).toMatch(/codec/i);
  });
});
