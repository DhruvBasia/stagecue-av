import {
  SHOW_FILE_VERSION,
  type AudioMix,
  type AudioOutputPref,
  type CueItem,
  type DriveSource,
  type FollowMode,
  type MediaItem,
  type MediaType,
  type ShowFile,
  type ShowOpenResult,
  type ShowSaveResult,
  type ShowSettings,
  type StoredMediaRef,
  type TransitionType
} from '../types';
import { DEFAULT_MIX, normalizeMix } from './audioEngine';
import { clampTransitionDuration, renumberCues } from './cueManager';
import { clamp } from './utils';

/* =========================================================================
 * Show file (JSON) persistence + crash-recovery autosave.
 * ========================================================================= */

export const AUTOSAVE_KEY = 'stagecue-av:autosave:v1';

export class ShowFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShowFileError';
  }
}

export interface ShowSnapshotInput {
  name: string;
  media: readonly MediaItem[];
  cues: readonly CueItem[];
  mix: AudioMix;
  folders?: readonly string[];
  settings?: ShowSettings;
  audioOutput?: AudioOutputPref | null;
  driveSources?: readonly DriveSource[];
}

export function serializeShow(input: ShowSnapshotInput, now: Date = new Date()): ShowFile {
  return {
    app: 'stagecue-av',
    version: SHOW_FILE_VERSION,
    name: input.name.trim() || 'Untitled Show',
    savedAt: now.toISOString(),
    media: input.media.map((m) => {
      const ref: StoredMediaRef = { id: m.id, name: m.name, type: m.type, filePath: m.filePath };
      if (m.duration !== undefined && Number.isFinite(m.duration)) ref.duration = m.duration;
      if (m.dimensions) ref.dimensions = { ...m.dimensions };
      if (m.pdf) ref.pdf = { ...m.pdf };
      return ref;
    }),
    cues: renumberCues(input.cues).map((c) => ({ ...c })),
    audio: normalizeMix(input.mix),
    folders: [...(input.folders ?? [])],
    settings: { autoFollowEnabled: input.settings ? input.settings.autoFollowEnabled : true },
    audioOutput: input.audioOutput ? { ...input.audioOutput } : null,
    driveSources: (input.driveSources ?? []).map((s) => ({ ...s }))
  };
}

export function parseFolders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) unique.add(entry);
  }
  return [...unique];
}

