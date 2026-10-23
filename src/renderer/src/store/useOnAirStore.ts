import { create } from 'zustand';
import type { CaptionItem, CaptionStyle, OnAirSettings, OverlayClock, RemoteTimer, StageOverlays } from '../types';
import {
  addTime,
  clockRemaining,
  DEFAULT_ON_AIR,
  isRunning,
  newClock,
  pauseClock,
  startClock
} from '../services/onAir';
import { createId } from '../services/utils';
import { useShowStore } from './useShowStore';

/* On air: name captions, the projector countdown and the speaker timer.
 * The operator window is the source of truth; the bridge mirrors the result
 * to the stage (overlays) and to the phones (podium timer). */

const MINUTE = 60_000;

export interface SpeakerTimer {
  clock: OverlayClock;
  durationMs: number;
  speaker: string;
  warnMs: number;
  /** Big signal for the speaker on the podium screen. */
  message: string | null;
  /** Also show a small timer in a corner of the projector. */
  onProjector: boolean;
  /** Set up (shown on the podium screen). */
  active: boolean;
}

export interface ProjectorCountdown {
  clock: OverlayClock;
  durationMs: number;
  message: string;
  visible: boolean;
  hideAtZero: boolean;
}

export interface LiveCaption extends CaptionItem {
  /** Shown automatically by a cue (hidden again when another cue is taken). */
  fromCue: boolean;
}

export interface OnAirState {
  captions: CaptionItem[];
  captionStyle: CaptionStyle;
  liveCaption: LiveCaption | null;
  timer: SpeakerTimer;
  countdown: ProjectorCountdown;

  loadSettings: (settings: OnAirSettings) => void;
  settings: () => OnAirSettings;

  addCaption: (title: string, subtitle: string) => void;
  updateCaption: (id: string, patch: Partial<Omit<CaptionItem, 'id'>>) => void;
  removeCaption: (id: string) => void;
  setCaptionStyle: (style: CaptionStyle) => void;
  showCaption: (caption: CaptionItem, options?: { autoHideMs?: number; fromCue?: boolean }) => void;
  hideCaption: () => void;

  setTimerMinutes: (minutes: number) => void;
  setTimerWarnSeconds: (seconds: number) => void;
  setSpeaker: (name: string) => void;
  startTimer: () => void;
  pauseTimer: () => void;
  resetTimer: () => void;
  addTimerTime: (ms: number) => void;
  setTimerMessage: (message: string | null) => void;
  setTimerOnProjector: (on: boolean) => void;
  clearTimer: () => void;

  setCountdownMinutes: (minutes: number) => void;
  setCountdownMessage: (message: string) => void;
  setCountdownHideAtZero: (hide: boolean) => void;
  startCountdown: () => void;
  pauseCountdown: () => void;
  hideCountdown: () => void;

  overlays: () => StageOverlays;
  remoteTimer: (now: number) => RemoteTimer | null;
}

const initialTimer = (): SpeakerTimer => ({
  clock: newClock(DEFAULT_ON_AIR.timerMinutes * MINUTE),
  durationMs: DEFAULT_ON_AIR.timerMinutes * MINUTE,
  speaker: '',
  warnMs: DEFAULT_ON_AIR.timerWarnSeconds * 1000,
  message: null,
  onProjector: false,
  active: false
});

const initialCountdown = (): ProjectorCountdown => ({
  clock: newClock(DEFAULT_ON_AIR.countdownMinutes * MINUTE),
  durationMs: DEFAULT_ON_AIR.countdownMinutes * MINUTE,
  message: DEFAULT_ON_AIR.countdownMessage,
  visible: false,
  hideAtZero: true
});

