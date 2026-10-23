import { create } from 'zustand';
import type {
  CueItem,
  DisplayStatus,
  ForegroundEndedPayload,
  FreezeAck,
  MediaErrorPayload,
  MediaItem,
  StageConnectionPayload,
  StageCuePayload,
  StageSyncSnapshot,
  StageTelemetry,
  VideoControl
} from '../types';
import {
  assignMediaToCue,
  buildAdHocPayload,
  buildCuePayload,
  buildPageTurnPayload,
  createCue,
  createInitialProgram,
  detachMediaFromCues,
  duplicateCue as duplicateCueInStack,
  getIndexAfterTake,
  getNextCueIndex,
  INSTANT_BACKDROP_FADE_MS,
  insertCue,
  moveCue as moveCueInStack,
  programReducer,
  removeCue as removeCueFromStack,
  renumberCues,
  sortCues,
  UNFREEZE_FADE_MS,
  type ProgramAction,
  type ProgramState
} from '../services/cueManager';
import {
  followBlock,
  msUntilFire,
  pauseFollow,
  planFollow,
  resumeFollow,
  startFollow,
  type PendingFollow
} from '../services/followEngine';
import { CUE_CAPTION_MS } from '../services/onAir';
import { adjacentPage, pageNumbered } from '../services/paging';
import { updateRenderTarget } from '../services/pdfRenderer';
import { createId } from '../services/utils';
import { useAudioStore } from './useAudioStore';
import { useMediaStore } from './useMediaStore';
import { useOnAirStore } from './useOnAirStore';
import { useShowStore } from './useShowStore';

/* Operator-side program/preview state. The operator is the source of truth;
 * every live action is reduced locally and then sent to the Stage window. */

export const TAKE_GUARD_MS = 300;
export const FREEZE_ACK_TIMEOUT_MS = 750;

export interface StageStoreState {
  cues: CueItem[];
  selectedCueId: string | null;
  program: ProgramState;
  telemetry: StageTelemetry | null;
  lastTelemetryAt: number;
  displayStatus: DisplayStatus | null;
  stageConnected: boolean;
  freezePending: boolean;
  lastFreezeAck: FreezeAck | null;
  lastTakeAt: number;
  /** Master on/off switch for every cue's follow rule (saved with the show). */
  autoFollowEnabled: boolean;
  pendingFollow: PendingFollow | null;

  setAutoFollow: (enabled: boolean, markDirty?: boolean) => void;
  toggleAutoFollow: () => void;
  cancelFollow: () => void;
  setCues: (cues: CueItem[]) => void;
  addCues: (cues: CueItem[], mode: 'append' | 'replace') => void;
  addCue: (input?: Partial<CueItem>) => string;
  updateCue: (id: string, patch: Partial<CueItem>) => void;
  removeCue: (id: string) => void;
  duplicateCue: (id: string) => void;
  moveCue: (id: string, delta: number) => void;
  selectCue: (id: string | null) => void;
  selectNext: () => void;
  selectPrev: () => void;
  addMediaAsCue: (media: MediaItem) => string;
  assignMediaToCue: (cueId: string, media: MediaItem) => void;
  detachMedia: (mediaId: string) => void;

  takeSelected: () => boolean;
  takeCue: (id: string) => boolean;
  takeMedia: (media: MediaItem) => boolean;
  /** Next/previous page of the live PDF booklet or web page (the cue stays live). */
  turnPage: (direction: 1 | -1) => PageTurnResult;
  /** Jumps to a page number of the live PDF booklet. */
  goToPage: (page: number) => PageTurnResult;
  freeze: () => void;
  unfreeze: () => void;
  toggleFreeze: () => void;
  setBlackout: (active: boolean) => void;
  toggleBlackout: () => void;
  instantBackdrop: () => void;
  videoControl: (control: VideoControl) => void;

