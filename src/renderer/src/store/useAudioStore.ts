import { create } from 'zustand';
import type {
  AudioCommand,
  AudioDevicesPayload,
  AudioMix,
  AudioOutputDevice,
  AudioOutputPref,
  AudioState,
  AudioTelemetry,
  MediaItem
} from '../types';
import { DEFAULT_MIX, FADE_OUT_MS, normalizeMix } from '../services/audioEngine';
import { clamp, clamp01, toStageMedia } from '../services/utils';
import { useShowStore } from './useShowStore';

/* Operator-side audio mixer state. The Web Audio graph itself lives in the
 * Stage window; every change here is mirrored there via `audio:command`. */

export interface CueMusicOptions {
  loop: boolean;
  volume: number;
  crossfadeMs: number;
}

export interface AudioStoreState extends AudioState {
  musicLoop: boolean;
  telemetry: AudioTelemetry | null;
  outputDevices: AudioOutputDevice[];
  outputSupported: boolean;
  /** The device the operator chose for this show (null = system default). */
  outputPref: AudioOutputPref | null;
  currentSinkId: string;
  outputMissing: boolean;
  outputError: string | null;
  setOutputDevice: (deviceId: string) => void;
  applyOutputPref: (pref: AudioOutputPref | null) => void;
  resolvedOutputDeviceId: () => string;
  handleDevices: (payload: AudioDevicesPayload) => void;
  getMix: () => AudioMix;
  applyMix: (mix: AudioMix, markDirty?: boolean) => void;
  setBgMusicVolume: (value: number) => void;
  setVideoAudioVolume: (value: number) => void;
  setMasterVolume: (value: number) => void;
  toggleMute: () => void;
  setAutoDuck: (enabled: boolean) => void;
  setDuckAttenuation: (percent: number) => void;
  loadMusic: (media: MediaItem, options: CueMusicOptions & { autoplay: boolean }) => void;
  cueMusic: (media: MediaItem, options: CueMusicOptions) => void;
  playMusic: () => void;
  pauseMusic: () => void;
  stopMusic: () => void;
  fadeOutMusic: (durationMs?: number) => void;
  seekMusic: (time: number) => void;
  setMusicLoop: (loop: boolean) => void;
  handleTelemetry: (telemetry: AudioTelemetry) => void;
}

function sendAudio(command: AudioCommand): void {
  window.api.send('audio:command', command);
}

function mixOf(state: AudioState): AudioMix {
  return {
    bgMusicVolume: state.bgMusicVolume,
    videoAudioVolume: state.videoAudioVolume,
    masterVolume: state.masterVolume,
    isMuted: state.isMuted,
    autoDuckEnabled: state.autoDuckEnabled,
    duckAttenuationPercent: state.duckAttenuationPercent
  };
}

/** Finds the preferred device by id, falling back to its name (ids change between laptops). */
export function matchOutputDevice(devices: readonly AudioOutputDevice[], pref: AudioOutputPref | null): AudioOutputDevice | null {
  if (!pref) return null;
  return devices.find((d) => d.deviceId === pref.deviceId) ?? devices.find((d) => d.label === pref.label) ?? null;
}

