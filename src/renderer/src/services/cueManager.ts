import type { CueItem, MediaItem, StageCuePayload, TransitionType } from '../types';
import { clamp, toStageMedia } from './utils';

/* =========================================================================
 * Pure cue-stack & program-state logic. No DOM, no IPC — fully unit tested.
 *
 * Tracking rules for a TAKE:
 *  - backdrop:   cue value replaces the current backdrop; unset → keep current.
 *  - foreground: cue value plays; unset → foreground is cleared (back to poster).
 *  - audio:      handled by the audio store; unset → current music keeps playing.
 * ========================================================================= */

export const DEFAULT_TRANSITION_MS = 800;
export const MAX_TRANSITION_MS = 10_000;
export const AUTO_RETURN_FADE_MS = 600;
export const INSTANT_BACKDROP_FADE_MS = 250;
export const UNFREEZE_FADE_MS = 200;

export type MediaLookup = (id: string | undefined) => MediaItem | null;

export interface VisibleView {
  cueId: string | null;
  backdrop: MediaItem | null;
  foreground: MediaItem | null;
  foregroundTime: number;
  capturedAt: number;
}

export interface ProgramState {
  takeId: number;
  liveCueId: string | null;
  liveCueLabel: string;
  backdrop: MediaItem | null;
  foreground: MediaItem | null;
  transition: TransitionType;
  transitionDurationMs: number;
  loopBackdrop: boolean;
  autoPlayForeground: boolean;
  duckAudioOnVideo: boolean;
  isFrozen: boolean;
  isBlackout: boolean;
  /** What the audience actually sees while frozen. Immutable until unfreeze/take. */
  frozenView: VisibleView | null;
}

export type ProgramAction =
  | { type: 'TAKE'; payload: StageCuePayload }
  | { type: 'CLEAR_FOREGROUND' }
  | { type: 'FOREGROUND_ENDED'; mediaId: string; takeId: number }
  | { type: 'FREEZE'; foregroundTime: number; at: number }
  | { type: 'UNFREEZE' }
  | { type: 'SET_BLACKOUT'; active: boolean };

export function createInitialProgram(): ProgramState {
  return {
    takeId: 0,
    liveCueId: null,
    liveCueLabel: '',
    backdrop: null,
    foreground: null,
    transition: 'cut',
    transitionDurationMs: 0,
    loopBackdrop: true,
    autoPlayForeground: true,
    duckAudioOnVideo: true,
    isFrozen: false,
    isBlackout: false,
    frozenView: null
  };
}

export function clampTransitionDuration(transition: TransitionType, ms: number): number {
  if (transition === 'cut') return 0;
  return Math.round(clamp(ms, 0, MAX_TRANSITION_MS));
}

export function isBackdropCapable(media: MediaItem | null): media is MediaItem {
  return media !== null && !media.missing && (media.type === 'image' || media.type === 'video');
}

export function isForegroundCapable(media: MediaItem | null): media is MediaItem {
  return media !== null && !media.missing && media.type === 'video';
}

export function buildCuePayload(
  cue: CueItem,
  lookup: MediaLookup,
  program: ProgramState,
  takeId: number
): StageCuePayload {
  const requestedBackdrop = cue.backdropMediaId ? lookup(cue.backdropMediaId) : null;
  const requestedForeground = cue.foregroundMediaId ? lookup(cue.foregroundMediaId) : null;
  const backdrop = isBackdropCapable(requestedBackdrop) ? toStageMedia(requestedBackdrop) : program.backdrop;
  const foreground = isForegroundCapable(requestedForeground) ? toStageMedia(requestedForeground) : null;

  return {
    takeId,
    cueId: cue.id,
    label: cue.label,
    backdrop,
    foreground,
    transition: cue.transition,
    transitionDurationMs: clampTransitionDuration(cue.transition, cue.transitionDurationMs),
    autoPlayForeground: cue.autoPlayForeground,
    loopBackdrop: cue.loopBackdrop,
    duckAudioOnVideo: cue.duckAudioOnVideo
  };
}

/** A one-off "take this file now" from the media library. */
export function buildAdHocPayload(
  media: MediaItem,
  program: ProgramState,
  takeId: number,
  transition: TransitionType = 'dissolve',
  durationMs: number = DEFAULT_TRANSITION_MS
): StageCuePayload {
  const stageMedia = toStageMedia(media);
  const asForeground = media.type === 'video';
  return {
    takeId,
    cueId: null,
    label: media.name,
    backdrop: asForeground ? program.backdrop : stageMedia,
    foreground: asForeground ? stageMedia : null,
    transition,
    transitionDurationMs: clampTransitionDuration(transition, durationMs),
    autoPlayForeground: true,
    loopBackdrop: true,
    duckAudioOnVideo: true
  };
}