  handleTelemetry: (telemetry: StageTelemetry) => void;
  handleFreezeAck: (ack: FreezeAck) => void;
  handleForegroundEnded: (payload: ForegroundEndedPayload) => void;
  handleMediaError: (payload: MediaErrorPayload) => void;
  handleStageConnection: (payload: StageConnectionPayload) => void;
  setDisplayStatus: (status: DisplayStatus) => void;
  buildSyncSnapshot: () => StageSyncSnapshot;
  fullSync: () => void;
}

const BLACKOUT_FADE_MS = 400;

export interface PageTurnResult {
  ok: boolean;
  message: string;
  /** The booklet is already on its first/last page (clickers then move on through the cue list). */
  atEnd: boolean;
}

export const useStageStore = create<StageStoreState>((set, get) => {
  let freezeAckTimer: ReturnType<typeof setTimeout> | null = null;

  const dispatch = (action: ProgramAction): ProgramState => {
    const next = programReducer(get().program, action);
    if (next !== get().program) set({ program: next });
    return next;
  };

  const dirty = (): void => useShowStore.getState().markDirty();

  const lookup = (id: string | undefined): MediaItem | null => useMediaStore.getState().getById(id);

  const sendTake = (payload: StageCuePayload): void => {
    dispatch({ type: 'TAKE', payload });
    window.api.send('stage:take-cue', payload);
    set({ lastTakeAt: Date.now() });
    if (get().program.isBlackout) {
      useShowStore
        .getState()
        .pushAlert('info', 'Blackout is active', 'The cue is live underneath the blackout. Press ESC to reveal it.', false);
    }
  };

  const guardTake = (): boolean => Date.now() - get().lastTakeAt >= TAKE_GUARD_MS;

  /** Shows `page` (a page of the live booklet) with a quick dissolve, keeping the cue live. */
  const showPage = (page: MediaItem): PageTurnResult => {
    const { program, telemetry } = get();
    const foregroundTime =
      program.foreground && telemetry?.currentForeground?.id === program.foreground.id ? telemetry.foregroundCurrentTime : null;
    const payload = buildPageTurnPayload(program, page, program.takeId + 1, foregroundTime);
    dispatch({ type: 'TAKE', payload });
    window.api.send('stage:take-cue', payload);
    // The operator is driving the booklet by hand: an automatic follow must not jump away.
    get().cancelFollow();
    const total = page.pdf?.pageCount;
    return { ok: true, message: total ? `Page ${page.pdf?.page} / ${total}` : `Page ${page.pdf?.page ?? ''}`, atEnd: false };
  };

  const liveBackdropItem = (): MediaItem | null => {
    const backdrop = get().program.backdrop;
    return backdrop ? lookup(backdrop.id) : null;
  };

  /* ------------------------------ Auto-follow ---------------------------- */

  let followTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFollowTimer = (): void => {
    if (followTimer !== null) {
      clearTimeout(followTimer);
      followTimer = null;
    }
  };

  /** Re-evaluates the pending follow: pauses, resumes, schedules or fires it. */
  const armFollow = (): void => {
    clearFollowTimer();
    const pending = get().pendingFollow;
    if (!pending) return;
    const now = Date.now();
    const { program, autoFollowEnabled } = get();
    const block = followBlock({ autoFollowEnabled, isFrozen: program.isFrozen, isBlackout: program.isBlackout });
    const adjusted = block !== null ? pauseFollow(pending, now) : resumeFollow(pending, now);
    if (adjusted !== pending) set({ pendingFollow: adjusted });
    const wait = msUntilFire(adjusted, block, now);
    if (wait === null) return;
    followTimer = setTimeout(fireFollow, wait);
  };

  const fireFollow = (): void => {
    followTimer = null;
    const pending = get().pendingFollow;
    if (!pending) return;
    if (pending.takeId !== get().program.takeId) {
      set({ pendingFollow: null });
      return;
    }
    const { program, autoFollowEnabled } = get();
    if (followBlock({ autoFollowEnabled, isFrozen: program.isFrozen, isBlackout: program.isBlackout }) !== null) {
      armFollow();
      return;
    }
    set({ pendingFollow: null, lastTakeAt: 0 });
    if (!get().takeCue(pending.targetCueId)) {
      useShowStore
        .getState()
        .pushAlert('warning', 'Auto-follow stopped', 'The next cue could not be taken. Continue manually with Space.', false);
    }
  };

  const markFollowVideoEnded = (takeId: number): void => {
    const pending = get().pendingFollow;
    if (!pending || pending.mode !== 'on-end' || pending.takeId !== takeId) return;
    set({ pendingFollow: { ...pending, videoEnded: true } });
    armFollow();
  };

  const scheduleFollow = (cue: CueItem | null, payload: StageCuePayload): void => {
    clearFollowTimer();
    const plan = cue ? planFollow(get().cues, cue, payload) : null;
    set({ pendingFollow: plan ? startFollow(plan, Date.now()) : null });
    armFollow();
  };

  return {
    cues: [],
    selectedCueId: null,
    program: createInitialProgram(),
    telemetry: null,
    lastTelemetryAt: 0,
    displayStatus: null,
    stageConnected: false,
    freezePending: false,
    lastFreezeAck: null,
    lastTakeAt: 0,
    autoFollowEnabled: true,
    pendingFollow: null,

    setAutoFollow: (enabled, markDirty = true) => {
      if (get().autoFollowEnabled === enabled) return;
      set({ autoFollowEnabled: enabled });
      if (markDirty) dirty();
      armFollow();
    },

    toggleAutoFollow: () => get().setAutoFollow(!get().autoFollowEnabled),

    cancelFollow: () => {
      clearFollowTimer();
      set({ pendingFollow: null });
    },

    /* ---------------------------- Cue stack ------------------------------ */

    setCues: (cues) => {
      const ordered = sortCues(cues);
      set({ cues: ordered, selectedCueId: ordered[0]?.id ?? null });
    },

    addCues: (newCues, mode) => {
      if (newCues.length === 0) return;
      const base = mode === 'replace' ? [] : sortCues(get().cues);
      const combined = renumberCues([...base, ...newCues.map((c, i) => ({ ...c, order: base.length + i + 1 }))]);
      set({ cues: combined, selectedCueId: newCues[0].id });
      dirty();
    },

    addCue: (input = {}) => {
      const id = createId('cue');
      const { cues, selectedCueId } = get();
      const cue = createCue({ ...input, id }, cues.length + 1);
      const next = insertCue(cues, cue, selectedCueId);
      const placed = next.find((c) => c.id === id);
      const labelled =
        placed && !input.label ? next.map((c) => (c.id === id ? { ...c, label: `Cue ${c.order}` } : c)) : next;
      set({ cues: labelled, selectedCueId: id });
      dirty();
      return id;
    },

    updateCue: (id, patch) => {
      set((state) => ({
        cues: state.cues.map((c) => (c.id === id ? { ...c, ...patch, id: c.id, order: c.order } : c))
      }));
      dirty();
    },

    removeCue: (id) => {
      const { cues, selectedCueId } = get();
      const ordered = sortCues(cues);
      const index = ordered.findIndex((c) => c.id === id);
      const next = removeCueFromStack(cues, id);
      let selection = selectedCueId;
      if (selectedCueId === id) {
        selection = next.length === 0 ? null : next[Math.min(Math.max(index, 0), next.length - 1)].id;
      }
      set({ cues: next, selectedCueId: selection });
      dirty();
    },

    duplicateCue: (id) => {
      const newId = createId('cue');
      set((state) => ({ cues: duplicateCueInStack(state.cues, id, newId), selectedCueId: newId }));
      dirty();
    },

    moveCue: (id, delta) => {
      set((state) => ({ cues: moveCueInStack(state.cues, id, delta) }));
      dirty();
    },

    selectCue: (id) => set({ selectedCueId: id }),

    selectNext: () => {
      const ordered = sortCues(get().cues);
      const index = ordered.findIndex((c) => c.id === get().selectedCueId);
      const next = getNextCueIndex(ordered.length, index, 1);
      if (next >= 0) set({ selectedCueId: ordered[next].id });
    },

    selectPrev: () => {
      const ordered = sortCues(get().cues);
      const index = ordered.findIndex((c) => c.id === get().selectedCueId);
      const next = getNextCueIndex(ordered.length, index, -1);
      if (next >= 0) set({ selectedCueId: ordered[next].id });
    },

    addMediaAsCue: (media) => {
      useMediaStore.getState().clearNew(media.id);
      const base = createCue({ id: 'draft' }, 1);
      const withMedia = assignMediaToCue(base, media);
      const isFile = media.type !== 'web' && media.type !== 'screen';
      return get().addCue({
        label: isFile ? media.name.replace(/\.[^.]+$/, '') : media.name,
        backdropMediaId: withMedia.backdropMediaId,
        foregroundMediaId: withMedia.foregroundMediaId,
        audioMediaId: withMedia.audioMediaId,
        transition: 'dissolve'
      });
    },

    assignMediaToCue: (cueId, media) => {
      useMediaStore.getState().clearNew(media.id);
      set((state) => ({ cues: state.cues.map((c) => (c.id === cueId ? assignMediaToCue(c, media) : c)) }));
      dirty();
    },

    detachMedia: (mediaId) => {
      set((state) => ({ cues: detachMediaFromCues(state.cues, mediaId) }));
    },

    /* ------------------------------ Live --------------------------------- */

    takeSelected: () => {
      const { selectedCueId } = get();
      if (!selectedCueId) return false;
      return get().takeCue(selectedCueId);
    },

    takeCue: (id) => {
      if (!guardTake()) return false;
      const cue = get().cues.find((c) => c.id === id);
      if (!cue) return false;
      const show = useShowStore.getState();

      const missing: string[] = [];
      for (const refId of [cue.backdropMediaId, cue.foregroundMediaId, cue.audioMediaId]) {
        const media = lookup(refId);
        if (refId && (!media || media.missing)) missing.push(media ? media.name : 'deleted media');
      }
      if (missing.length > 0) {
        show.pushAlert('warning', `Cue "${cue.label}" has missing media`, `Taken without: ${missing.join(', ')}.`, false);
      }

      const takeId = get().program.takeId + 1;
      const payload = buildCuePayload(cue, lookup, get().program, takeId);
      sendTake(payload);
      scheduleFollow(cue, payload);
      // A cue's name caption slides in with it; a caption from the previous cue goes away.
      const onAir = useOnAirStore.getState();
      if (cue.caption?.title) {
        onAir.showCaption({ id: `cue:${cue.id}:${takeId}`, ...cue.caption }, { autoHideMs: CUE_CAPTION_MS, fromCue: true });
      } else if (onAir.liveCaption?.fromCue) {
        onAir.hideCaption();
      }
      for (const refId of [cue.backdropMediaId, cue.foregroundMediaId, cue.audioMediaId]) {
        if (refId) useMediaStore.getState().clearNew(refId);
      }

      const audio = lookup(cue.audioMediaId);
      if (audio && audio.type === 'audio' && !audio.missing) {
        useAudioStore.getState().cueMusic(audio, {
          loop: cue.loopAudio,
          volume: cue.audioVolume,
          crossfadeMs: Math.max(cue.transitionDurationMs, 1500)
        });
      }

      const ordered = sortCues(get().cues);
      const nextIndex = getIndexAfterTake(ordered, cue.id);
      set({ selectedCueId: nextIndex >= 0 ? ordered[nextIndex].id : cue.id });
      return true;
    },

    takeMedia: (media) => {
      if (!guardTake() || media.missing) return false;
      useMediaStore.getState().clearNew(media.id);
      if (media.type === 'audio') {
        useAudioStore.getState().loadMusic(media, {
          loop: true,
          volume: useAudioStore.getState().bgMusicVolume,
          crossfadeMs: 1500,
          autoplay: true
        });
        set({ lastTakeAt: Date.now() });
        return true;
      }
      const takeId = get().program.takeId + 1;
      const payload = buildAdHocPayload(media, get().program, takeId);
      sendTake(payload);
      scheduleFollow(null, payload);
      return true;
    },

    turnPage: (direction) => {
      const current = liveBackdropItem();
      if (!current) return { ok: false, message: 'Nothing with pages is live', atEnd: false };
      if (current.type === 'web') {
        window.api.send('web:input', { type: 'key', key: direction === 1 ? 'ArrowRight' : 'ArrowLeft' });
        return { ok: true, message: direction === 1 ? 'Next page' : 'Previous page', atEnd: false };
      }
      if (!current.pdf) return { ok: false, message: 'Nothing with pages is live', atEnd: false };
      const target = adjacentPage(useMediaStore.getState().items, current, direction, window.api.platform);
      if (!target) {
        return { ok: false, message: direction === 1 ? 'Already on the last page' : 'Already on the first page', atEnd: true };
      }
      return showPage(target);
    },

    goToPage: (page) => {
      const current = liveBackdropItem();
      if (!current?.pdf) return { ok: false, message: 'No PDF is live', atEnd: false };
      const target = pageNumbered(useMediaStore.getState().items, current, page, window.api.platform);
      if (!target || target.id === current.id) return { ok: false, message: `Already on page ${current.pdf.page}`, atEnd: false };
      return showPage(target);
    },

    freeze: () => {
      if (get().program.isFrozen) return;
      const requestedAt = Date.now();
      window.api.send('stage:action-freeze', { requestedAt });
      dispatch({ type: 'FREEZE', foregroundTime: get().telemetry?.foregroundCurrentTime ?? 0, at: requestedAt });
      set({ freezePending: true });
      armFollow();
      if (freezeAckTimer !== null) clearTimeout(freezeAckTimer);
      freezeAckTimer = setTimeout(() => {
        freezeAckTimer = null;
        if (get().freezePending && get().program.isFrozen) {
          set({ freezePending: false });
          useShowStore
            .getState()
            .pushAlert('error', 'Freeze not confirmed', 'The stage window did not acknowledge the freeze. Check the projector output.');
        }
      }, FREEZE_ACK_TIMEOUT_MS);
    },

    unfreeze: () => {
      if (!get().program.isFrozen) return;
      window.api.send('stage:action-unfreeze', { requestedAt: Date.now(), fadeMs: UNFREEZE_FADE_MS });
      dispatch({ type: 'UNFREEZE' });
      set({ freezePending: false });
      armFollow();
    },

    toggleFreeze: () => {
      if (get().program.isFrozen) get().unfreeze();
      else get().freeze();
    },

    setBlackout: (active) => {
      window.api.send('stage:action-blackout', { active, fadeMs: active ? 0 : BLACKOUT_FADE_MS });
      dispatch({ type: 'SET_BLACKOUT', active });
      armFollow();
    },

    toggleBlackout: () => get().setBlackout(!get().program.isBlackout),

    instantBackdrop: () => {
      window.api.send('stage:action-clear-foreground', { fadeMs: INSTANT_BACKDROP_FADE_MS });
      dispatch({ type: 'CLEAR_FOREGROUND' });
      // The operator intervened: an automatic follow must not fire afterwards.
      get().cancelFollow();
    },

    videoControl: (control) => {
      if (!get().program.foreground) return;
      window.api.send('stage:video-control', control);
    },

    /* --------------------------- Stage feedback --------------------------- */

    handleTelemetry: (telemetry) => set({ telemetry, lastTelemetryAt: Date.now() }),

    handleFreezeAck: (ack) => {
      if (freezeAckTimer !== null && ack.isFrozen) {
        clearTimeout(freezeAckTimer);
        freezeAckTimer = null;
      }
      set({ lastFreezeAck: ack, freezePending: false });
    },

    handleForegroundEnded: (payload) => {
      dispatch({ type: 'FOREGROUND_ENDED', mediaId: payload.mediaId, takeId: payload.takeId });
      markFollowVideoEnded(payload.takeId);
    },

    handleMediaError: (payload) => {
      const where =
        payload.layer === 'foreground'
          ? 'The backdrop stays on screen.'
          : payload.layer === 'backdrop'
            ? 'The previous backdrop stays on screen.'
            : payload.layer === 'music'
              ? 'Background music stopped.'
              : 'The stage output recovered to black.';
      useShowStore
        .getState()
        .pushAlert('error', `Cannot play "${payload.mediaName}"`, `${payload.message}. ${where}`);
      if (payload.layer === 'foreground' && payload.mediaId && payload.takeId !== null) {
        dispatch({ type: 'FOREGROUND_ENDED', mediaId: payload.mediaId, takeId: payload.takeId });
        // A video that cannot play counts as finished so an automatic sequence keeps going.
        markFollowVideoEnded(payload.takeId);
      }
    },

    handleStageConnection: (payload) => {
      const wasConnected = get().stageConnected;
      set({ stageConnected: payload.connected });
      const show = useShowStore.getState();
      switch (payload.reason) {
        case 'ready':
          if (get().lastTelemetryAt > 0 || wasConnected) {
            show.pushAlert('info', 'Stage output restarted', 'The projector window was restored and re-synced.', false);
          }
          get().fullSync();
          break;
        case 'crashed':
          show.pushAlert('error', 'Stage output crashed', 'Restarting the projector window and restoring the current cue…');
          break;
        case 'unresponsive':
          show.pushAlert('warning', 'Stage output not responding', 'The projector window is busy. Waiting for it to recover…');
          break;
        case 'responsive':
          show.pushAlert('success', 'Stage output responsive again', 'Projector window recovered.', false);
          break;
        case 'closed':
          show.pushAlert('error', 'Stage output closed', 'The projector window was closed.');
          break;
        default: {
          const exhaustive: never = payload.reason;
          return exhaustive;
        }
      }
    },

    setDisplayStatus: (status) => {
      const previous = get().displayStatus;
      set({ displayStatus: status });
      updateRenderTarget(status);
      if (!previous) return;
      const show = useShowStore.getState();
      if (previous.mode === 'projector' && status.mode !== 'projector') {
        show.pushAlert(
          'error',
          'Projector disconnected',
          'HDMI output lost. The stage keeps playing in a floating window on this screen. Reconnect the cable to restore it.'
        );
      } else if (previous.mode !== 'projector' && status.mode === 'projector') {
        const display = status.displays.find((d) => d.id === status.stageDisplayId);
        show.pushAlert(
          'success',
          'Projector connected',
          `Stage output is now fullscreen on ${display ? display.name : 'the external display'}.`,
          false
        );
      }
    },

    buildSyncSnapshot: () => {
      const { program, telemetry } = get();
      const audio = useAudioStore.getState();
      const hasContent = program.backdrop !== null || program.foreground !== null;
      const cue: StageCuePayload | null = hasContent
        ? {
            takeId: program.takeId,
            cueId: program.liveCueId,
            label: program.liveCueLabel,
            backdrop: program.backdrop,
            foreground: program.foreground,
            transition: 'cut',
            transitionDurationMs: 0,
            autoPlayForeground: telemetry ? telemetry.isForegroundPlaying : program.autoPlayForeground,
            loopBackdrop: program.loopBackdrop,
            duckAudioOnVideo: program.duckAudioOnVideo,
            foregroundStartAt:
              telemetry && program.foreground && telemetry.currentForeground?.id === program.foreground.id
                ? telemetry.foregroundCurrentTime
                : undefined
          }
        : null;
      const music = audio.bgMusicMedia
        ? {
            media: audio.bgMusicMedia,
            loop: audio.musicLoop,
            playing: audio.telemetry ? audio.telemetry.isBgMusicPlaying : audio.isBgMusicPlaying,
            currentTime: audio.telemetry ? audio.telemetry.musicCurrentTime : 0
          }
        : null;
      return {
        cue,
        isBlackout: program.isBlackout,
        mix: audio.getMix(),
        music,
        outputDeviceId: audio.resolvedOutputDeviceId(),
        overlays: useOnAirStore.getState().overlays()
      };
    },

    fullSync: () => {
      if (get().program.isFrozen) {
        dispatch({ type: 'UNFREEZE' });
        set({ freezePending: false });
      }
      window.api.send('stage:full-sync', get().buildSyncSnapshot());
    }
  };
});