const MEDIA_TYPES: readonly MediaType[] = ['image', 'video', 'audio'];
const TRANSITIONS: readonly TransitionType[] = ['cut', 'fade', 'dissolve'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parseMediaRef(raw: unknown, index: number): StoredMediaRef {
  if (!isRecord(raw)) throw new ShowFileError(`Media entry #${index + 1} is not an object.`);
  const id = optionalString(raw.id);
  const filePath = optionalString(raw.filePath);
  const type = raw.type as MediaType;
  if (!id || !filePath) throw new ShowFileError(`Media entry #${index + 1} is missing its id or file path.`);
  if (!MEDIA_TYPES.includes(type)) throw new ShowFileError(`Media entry #${index + 1} has an unknown type.`);
  const ref: StoredMediaRef = {
    id,
    filePath,
    type,
    name: optionalString(raw.name) ?? filePath.split(/[\\/]/).pop() ?? filePath
  };
  const relativePath = optionalString(raw.relativePath);
  if (relativePath) ref.relativePath = relativePath;
  if (typeof raw.duration === 'number' && Number.isFinite(raw.duration)) ref.duration = raw.duration;
  if (isRecord(raw.dimensions)) {
    const width = numberOr(raw.dimensions.width, 0);
    const height = numberOr(raw.dimensions.height, 0);
    if (width > 0 && height > 0) ref.dimensions = { width, height };
  }
  if (isRecord(raw.pdf)) {
    const sourcePath = optionalString(raw.pdf.sourcePath);
    const page = numberOr(raw.pdf.page, 0);
    if (sourcePath && Number.isInteger(page) && page >= 1) {
      ref.pdf = {
        sourcePath,
        page,
        pageCount: Math.max(page, Math.floor(numberOr(raw.pdf.pageCount, page)))
      };
      const relativeSourcePath = optionalString(raw.pdf.relativeSourcePath);
      if (relativeSourcePath) ref.pdf.relativeSourcePath = relativeSourcePath;
      const originalPath = optionalString(raw.pdf.originalPath);
      if (originalPath) ref.pdf.originalPath = originalPath;
      const relativeOriginalPath = optionalString(raw.pdf.relativeOriginalPath);
      if (relativeOriginalPath) ref.pdf.relativeOriginalPath = relativeOriginalPath;
    }
  }
  return ref;
}

export function parseCue(raw: unknown, index: number, mediaIds: ReadonlySet<string>): CueItem {
  if (!isRecord(raw)) throw new ShowFileError(`Cue #${index + 1} is not an object.`);
  const id = optionalString(raw.id);
  if (!id) throw new ShowFileError(`Cue #${index + 1} has no id.`);
  const transition: TransitionType = TRANSITIONS.includes(raw.transition as TransitionType)
    ? (raw.transition as TransitionType)
    : 'dissolve';
  const ref = (value: unknown): string | undefined => {
    const s = optionalString(value);
    return s && mediaIds.has(s) ? s : undefined;
  };
  return {
    id,
    order: numberOr(raw.order, index + 1),
    label: optionalString(raw.label) ?? `Cue ${index + 1}`,
    backdropMediaId: ref(raw.backdropMediaId),
    foregroundMediaId: ref(raw.foregroundMediaId),
    audioMediaId: ref(raw.audioMediaId),
    transition,
    transitionDurationMs: clampTransitionDuration(transition, numberOr(raw.transitionDurationMs, 800)),
    autoPlayForeground: booleanOr(raw.autoPlayForeground, true),
    loopBackdrop: booleanOr(raw.loopBackdrop, true),
    loopAudio: booleanOr(raw.loopAudio, true),
    audioVolume: clamp(numberOr(raw.audioVolume, 0.8), 0, 1),
    duckAudioOnVideo: booleanOr(raw.duckAudioOnVideo, true),
    notes: optionalString(raw.notes),
    followMode: FOLLOW_MODES.includes(raw.followMode as FollowMode) ? (raw.followMode as FollowMode) : 'off',
    followDelaySec: clamp(numberOr(raw.followDelaySec, 10), 1, 3600),
    followTargetId: optionalString(raw.followTargetId)
  };
}

const FOLLOW_MODES: readonly FollowMode[] = ['off', 'on-end', 'after-delay'];

export function parseSettings(raw: unknown): ShowSettings {
  return { autoFollowEnabled: isRecord(raw) ? booleanOr(raw.autoFollowEnabled, true) : true };
}

export function parseDriveSources(raw: unknown): DriveSource[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const sources: DriveSource[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = optionalString(entry.id);
    const folderId = optionalString(entry.folderId);
    const localPath = optionalString(entry.localPath);
    if (!id || !folderId || !/^[A-Za-z0-9_-]{10,}$/.test(folderId) || !localPath || seen.has(folderId)) continue;
    seen.add(folderId);
    const source: DriveSource = {
      id,
      folderId,
      localPath,
      url: optionalString(entry.url) ?? `https://drive.google.com/drive/folders/${folderId}`,
      name: optionalString(entry.name) ?? 'Drive folder'
    };
    const resourceKey = optionalString(entry.resourceKey);
    if (resourceKey) source.resourceKey = resourceKey;
    sources.push(source);
  }
  return sources;
}

export function parseAudioOutput(raw: unknown): AudioOutputPref | null {
  if (!isRecord(raw)) return null;
  const deviceId = optionalString(raw.deviceId);
  const label = optionalString(raw.label);
  return deviceId && label ? { deviceId, label } : null;
}

export function parseMix(raw: unknown): AudioMix {
  if (!isRecord(raw)) return { ...DEFAULT_MIX };
  return normalizeMix({
    bgMusicVolume: numberOr(raw.bgMusicVolume, DEFAULT_MIX.bgMusicVolume),
    videoAudioVolume: numberOr(raw.videoAudioVolume, DEFAULT_MIX.videoAudioVolume),
    masterVolume: numberOr(raw.masterVolume, DEFAULT_MIX.masterVolume),
    isMuted: booleanOr(raw.isMuted, DEFAULT_MIX.isMuted),
    autoDuckEnabled: booleanOr(raw.autoDuckEnabled, DEFAULT_MIX.autoDuckEnabled),
    duckAttenuationPercent: numberOr(raw.duckAttenuationPercent, DEFAULT_MIX.duckAttenuationPercent)
  });
}

/** Validates and normalises untrusted JSON. Throws ShowFileError with an operator-readable message. */
export function parseShowFile(text: string): ShowFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ShowFileError('The file is not valid JSON.');
  }
  if (!isRecord(raw) || raw.app !== 'stagecue-av') {
    throw new ShowFileError('This is not a StageCue AV show file.');
  }
  if (typeof raw.version !== 'number' || raw.version > SHOW_FILE_VERSION) {
    throw new ShowFileError('This show was saved by a newer version of StageCue AV.');
  }
  const mediaRaw = Array.isArray(raw.media) ? raw.media : [];
  const cuesRaw = Array.isArray(raw.cues) ? raw.cues : [];

  const media: StoredMediaRef[] = [];
  const seen = new Set<string>();
  mediaRaw.forEach((entry, index) => {
    const ref = parseMediaRef(entry, index);
    if (seen.has(ref.id)) return;
    seen.add(ref.id);
    media.push(ref);
  });

  const cueIds = new Set<string>();
  const cues: CueItem[] = [];
  cuesRaw.forEach((entry, index) => {
    const cue = parseCue(entry, index, seen);
    if (cueIds.has(cue.id)) return;
    cueIds.add(cue.id);
    cues.push(cue);
  });
  // Follow targets must point at a cue that exists in this show.
  for (const cue of cues) {
    if (cue.followTargetId && !cueIds.has(cue.followTargetId)) cue.followTargetId = undefined;
  }

  return {
    app: 'stagecue-av',
    version: SHOW_FILE_VERSION,
    name: optionalString(raw.name) ?? 'Untitled Show',
    savedAt: optionalString(raw.savedAt) ?? new Date(0).toISOString(),
    media,
    cues: renumberCues(cues),
    audio: parseMix(raw.audio),
    folders: parseFolders(raw.folders),
    settings: parseSettings(raw.settings),
    audioOutput: parseAudioOutput(raw.audioOutput),
    driveSources: parseDriveSources(raw.driveSources)
  };
}

/* ------------------------------ Disk I/O --------------------------------- */

export async function saveShowToDisk(show: ShowFile, filePath: string | null, saveAs: boolean): Promise<ShowSaveResult> {
  return window.api.invoke('show:save', { show, filePath, saveAs });
}

export async function openShowFromDisk(): Promise<{ result: ShowOpenResult; show: ShowFile } | null> {
  const result = await window.api.invoke('show:open');
  if (!result) return null;
  return { result, show: parseShowFile(result.content) };
}

/* ------------------------------ Autosave --------------------------------- */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function writeAutosave(show: ShowFile, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(AUTOSAVE_KEY, JSON.stringify(show));
    return true;
  } catch {
    return false;
  }
}

export function readAutosave(storage: StorageLike | null = defaultStorage()): ShowFile | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(AUTOSAVE_KEY);
    if (!text) return null;
    return parseShowFile(text);
  } catch {
    return null;
  }
}

export function clearAutosave(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(AUTOSAVE_KEY);
  } catch {
    return;
  }
}
