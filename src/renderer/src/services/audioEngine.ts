import type { AudioMix, AudioTelemetry, MediaItem } from '../types';
import { clamp, clamp01, finiteOr } from './utils';

/* =========================================================================
 * Web Audio engine (runs inside the Stage window, next to the video decoder).
 *
 *   music deck A ─┐                                  ┌─► analyser (music)
 *                 ├─► deck gains ─► musicGainNode ───┤
 *   music deck B ─┘                                  └─┐
 *                                                      ├─► masterGain ─► destination
 *   video slot 0 ─┐                                  ┌─┘        └─► analyser (master)
 *                 ├─► slot gains ─► videoGainNode ───┤
 *   video slot 1 ─┘                                  └─► analyser (video)
 *
 * Auto-ducking lowers musicGainNode while foreground video audio is playing
 * and restores it when the video pauses or ends.
 * ========================================================================= */

export const DUCK_ATTACK_MS = 400;
export const DUCK_RELEASE_MS = 1200;
export const FADE_OUT_MS = 3000;
export const DEFAULT_DUCK_PERCENT = 80;
/** Short smoothing for fader moves so they never "zipper". */
export const FADER_SMOOTHING_SECONDS = 0.03;
const ANALYSER_SIZE = 1024;

export const DEFAULT_MIX: AudioMix = {
  bgMusicVolume: 0.8,
  videoAudioVolume: 1,
  masterVolume: 1,
  isMuted: false,
  autoDuckEnabled: true,
  duckAttenuationPercent: DEFAULT_DUCK_PERCENT
};

/* --------------------------- Pure gain math ------------------------------ */

/** Fraction of the music level that remains while ducked (80 % attenuation → 0.2). */
export function duckFactor(duckAttenuationPercent: number): number {
  return 1 - clamp(duckAttenuationPercent, 0, 100) / 100;
}

export function computeMusicTargetGain(params: {
  bgMusicVolume: number;
  isDucked: boolean;
  duckAttenuationPercent: number;
}): number {
  const base = clamp01(params.bgMusicVolume);
  return params.isDucked ? base * duckFactor(params.duckAttenuationPercent) : base;
}

export function computeMasterGain(params: { masterVolume: number; isMuted: boolean }): number {
  return params.isMuted ? 0 : clamp01(params.masterVolume);
}

/**
 * `setTargetAtTime` approaches its target exponentially. Using a time constant
 * of duration / 3 means the ramp is ~95 % complete when the duration elapses:
 * 400 ms duck → τ ≈ 0.133 s, 1200 ms release → τ = 0.4 s.
 */
export function rampTimeConstant(durationMs: number): number {
  return Math.max(0.001, durationMs / 1000 / 3);
}

/** Value reached by setTargetAtTime after `elapsedSeconds`. */
export function valueAfterTargetRamp(start: number, target: number, timeConstant: number, elapsedSeconds: number): number {
  return target + (start - target) * Math.exp(-elapsedSeconds / timeConstant);
}

export function shouldDuck(params: {
  autoDuckEnabled: boolean;
  cueDuckEnabled: boolean;
  videoPlaying: boolean;
  videoAudioVolume: number;
}): boolean {
  return params.autoDuckEnabled && params.cueDuckEnabled && params.videoPlaying && params.videoAudioVolume > 0.001;
}

/** Equal-power crossfade gains for progress 0…1 (sum of squares is always 1). */
export function equalPowerGains(progress: number): { fadeOut: number; fadeIn: number } {
  const p = clamp01(progress);
  return { fadeOut: Math.cos((p * Math.PI) / 2), fadeIn: Math.sin((p * Math.PI) / 2) };
}

export function buildEqualPowerCurve(steps: number, direction: 'in' | 'out', scale = 1): Float32Array {
  const count = Math.max(2, Math.floor(steps));
  const curve = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const gains = equalPowerGains(i / (count - 1));
    curve[i] = (direction === 'in' ? gains.fadeIn : gains.fadeOut) * scale;
  }
  return curve;
}