export const useAudioStore = create<AudioStoreState>((set, get) => {
  /** A device that refused setSinkId is not retried until the device list changes. */
  let failedDeviceId: string | null = null;
  let lastDeviceSignature = '';
  let lastReportedError: string | null = null;
  let reportedMissingLabel: string | null = null;

  const updateMix = (patch: Partial<AudioMix>, markDirty = true): void => {
    const next = normalizeMix({ ...mixOf(get()), ...patch });
    set(next);
    sendAudio({ type: 'set-mix', mix: next });
    if (markDirty) useShowStore.getState().markDirty();
  };

  return {
    bgMusicMedia: null,
    isBgMusicPlaying: false,
    ...DEFAULT_MIX,
    isDucked: false,
    musicLoop: true,
    telemetry: null,
    outputDevices: [],
    outputSupported: true,
    outputPref: null,
    currentSinkId: '',
    outputMissing: false,
    outputError: null,

    setOutputDevice: (deviceId) => {
      const device = get().outputDevices.find((d) => d.deviceId === deviceId);
      const pref: AudioOutputPref | null = deviceId && device ? { deviceId, label: device.label } : null;
      failedDeviceId = null;
      reportedMissingLabel = null;
      set({ outputPref: pref, outputMissing: false, outputError: null });
      sendAudio({ type: 'set-output', deviceId: pref ? pref.deviceId : '' });
      useShowStore.getState().markDirty();
    },

    applyOutputPref: (pref) => {
      failedDeviceId = null;
      reportedMissingLabel = null;
      set({ outputPref: pref ? { ...pref } : null });
      const match = matchOutputDevice(get().outputDevices, pref);
      set({ outputMissing: pref !== null && match === null && get().outputDevices.length > 0 });
      sendAudio({ type: 'set-output', deviceId: match ? match.deviceId : '' });
    },

    resolvedOutputDeviceId: () => {
      const match = matchOutputDevice(get().outputDevices, get().outputPref);
      return match ? match.deviceId : '';
    },

    handleDevices: (payload) => {
      const signature = payload.devices.map((d) => d.deviceId).join('|');
      if (signature !== lastDeviceSignature) {
        lastDeviceSignature = signature;
        failedDeviceId = null;
      }
      const show = useShowStore.getState();
      const pref = get().outputPref;
      const match = matchOutputDevice(payload.devices, pref);

      if (payload.error && payload.error !== lastReportedError) {
        show.pushAlert('warning', 'Audio output problem', payload.error);
        if (pref && payload.currentSinkId !== pref.deviceId) failedDeviceId = match ? match.deviceId : pref.deviceId;
      }
      lastReportedError = payload.error;

      let outputMissing = false;
      if (pref && !match) {
        outputMissing = true;
        if (reportedMissingLabel !== pref.label) {
          reportedMissingLabel = pref.label;
          show.pushAlert(
            'error',
            `Audio device “${pref.label}” not found`,
            'Sound is playing on the system default output. Reconnect the device and it will switch back automatically.'
          );
        }
        if (payload.currentSinkId !== '') sendAudio({ type: 'set-output', deviceId: '' });
      } else if (pref && match) {
        if (reportedMissingLabel !== null) {
          show.pushAlert('success', 'Audio device reconnected', `Sound is back on “${match.label}”.`, false);
          reportedMissingLabel = null;
        }
        if (match.deviceId !== payload.currentSinkId && match.deviceId !== failedDeviceId) {
          sendAudio({ type: 'set-output', deviceId: match.deviceId });
        }
      }

      set({
        outputDevices: payload.devices,
        outputSupported: payload.supported,
        currentSinkId: payload.currentSinkId,
        outputMissing,
        outputError: payload.error,
        outputPref: pref && match && match.deviceId !== pref.deviceId ? { deviceId: match.deviceId, label: match.label } : pref
      });
    },

    getMix: () => mixOf(get()),

    applyMix: (mix, markDirty = false) => updateMix(mix, markDirty),

    setBgMusicVolume: (value) => updateMix({ bgMusicVolume: clamp01(value) }),
    setVideoAudioVolume: (value) => updateMix({ videoAudioVolume: clamp01(value) }),
    setMasterVolume: (value) => updateMix({ masterVolume: clamp01(value) }),
    toggleMute: () => updateMix({ isMuted: !get().isMuted }, false),
    setAutoDuck: (enabled) => updateMix({ autoDuckEnabled: enabled }),
    setDuckAttenuation: (percent) => updateMix({ duckAttenuationPercent: clamp(percent, 0, 100) }),

    loadMusic: (media, options) => {
      if (media.type !== 'audio' || media.missing) return;
      const volume = clamp01(options.volume);
      set({ bgMusicMedia: media, isBgMusicPlaying: options.autoplay, musicLoop: options.loop });
      if (Math.abs(volume - get().bgMusicVolume) > 0.0005) updateMix({ bgMusicVolume: volume }, false);
      sendAudio({
        type: 'music-load',
        media: toStageMedia(media),
        loop: options.loop,
        autoplay: options.autoplay,
        crossfadeMs: Math.max(0, options.crossfadeMs)
      });
    },

    cueMusic: (media, options) => {
      const state = get();
      const telemetry = state.telemetry;
      const alreadyPlaying =
        state.bgMusicMedia?.id === media.id && (telemetry ? telemetry.isBgMusicPlaying : state.isBgMusicPlaying);
      if (alreadyPlaying) {
        // Same track already running: only follow the cue's level and loop setting.
        if (Math.abs(clamp01(options.volume) - state.bgMusicVolume) > 0.0005) {
          updateMix({ bgMusicVolume: clamp01(options.volume) }, false);
        }
        if (state.musicLoop !== options.loop) get().setMusicLoop(options.loop);
        return;
      }
      get().loadMusic(media, { ...options, autoplay: true });
    },

    playMusic: () => {
      if (!get().bgMusicMedia) return;
      set({ isBgMusicPlaying: true });
      sendAudio({ type: 'music-play' });
    },

    pauseMusic: () => {
      set({ isBgMusicPlaying: false });
      sendAudio({ type: 'music-pause' });
    },

    stopMusic: () => {
      set({ isBgMusicPlaying: false });
      sendAudio({ type: 'music-stop', fadeMs: 400 });
    },

    fadeOutMusic: (durationMs = FADE_OUT_MS) => {
      if (!get().bgMusicMedia) return;
      sendAudio({ type: 'music-fade-out', durationMs });
    },

    seekMusic: (time) => {
      sendAudio({ type: 'music-seek', time: Math.max(0, time) });
    },

    setMusicLoop: (loop) => {
      set({ musicLoop: loop });
      sendAudio({ type: 'music-set-loop', loop });
    },

    handleTelemetry: (telemetry) => {
      const state = get();
      const patch: Partial<AudioStoreState> = { telemetry, isDucked: telemetry.isDucked };
      if (telemetry.isBgMusicPlaying !== state.isBgMusicPlaying) patch.isBgMusicPlaying = telemetry.isBgMusicPlaying;
      if (telemetry.bgMusicMediaId === null && state.bgMusicMedia !== null && !telemetry.isBgMusicPlaying) {
        // Stage has no track loaded (e.g. stage window was restarted before a re-sync).
        patch.isBgMusicPlaying = false;
      }
      set(patch);
    }
  };
});