export const useOnAirStore = create<OnAirState>((set, get) => {
  let captionTimer: ReturnType<typeof setTimeout> | null = null;
  const clearCaptionTimer = (): void => {
    if (captionTimer !== null) {
      clearTimeout(captionTimer);
      captionTimer = null;
    }
  };
  const dirty = (): void => useShowStore.getState().markDirty();
  const patchTimer = (patch: Partial<SpeakerTimer>): void => set((state) => ({ timer: { ...state.timer, ...patch } }));
  const patchCountdown = (patch: Partial<ProjectorCountdown>): void =>
    set((state) => ({ countdown: { ...state.countdown, ...patch } }));

  return {
    captions: [],
    captionStyle: DEFAULT_ON_AIR.captionStyle,
    liveCaption: null,
    timer: initialTimer(),
    countdown: initialCountdown(),

    loadSettings: (settings) => {
      clearCaptionTimer();
      const timerMs = settings.timerMinutes * MINUTE;
      const countdownMs = settings.countdownMinutes * MINUTE;
      set({
        captions: settings.captions.map((c) => ({ ...c })),
        captionStyle: settings.captionStyle,
        liveCaption: null,
        timer: { ...initialTimer(), clock: newClock(timerMs), durationMs: timerMs, warnMs: settings.timerWarnSeconds * 1000 },
        countdown: { ...initialCountdown(), clock: newClock(countdownMs), durationMs: countdownMs, message: settings.countdownMessage }
      });
    },

    settings: () => {
      const { captions, captionStyle, timer, countdown } = get();
      return {
        captions: captions.map((c) => ({ ...c })),
        captionStyle,
        timerMinutes: timer.durationMs / MINUTE,
        timerWarnSeconds: timer.warnMs / 1000,
        countdownMinutes: countdown.durationMs / MINUTE,
        countdownMessage: countdown.message
      };
    },

    /* ------------------------------ Captions ------------------------------ */

    addCaption: (title, subtitle) => {
      const t = title.trim().slice(0, 80);
      if (!t) return;
      set((state) => ({ captions: [...state.captions, { id: createId('caption'), title: t, subtitle: subtitle.trim().slice(0, 120) }] }));
      dirty();
    },

    updateCaption: (id, patch) => {
      set((state) => ({
        captions: state.captions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        liveCaption: state.liveCaption?.id === id ? { ...state.liveCaption, ...patch } : state.liveCaption
      }));
      dirty();
    },

    removeCaption: (id) => {
      if (get().liveCaption?.id === id) get().hideCaption();
      set((state) => ({ captions: state.captions.filter((c) => c.id !== id) }));
      dirty();
    },

    setCaptionStyle: (style) => {
      set({ captionStyle: style });
      dirty();
    },

    showCaption: (caption, options = {}) => {
      clearCaptionTimer();
      set({ liveCaption: { ...caption, fromCue: options.fromCue ?? false } });
      if (options.autoHideMs && options.autoHideMs > 0) {
        const id = caption.id;
        captionTimer = setTimeout(() => {
          captionTimer = null;
          if (get().liveCaption?.id === id) set({ liveCaption: null });
        }, options.autoHideMs);
      }
    },

    hideCaption: () => {
      clearCaptionTimer();
      set({ liveCaption: null });
    },

    /* ---------------------------- Speaker timer --------------------------- */

    setTimerMinutes: (minutes) => {
      const durationMs = Math.round(Math.min(600, Math.max(0.5, minutes)) * MINUTE);
      const { timer } = get();
      // Changing the length of a timer that has not started resets it to the new length.
      const untouched = !isRunning(timer.clock) && timer.clock.remainingMs === timer.durationMs;
      patchTimer({ durationMs, clock: untouched ? newClock(durationMs) : timer.clock });
      dirty();
    },

    setTimerWarnSeconds: (seconds) => {
      patchTimer({ warnMs: Math.round(Math.min(3600, Math.max(0, seconds)) * 1000) });
      dirty();
    },

    setSpeaker: (name) => patchTimer({ speaker: name.slice(0, 60) }),

    startTimer: () => patchTimer({ clock: startClock(get().timer.clock, Date.now()), active: true }),

    pauseTimer: () => patchTimer({ clock: pauseClock(get().timer.clock, Date.now()) }),

    resetTimer: () => patchTimer({ clock: newClock(get().timer.durationMs), message: null }),

    addTimerTime: (ms) => patchTimer({ clock: addTime(get().timer.clock, ms) }),

    setTimerMessage: (message) => patchTimer({ message, active: true }),

    setTimerOnProjector: (on) => patchTimer({ onProjector: on }),

    clearTimer: () => patchTimer({ clock: newClock(get().timer.durationMs), message: null, active: false, onProjector: false }),

    /* ------------------------- Projector countdown ------------------------ */

    setCountdownMinutes: (minutes) => {
      const durationMs = Math.round(Math.min(600, Math.max(0.5, minutes)) * MINUTE);
      const { countdown } = get();
      patchCountdown({ durationMs, clock: isRunning(countdown.clock) ? countdown.clock : newClock(durationMs) });
      dirty();
    },

    setCountdownMessage: (message) => {
      patchCountdown({ message: message.slice(0, 80) });
      dirty();
    },

    setCountdownHideAtZero: (hide) => patchCountdown({ hideAtZero: hide }),

    startCountdown: () => {
      const { countdown } = get();
      const now = Date.now();
      // Starting again after it finished begins a fresh countdown.
      const base = clockRemaining(countdown.clock, now) <= 0 ? newClock(countdown.durationMs) : countdown.clock;
      patchCountdown({ clock: startClock(base, now), visible: true });
    },

    pauseCountdown: () => patchCountdown({ clock: pauseClock(get().countdown.clock, Date.now()) }),

    hideCountdown: () => patchCountdown({ visible: false, clock: newClock(get().countdown.durationMs) }),

    /* ------------------------------- Output ------------------------------- */

    overlays: () => {
      const { liveCaption, captionStyle, countdown, timer } = get();
      return {
        caption: liveCaption ? { id: liveCaption.id, title: liveCaption.title, subtitle: liveCaption.subtitle, style: captionStyle } : null,
        countdown: countdown.visible
          ? { ...countdown.clock, message: countdown.message, hideAtZero: countdown.hideAtZero }
          : null,
        speakerTimer: timer.active && timer.onProjector ? { ...timer.clock, warnMs: timer.warnMs } : null
      };
    },

    remoteTimer: (now) => {
      const { timer } = get();
      if (!timer.active) return null;
      return {
        running: isRunning(timer.clock),
        remainingMs: Math.round(clockRemaining(timer.clock, now)),
        durationMs: timer.durationMs,
        warnMs: timer.warnMs,
        speaker: timer.speaker,
        message: timer.message
      };
    }
  };
});