export function normalizeMix(mix: AudioMix): AudioMix {
  return {
    bgMusicVolume: clamp01(mix.bgMusicVolume),
    videoAudioVolume: clamp01(mix.videoAudioVolume),
    masterVolume: clamp01(mix.masterVolume),
    isMuted: Boolean(mix.isMuted),
    autoDuckEnabled: Boolean(mix.autoDuckEnabled),
    duckAttenuationPercent: clamp(mix.duckAttenuationPercent, 0, 100)
  };
}

/* ------------------------ Structural Web Audio types --------------------- */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  setValueCurveAtTime(values: Float32Array, startTime: number, duration: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AnalyserNodeLike extends AudioNodeLike {
  fftSize: number;
  getFloatTimeDomainData(array: Float32Array): void;
}

export interface MediaElementLike {
  src: string;
  loop: boolean;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  crossOrigin: string | null;
  preload: string;
  readonly error: { code: number; message: string } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createAnalyser(): AnalyserNodeLike;
  createMediaElementSource(element: MediaElementLike): AudioNodeLike;
  resume(): Promise<void>;
  close(): Promise<void>;
  /** Chromium 110+: route the whole graph to another output device ('' = default). */
  setSinkId?(sinkId: string): Promise<void>;
  readonly sinkId?: string | object;
}

export interface AudioEngineDeps {
  createContext: () => AudioContextLike;
  createMediaElement: () => MediaElementLike;
  onMediaError?: (media: MediaItem | null, message: string, code: number | null) => void;
}

export interface MusicLoadOptions {
  loop: boolean;
  autoplay: boolean;
  crossfadeMs: number;
  startAt?: number;
}

interface MusicDeck {
  element: MediaElementLike;
  source: AudioNodeLike | null;
  gain: GainNodeLike | null;
  media: MediaItem | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

interface VideoSlot {
  element: MediaElementLike;
  source: AudioNodeLike;
  gain: GainNodeLike;
}

interface Graph {
  ctx: AudioContextLike;
  master: GainNodeLike;
  music: GainNodeLike;
  video: GainNodeLike;
  musicAnalyser: AnalyserNodeLike;
  videoAnalyser: AnalyserNodeLike;
  masterAnalyser: AnalyserNodeLike;
}

export function describeMediaElementError(error: { code: number; message: string } | null): string {
  if (!error) return 'Unknown media error';
  switch (error.code) {
    case 1:
      return 'Playback aborted';
    case 2:
      return 'Network/disk error while reading the file';
    case 3:
      return `Decode error — the codec is not supported${error.message ? ` (${error.message})` : ''}`;
    case 4:
      return `Format not supported${error.message ? ` (${error.message})` : ''}`;
    default:
      return error.message || `Media error ${error.code}`;
  }
}

export class AudioEngine {
  private graph: Graph | null = null;
  private readonly decks: [MusicDeck, MusicDeck];
  private activeDeck: 0 | 1 = 0;
  private readonly videoSlots = new Map<number, VideoSlot>();
  private mix: AudioMix = { ...DEFAULT_MIX };
  private videoPlaying = false;
  private cueDuckEnabled = true;
  private ducked = false;
  private fadeOut: { endsAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly sampleBuffer = new Float32Array(ANALYSER_SIZE);

  constructor(private readonly deps: AudioEngineDeps) {
    this.decks = [this.createDeck(), this.createDeck()];
  }

  private createDeck(): MusicDeck {
    const element = this.deps.createMediaElement();
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';
    const deck: MusicDeck = { element, source: null, gain: null, media: null, cleanupTimer: null };
    element.addEventListener('error', () => {
      if (!deck.media) return;
      const error = element.error;
      this.deps.onMediaError?.(deck.media, describeMediaElementError(error), error ? error.code : null);
    });
    return deck;
  }

  /* ------------------------------ Graph ---------------------------------- */

  private ensureGraph(): Graph {
    if (this.graph) return this.graph;
    const ctx = this.deps.createContext();
    const master = ctx.createGain();
    const music = ctx.createGain();
    const video = ctx.createGain();
    const musicAnalyser = ctx.createAnalyser();
    const videoAnalyser = ctx.createAnalyser();
    const masterAnalyser = ctx.createAnalyser();
    for (const analyser of [musicAnalyser, videoAnalyser, masterAnalyser]) analyser.fftSize = ANALYSER_SIZE;

    music.connect(master);
    video.connect(master);
    master.connect(ctx.destination);
    music.connect(musicAnalyser);
    video.connect(videoAnalyser);
    master.connect(masterAnalyser);

    master.gain.value = computeMasterGain(this.mix);
    music.gain.value = computeMusicTargetGain({
      bgMusicVolume: this.mix.bgMusicVolume,
      isDucked: this.ducked,
      duckAttenuationPercent: this.mix.duckAttenuationPercent
    });
    video.gain.value = this.mix.videoAudioVolume;

    for (const deck of this.decks) {
      const source = ctx.createMediaElementSource(deck.element);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(music);
      deck.source = source;
      deck.gain = gain;
    }

    this.graph = { ctx, master, music, video, musicAnalyser, videoAnalyser, masterAnalyser };
    return this.graph;
  }

  /** Builds the graph eagerly (call once the stage window is mounted). */
  init(): void {
    this.ensureGraph();
    void this.resume();
  }

  async resume(): Promise<void> {
    const graph = this.ensureGraph();
    if (graph.ctx.state === 'suspended') {
      await graph.ctx.resume();
    }
  }

  private scheduleTarget(param: AudioParamLike, target: number, timeConstant: number): void {
    const graph = this.ensureGraph();
    const now = graph.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(target, now, timeConstant);
  }

  private scheduleLinear(param: AudioParamLike, target: number, durationMs: number): void {
    const graph = this.ensureGraph();
    const now = graph.ctx.currentTime;
    param.cancelScheduledValues(now);
    if (durationMs <= 0) {
      param.setValueAtTime(target, now);
      return;
    }
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + durationMs / 1000);
  }

  private currentMusicTarget(): number {
    return computeMusicTargetGain({
      bgMusicVolume: this.mix.bgMusicVolume,
      isDucked: this.ducked,
      duckAttenuationPercent: this.mix.duckAttenuationPercent
    });
  }

  private applyMusicGain(mode: 'duck' | 'release' | 'smooth'): void {
    if (this.fadeOut) return; // the fade-out owns the music bus until it completes
    const graph = this.ensureGraph();
    const timeConstant =
      mode === 'duck'
        ? rampTimeConstant(DUCK_ATTACK_MS)
        : mode === 'release'
          ? rampTimeConstant(DUCK_RELEASE_MS)
          : FADER_SMOOTHING_SECONDS;
    this.scheduleTarget(graph.music.gain, this.currentMusicTarget(), timeConstant);
  }

  /* ------------------------------ Mixer ---------------------------------- */

  getMix(): AudioMix {
    return { ...this.mix };
  }

  setMix(mix: AudioMix): void {
    this.mix = normalizeMix(mix);
    const graph = this.ensureGraph();
    this.scheduleTarget(graph.master.gain, computeMasterGain(this.mix), FADER_SMOOTHING_SECONDS);
    this.scheduleTarget(graph.video.gain, this.mix.videoAudioVolume, FADER_SMOOTHING_SECONDS);
    if (!this.updateDucking()) this.applyMusicGain('smooth');
  }

  /* ----------------------------- Ducking --------------------------------- */

  isDucked(): boolean {
    return this.ducked;
  }

  /**
   * Called by the foreground video player on play / pause / ended.
   * Returns true when the duck state changed.
   */
  setVideoActivity(playing: boolean, cueDuckEnabled: boolean): boolean {
    this.videoPlaying = playing;
    this.cueDuckEnabled = cueDuckEnabled;
    return this.updateDucking();
  }

  private updateDucking(): boolean {
    const want = shouldDuck({
      autoDuckEnabled: this.mix.autoDuckEnabled,
      cueDuckEnabled: this.cueDuckEnabled,
      videoPlaying: this.videoPlaying,
      videoAudioVolume: this.mix.videoAudioVolume
    });
    if (want === this.ducked) return false;
    this.ducked = want;
    this.applyMusicGain(want ? 'duck' : 'release');
    return true;
  }

  /* --------------------------- Video routing ----------------------------- */

  registerVideoElement(slot: number, element: MediaElementLike): void {
    const existing = this.videoSlots.get(slot);
    if (existing && existing.element === element) return;
    const graph = this.ensureGraph();
    if (existing) {
      existing.source.disconnect();
      existing.gain.disconnect();
    }
    const source = graph.ctx.createMediaElementSource(element);
    const gain = graph.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(graph.video);
    this.videoSlots.set(slot, { element, source, gain });
  }

  setVideoSlotGain(slot: number, value: number, rampMs: number): void {
    const entry = this.videoSlots.get(slot);
    if (!entry) return;
    this.scheduleLinear(entry.gain.gain, clamp01(value), rampMs);
  }

  /* --------------------------- Music decks ------------------------------- */

  private clearDeckTimer(deck: MusicDeck): void {
    if (deck.cleanupTimer !== null) {
      clearTimeout(deck.cleanupTimer);
      deck.cleanupTimer = null;
    }
  }

  private unloadDeck(deck: MusicDeck): void {
    this.clearDeckTimer(deck);
    deck.media = null;
    deck.element.pause();
    deck.element.removeAttribute('src');
    deck.element.load();
    if (deck.gain) this.scheduleLinear(deck.gain.gain, 0, 0);
  }

  private playDeck(deck: MusicDeck): void {
    const media = deck.media;
    deck.element.play().catch((error: unknown) => {
      if (deck.media !== media) return;
      const message = error instanceof Error ? error.message : String(error);
      if (/interrupted|aborted/i.test(message)) return;
      this.deps.onMediaError?.(media, `Playback failed: ${message}`, null);
    });
  }

  private cancelFadeOut(restoreGain: boolean): void {
    if (!this.fadeOut) return;
    clearTimeout(this.fadeOut.timer);
    this.fadeOut = null;
    if (restoreGain) this.applyMusicGain('smooth');
  }

  loadMusic(media: MediaItem, options: MusicLoadOptions): void {
    const graph = this.ensureGraph();
    void this.resume();
    this.cancelFadeOut(true);

    const current = this.decks[this.activeDeck];
    const nextIndex: 0 | 1 = this.activeDeck === 0 ? 1 : 0;
    const next = this.decks[nextIndex];
    this.clearDeckTimer(next);

    const fadeSeconds = Math.max(0.02, options.crossfadeMs / 1000);
    const currentAudible = current.media !== null && !current.element.paused;

    next.media = media;
    next.element.loop = options.loop;
    next.element.src = media.fileUrl;
    next.element.load();
    if (options.startAt !== undefined && options.startAt > 0) next.element.currentTime = options.startAt;
    if (options.autoplay) this.playDeck(next);

    const now = graph.ctx.currentTime;
    if (next.gain) {
      next.gain.gain.cancelScheduledValues(now);
      if (options.autoplay) {
        next.gain.gain.setValueCurveAtTime(buildEqualPowerCurve(64, 'in'), now, fadeSeconds);
      } else {
        next.gain.gain.setValueAtTime(1, now);
      }
    }

    if (currentAudible && current.gain) {
      const start = current.gain.gain.value;
      current.gain.gain.cancelScheduledValues(now);
      current.gain.gain.setValueCurveAtTime(buildEqualPowerCurve(64, 'out', start), now, fadeSeconds);
      current.cleanupTimer = setTimeout(() => {
        current.cleanupTimer = null;
        this.unloadDeck(current);
      }, options.crossfadeMs + 80);
    } else if (current.media) {
      this.unloadDeck(current);
    }

    this.activeDeck = nextIndex;
  }

  playMusic(): void {
    const deck = this.decks[this.activeDeck];
    if (!deck.media) return;
    void this.resume();
    this.cancelFadeOut(true);
    if (deck.gain) this.scheduleTarget(deck.gain.gain, 1, FADER_SMOOTHING_SECONDS);
    this.playDeck(deck);
  }

  pauseMusic(): void {
    this.decks[this.activeDeck].element.pause();
  }

  stopMusic(fadeMs: number): void {
    const deck = this.decks[this.activeDeck];
    if (!deck.media) return;
    this.cancelFadeOut(false);
    this.clearDeckTimer(deck);
    if (fadeMs <= 0 || deck.element.paused || !deck.gain) {
      deck.element.pause();
      deck.element.currentTime = 0;
      this.applyMusicGain('smooth');
      return;
    }
    this.scheduleLinear(deck.gain.gain, 0, fadeMs);
    deck.cleanupTimer = setTimeout(() => {
      deck.cleanupTimer = null;
      deck.element.pause();
      deck.element.currentTime = 0;
    }, fadeMs + 30);
  }

  /** F9: smooth fade of the music bus to silence, then pause and restore the bus level. */
  fadeOutMusic(durationMs: number = FADE_OUT_MS): boolean {
    const deck = this.decks[this.activeDeck];
    if (!deck.media || deck.element.paused) return false;
    const graph = this.ensureGraph();
    this.cancelFadeOut(false);
    this.scheduleLinear(graph.music.gain, 0, durationMs);
    const timer = setTimeout(() => {
      this.fadeOut = null;
      deck.element.pause();
      const now = graph.ctx.currentTime;
      graph.music.gain.cancelScheduledValues(now);
      graph.music.gain.setValueAtTime(this.currentMusicTarget(), now);
    }, durationMs + 20);
    this.fadeOut = { endsAt: Date.now() + durationMs, timer };
    return true;
  }

  seekMusic(time: number): void {
    const deck = this.decks[this.activeDeck];
    if (!deck.media) return;
    const duration = finiteOr(deck.element.duration, 0);
    deck.element.currentTime = duration > 0 ? clamp(time, 0, duration) : Math.max(0, time);
  }

  setMusicLoop(loop: boolean): void {
    this.decks[this.activeDeck].element.loop = loop;
  }

  /* --------------------------- Output device ----------------------------- */

  supportsOutputSelection(): boolean {
    return typeof this.ensureGraph().ctx.setSinkId === 'function';
  }

  getSinkId(): string {
    const sink = this.graph?.ctx.sinkId;
    return typeof sink === 'string' ? sink : '';
  }

  /**
   * Sends music and video audio to another device (HDMI, headphone jack, USB
   * interface). Video elements play through this context, so one call moves
   * everything. Throws when the device is unavailable; the caller falls back.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    const ctx = this.ensureGraph().ctx;
    if (typeof ctx.setSinkId !== 'function') {
      throw new Error('This system cannot select an audio output device');
    }
    if (this.getSinkId() === deviceId) return;
    await ctx.setSinkId(deviceId);
  }

  /* ----------------------------- Telemetry ------------------------------- */

  private peak(analyser: AnalyserNodeLike): number {
    analyser.getFloatTimeDomainData(this.sampleBuffer);
    let max = 0;
    for (let i = 0; i < this.sampleBuffer.length; i += 1) {
      const v = Math.abs(this.sampleBuffer[i]);
      if (v > max) max = v;
    }
    return Math.min(1, max);
  }

  getTelemetry(): AudioTelemetry {
    const deck = this.decks[this.activeDeck];
    const graph = this.graph;
    return {
      bgMusicMediaId: deck.media ? deck.media.id : null,
      bgMusicName: deck.media ? deck.media.name : null,
      isBgMusicPlaying: deck.media !== null && !deck.element.paused,
      musicCurrentTime: deck.media ? finiteOr(deck.element.currentTime, 0) : 0,
      musicDuration: deck.media ? finiteOr(deck.element.duration, 0) : 0,
      musicLoop: deck.element.loop,
      isDucked: this.ducked,
      isFadingOut: this.fadeOut !== null,
      fadeEndsAt: this.fadeOut ? this.fadeOut.endsAt : null,
      levels: graph
        ? { music: this.peak(graph.musicAnalyser), video: this.peak(graph.videoAnalyser), master: this.peak(graph.masterAnalyser) }
        : { music: 0, video: 0, master: 0 },
      contextState: graph ? graph.ctx.state : 'uninitialized',
      sinkId: this.getSinkId(),
      sentAt: Date.now()
    };
  }

  dispose(): void {
    this.cancelFadeOut(false);
    for (const deck of this.decks) {
      this.clearDeckTimer(deck);
      deck.element.pause();
      deck.element.removeAttribute('src');
      deck.element.load();
      deck.media = null;
    }
    for (const slot of this.videoSlots.values()) {
      slot.source.disconnect();
      slot.gain.disconnect();
    }
    this.videoSlots.clear();
    if (this.graph) {
      void this.graph.ctx.close();
      this.graph = null;
    }
  }
}