export function programReducer(state: ProgramState, action: ProgramAction): ProgramState {
  switch (action.type) {
    case 'TAKE': {
      const p = action.payload;
      return {
        ...state,
        takeId: p.takeId,
        liveCueId: p.cueId,
        liveCueLabel: p.label,
        backdrop: p.backdrop,
        foreground: p.foreground,
        transition: p.transition,
        transitionDurationMs: p.transitionDurationMs,
        loopBackdrop: p.loopBackdrop,
        autoPlayForeground: p.autoPlayForeground,
        duckAudioOnVideo: p.duckAudioOnVideo,
        // A new cue is revealed seamlessly out of a freeze.
        isFrozen: false,
        frozenView: null
      };
    }
    case 'CLEAR_FOREGROUND': {
      if (state.foreground === null && !state.isFrozen) return state;
      return { ...state, foreground: null, isFrozen: false, frozenView: null };
    }
    case 'FOREGROUND_ENDED': {
      // Stale events (an older take finishing) must never clear the current foreground.
      if (state.foreground === null) return state;
      if (state.foreground.id !== action.mediaId || state.takeId !== action.takeId) return state;
      // Auto-return to backdrop. While frozen, `frozenView` is untouched: the audience keeps the still.
      return { ...state, foreground: null };
    }
    case 'FREEZE': {
      if (state.isFrozen) return state;
      return {
        ...state,
        isFrozen: true,
        frozenView: {
          cueId: state.liveCueId,
          backdrop: state.backdrop,
          foreground: state.foreground,
          foregroundTime: Math.max(0, action.foregroundTime),
          capturedAt: action.at
        }
      };
    }
    case 'UNFREEZE': {
      if (!state.isFrozen) return state;
      return { ...state, isFrozen: false, frozenView: null };
    }
    case 'SET_BLACKOUT': {
      if (state.isBlackout === action.active) return state;
      return { ...state, isBlackout: action.active };
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** What the projector is showing right now (frozen still or live composition). */
export function getVisibleView(state: ProgramState, liveForegroundTime: number): VisibleView {
  if (state.isFrozen && state.frozenView) return state.frozenView;
  return {
    cueId: state.liveCueId,
    backdrop: state.backdrop,
    foreground: state.foreground,
    foregroundTime: liveForegroundTime,
    capturedAt: 0
  };
}

/* ------------------------------- Cue stack ------------------------------- */

export function sortCues(cues: readonly CueItem[]): CueItem[] {
  return [...cues].sort((a, b) => a.order - b.order);
}

export function renumberCues(cues: readonly CueItem[]): CueItem[] {
  return sortCues(cues).map((cue, index) => (cue.order === index + 1 ? cue : { ...cue, order: index + 1 }));
}

export function getNextCueIndex(count: number, currentIndex: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return direction === 1 ? 0 : count - 1;
  return clamp(currentIndex + direction, 0, count - 1);
}

/** After taking a cue the highlight moves to the following cue (stays on the last one). */
export function getIndexAfterTake(cues: readonly CueItem[], takenCueId: string): number {
  const ordered = sortCues(cues);
  const index = ordered.findIndex((c) => c.id === takenCueId);
  if (index === -1) return ordered.length > 0 ? 0 : -1;
  return Math.min(index + 1, ordered.length - 1);
}

export function createCue(input: Partial<CueItem> & { id: string }, order: number): CueItem {
  const transition: TransitionType = input.transition ?? 'dissolve';
  return {
    id: input.id,
    order,
    label: input.label?.trim() ? input.label.trim() : `Cue ${order}`,
    backdropMediaId: input.backdropMediaId,
    foregroundMediaId: input.foregroundMediaId,
    audioMediaId: input.audioMediaId,
    transition,
    transitionDurationMs: clampTransitionDuration(transition, input.transitionDurationMs ?? DEFAULT_TRANSITION_MS),
    autoPlayForeground: input.autoPlayForeground ?? true,
    loopBackdrop: input.loopBackdrop ?? true,
    loopAudio: input.loopAudio ?? true,
    audioVolume: clamp(input.audioVolume ?? 0.8, 0, 1),
    duckAudioOnVideo: input.duckAudioOnVideo ?? true,
    notes: input.notes,
    followMode: input.followMode ?? 'off',
    followDelaySec: clamp(input.followDelaySec ?? 10, 1, 3600),
    followTargetId: input.followTargetId
  };
}

export function insertCue(cues: readonly CueItem[], cue: CueItem, afterCueId: string | null): CueItem[] {
  const ordered = sortCues(cues);
  const index = afterCueId ? ordered.findIndex((c) => c.id === afterCueId) : -1;
  const at = index === -1 ? ordered.length : index + 1;
  return [...ordered.slice(0, at), cue, ...ordered.slice(at)].map((c, i) =>
    c.order === i + 1 ? c : { ...c, order: i + 1 }
  );
}

export function moveCue(cues: readonly CueItem[], cueId: string, delta: number): CueItem[] {
  const ordered = sortCues(cues);
  const index = ordered.findIndex((c) => c.id === cueId);
  if (index === -1) return [...ordered];
  const target = clamp(index + delta, 0, ordered.length - 1);
  if (target === index) return [...ordered];
  const next = [...ordered];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next.map((c, i) => (c.order === i + 1 ? c : { ...c, order: i + 1 }));
}

export function removeCue(cues: readonly CueItem[], cueId: string): CueItem[] {
  return renumberCues(cues.filter((c) => c.id !== cueId));
}

export function duplicateCue(cues: readonly CueItem[], cueId: string, newId: string): CueItem[] {
  const source = cues.find((c) => c.id === cueId);
  if (!source) return sortCues(cues);
  const copy: CueItem = { ...source, id: newId, label: `${source.label} (copy)` };
  return insertCue(cues, copy, cueId);
}

/** Assigns a library item to the slot that matches its media type. */
export function assignMediaToCue(cue: CueItem, media: MediaItem): CueItem {
  switch (media.type) {
    case 'image':
      return { ...cue, backdropMediaId: media.id };
    case 'video':
      return { ...cue, foregroundMediaId: media.id };
    case 'audio':
      return { ...cue, audioMediaId: media.id };
    default: {
      const exhaustive: never = media.type;
      return exhaustive;
    }
  }
}

/** Removes references to deleted media from every cue. */
export function detachMediaFromCues(cues: readonly CueItem[], mediaId: string): CueItem[] {
  return cues.map((cue) => {
    if (cue.backdropMediaId !== mediaId && cue.foregroundMediaId !== mediaId && cue.audioMediaId !== mediaId) {
      return cue;
    }
    return {
      ...cue,
      backdropMediaId: cue.backdropMediaId === mediaId ? undefined : cue.backdropMediaId,
      foregroundMediaId: cue.foregroundMediaId === mediaId ? undefined : cue.foregroundMediaId,
      audioMediaId: cue.audioMediaId === mediaId ? undefined : cue.audioMediaId
    };
  });
}

/* ------------------------------ Transitions ------------------------------ */

export interface TransitionPlan {
  outDelayMs: number;
  outDurationMs: number;
  inDelayMs: number;
  inDurationMs: number;
  totalMs: number;
}

/**
 * cut      → instant swap.
 * dissolve → outgoing and incoming layers cross over the full duration.
 * fade     → outgoing fades to black over the first half, incoming fades up over the second half.
 */
export function planTransition(type: TransitionType, durationMs: number): TransitionPlan {
  const d = clampTransitionDuration(type, durationMs);
  switch (type) {
    case 'cut':
      return { outDelayMs: 0, outDurationMs: 0, inDelayMs: 0, inDurationMs: 0, totalMs: 0 };
    case 'dissolve':
      return { outDelayMs: 0, outDurationMs: d, inDelayMs: 0, inDurationMs: d, totalMs: d };
    case 'fade': {
      const half = Math.round(d / 2);
      return { outDelayMs: 0, outDurationMs: half, inDelayMs: half, inDurationMs: d - half, totalMs: d };
    }
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export function describeCueContents(cue: CueItem, lookup: MediaLookup): string[] {
  const parts: string[] = [];
  const backdrop = lookup(cue.backdropMediaId);
  const foreground = lookup(cue.foregroundMediaId);
  const audio = lookup(cue.audioMediaId);
  if (backdrop) parts.push(`Backdrop: ${backdrop.name}`);
  if (foreground) parts.push(`Video: ${foreground.name}`);
  if (audio) parts.push(`Music: ${audio.name}`);
  return parts;
}
