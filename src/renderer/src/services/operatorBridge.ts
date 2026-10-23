import { useEffect } from 'react';
import type {
  LivePaging,
  MediaItem,
  MenuCommand,
  RemoteAck,
  RemoteActionEvent,
  RemoteActionName,
  RemoteCue,
  RemoteStatus,
  ShowFile
} from '../types';
import { useCrewStore } from '../store/useCrewStore';
import { useDriveStore } from '../store/useDriveStore';
import { isAnyModalOpen } from '../components/common/Modal';
import { useAudioStore } from '../store/useAudioStore';
import { useMediaStore } from '../store/useMediaStore';
import { usePrefsStore } from '../store/usePrefsStore';
import { useShowStore } from '../store/useShowStore';
import { useStageStore } from '../store/useStageStore';
import { useOnAirStore } from '../store/useOnAirStore';
import { useUpdateStore } from '../store/useUpdateStore';
import { useWebStore } from '../store/useWebStore';
import { sortCues } from './cueManager';
import { DEFAULT_ON_AIR } from './onAir';
import { livePaging } from './paging';
import { describeFollow, followSecondsLeft } from './followEngine';
import { HotkeyManager, type HotkeyAction } from './hotkeyManager';
import { buildRunSheetHtml } from './runSheet';
import {
  clearAutosave,
  openShowFromDisk,
  saveShowToDisk,
  serializeShow,
  ShowFileError,
  writeAutosave
} from './storage';
import { baseName, formatTime, stripExtension } from './utils';

/* =========================================================================
 * Operator-window glue: IPC subscriptions, hotkeys, menu commands, autosave,
 * and show open/save orchestration across the three stores.
 * ========================================================================= */

const AUTOSAVE_DEBOUNCE_MS = 1000;

export function currentShowSnapshot(): ShowFile {
  return serializeShow({
    name: useShowStore.getState().showName,
    media: useMediaStore.getState().items,
    cues: useStageStore.getState().cues,
    mix: useAudioStore.getState().getMix(),
    folders: useMediaStore.getState().folders,
    settings: { autoFollowEnabled: useStageStore.getState().autoFollowEnabled },
    audioOutput: useAudioStore.getState().outputPref,
    driveSources: useDriveStore.getState().sources,
    onAir: useOnAirStore.getState().settings()
  });
}

/* ------------------------------ Shared actions --------------------------- */

/** Clickers can double-fire: key presses turning pages faster than this are ignored (buttons are not limited). */
export const PAGE_KEY_GUARD_MS = 150;
let lastPageKeyAt = 0;

function pageKeyAllowed(): boolean {
  const now = Date.now();
  if (now - lastPageKeyAt < PAGE_KEY_GUARD_MS) return false;
  lastPageKeyAt = now;
  return true;
}

/** One place for keyboard, clicker and phone-remote actions. */
export function runOperatorAction(action: HotkeyAction | Exclude<RemoteActionName, 'take-cue'>): void {
  const stage = useStageStore.getState();
  switch (action) {
    case 'take':
      stage.takeSelected();
      break;
    case 'freeze':
      stage.toggleFreeze();
      break;
    case 'blackout':
      stage.toggleBlackout();
      break;
    case 'instant-backdrop':
      stage.instantBackdrop();
      break;
    case 'fade-audio':
      useAudioStore.getState().fadeOutMusic();
      break;
    case 'next-cue':
      stage.selectNext();
      break;
    case 'prev-cue':
      stage.selectPrev();
      break;
    case 'toggle-video': {
      const telemetry = stage.telemetry;
      stage.videoControl({ action: telemetry && telemetry.isForegroundPlaying ? 'pause' : 'play' });
      break;
    }
    case 'toggle-follow':
      stage.toggleAutoFollow();
      break;
    case 'music-toggle': {
      const audio = useAudioStore.getState();
      const playing = audio.telemetry ? audio.telemetry.isBgMusicPlaying : audio.isBgMusicPlaying;
      if (playing) audio.pauseMusic();
      else audio.playMusic();
      break;
    }
    case 'page-next':
    case 'page-prev': {
      if (!pageKeyAllowed()) break;
      const result = stage.turnPage(action === 'page-next' ? 1 : -1);
      if (!result.ok && result.atEnd) useShowStore.getState().pushAlert('info', result.message, '', false);
      break;
    }
    case 'clicker-next':
    case 'clicker-prev': {
      const forward = action === 'clicker-next';
      // A presenter clicking through a booklet: pages first, then on through the cue list.
      if (usePrefsStore.getState().clickerTurnsPages && currentPaging() !== null) {
        if (!pageKeyAllowed()) break;
        const result = stage.turnPage(forward ? 1 : -1);
        if (result.ok || !result.atEnd) break;
      }
      if (forward) stage.takeSelected();
      else stage.selectPrev();
      break;
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown action ${String(exhaustive)}`);
    }
  }
}

/** The live booklet (PDF/deck page or web page), if any. */
export function currentPaging(): LivePaging | null {
  const backdrop = useStageStore.getState().program.backdrop;
  const item = backdrop ? useMediaStore.getState().getById(backdrop.id) : null;
  const frame = useWebStore.getState().frame;
  return livePaging(item, frame && item && frame.mediaId === item.id ? frame.url : null);
}

/** Runs a command from a crew phone and describes the result for its acknowledgement. */
export function runRemoteAction(event: RemoteActionEvent): RemoteAck {
  const stage = useStageStore.getState();
  const audio = useAudioStore.getState();
  const done = (ok: boolean, message: string): RemoteAck => ({ requestId: event.requestId, ok, message });
  let result: RemoteAck;

  switch (event.action) {
    case 'take-cue': {
      const cue = stage.cues.find((c) => c.id === event.cueId);
      if (!cue) {
        result = done(false, 'That cue no longer exists');
        break;
      }
      result = stage.takeCue(cue.id) ? done(true, `Cue ${cue.order} “${cue.label}” is live`) : done(false, 'Too fast — try again');
      break;
    }
    case 'take': {
      const cue = stage.cues.find((c) => c.id === stage.selectedCueId);
      if (!cue) {
        result = done(false, 'No cue is highlighted');
        break;
      }
      result = stage.takeSelected() ? done(true, `Cue ${cue.order} “${cue.label}” is live`) : done(false, 'Too fast — try again');
      break;
    }
    case 'music-toggle': {
      if (!audio.bgMusicMedia) {
        result = done(false, 'No background track loaded');
        break;
      }
      const playing = audio.telemetry ? audio.telemetry.isBgMusicPlaying : audio.isBgMusicPlaying;
      runOperatorAction('music-toggle');
      result = done(true, playing ? 'Music paused' : `Playing ${audio.bgMusicMedia.name}`);
      break;
    }
    case 'toggle-video': {
      if (!stage.program.foreground) {
        result = done(false, 'No video on stage');
        break;
      }
      const playing = stage.telemetry?.isForegroundPlaying ?? false;
      runOperatorAction('toggle-video');
      result = done(true, playing ? 'Video paused' : 'Video playing');
      break;
    }
    case 'fade-audio':
      if (!audio.bgMusicMedia) {
        result = done(false, 'No background track loaded');
        break;
      }
      runOperatorAction('fade-audio');
      result = done(true, 'Fading music out');
      break;
    case 'freeze':
      runOperatorAction('freeze');
      result = done(true, useStageStore.getState().program.isFrozen ? 'Projector frozen' : 'Unfrozen');
      break;
    case 'blackout':
      runOperatorAction('blackout');
      result = done(true, useStageStore.getState().program.isBlackout ? 'Blackout ON' : 'Blackout OFF');
      break;
    case 'instant-backdrop':
      runOperatorAction('instant-backdrop');
      result = done(true, 'Back to the backdrop');
      break;
    case 'toggle-follow':
      runOperatorAction('toggle-follow');
      result = done(true, `Auto-follow ${useStageStore.getState().autoFollowEnabled ? 'ON' : 'OFF'}`);
      break;
    case 'next-cue':
    case 'prev-cue': {
      runOperatorAction(event.action);
      const next = useStageStore.getState().cues.find((c) => c.id === useStageStore.getState().selectedCueId);
      result = done(true, next ? `Next: ${next.order}. ${next.label}` : 'No cue highlighted');
      break;
    }
    case 'page-next':
    case 'page-prev': {
      const turned = stage.turnPage(event.action === 'page-next' ? 1 : -1);
      result = done(turned.ok, turned.message);
      break;
    }
    default: {
      const exhaustive: never = event.action;
      result = done(false, `Unknown command ${String(exhaustive)}`);
    }
  }

  // The AV room always sees what the stage team did (page turns are visible on the program monitor).
  const quiet = event.action === 'next-cue' || event.action === 'prev-cue' || event.action === 'page-next' || event.action === 'page-prev';
  if (event.role === 'stage' && result.ok && !quiet) {
    useShowStore.getState().pushAlert('info', `Stage team · ${event.clientName}`, result.message, false);
  }
  return result;
}

function backdropKindLabel(item: MediaItem): string {
  if (item.pdf?.originalPath) return 'Slides';
  if (item.pdf) return `PDF · page ${item.pdf.page}/${item.pdf.pageCount}`;
  switch (item.type) {
    case 'video':
      return 'Moving backdrop';
    case 'web':
      return 'Web page';
    case 'screen':
      return 'Live window';
    default:
      return 'Poster';
  }
}

/**
 * Saves a web flipbook as a PDF booklet that plays without internet, and adds a
 * booklet cue for it (unless one already uses its pages).
 */
export async function saveWebPageOffline(item: MediaItem): Promise<void> {
  const result = await useMediaStore.getState().makeOfflineCopy(item);
  if (!result || result.pages.length === 0) return;
  const pageIds = new Set(result.pages.map((p) => p.id));
  const stage = useStageStore.getState();
  const cueName = `${item.name} (offline)`;
  const hasCue = stage.cues.some((c) => c.backdropMediaId !== undefined && pageIds.has(c.backdropMediaId));
  if (!hasCue) {
    stage.addCue({
      label: cueName,
      backdropMediaId: result.pages[0].id,
      transition: 'dissolve',
      notes: 'Offline copy of the web page: turn pages with ◀ ▶, [ ], the clicker or the crew phones.'
    });
  }
  useShowStore
    .getState()
    .pushAlert(
      'success',
      `Offline copy ready: ${item.name} (${result.pages.length} page${result.pages.length === 1 ? '' : 's'})`,
      `${hasCue ? 'Its pages were updated.' : `Cue “${cueName}” was added.`} It plays without internet; the PDF is in Documents\\StageCue Offline.`,
      false
    );
}

/** Cue list for phones/tablets (with the library's small JPEG thumbnails). */
export function buildRemoteCues(): RemoteCue[] {
  const items = new Map(useMediaStore.getState().items.map((i) => [i.id, i] as const));
  const cues = sortCues(useStageStore.getState().cues);
  const thumbOf = (item: MediaItem | undefined): string | null =>
    item?.thumbnailUrl && /^data:image\/(jpeg|png);base64,/.test(item.thumbnailUrl) ? item.thumbnailUrl : null;
  return cues.map((cue) => {
    const backdrop = cue.backdropMediaId ? items.get(cue.backdropMediaId) : undefined;
    const video = cue.foregroundMediaId ? items.get(cue.foregroundMediaId) : undefined;
    const music = cue.audioMediaId ? items.get(cue.audioMediaId) : undefined;
    const parts: string[] = [];
    if (video) parts.push(`Video${video.duration ? ` ${formatTime(video.duration)}` : ''}`);
    if (backdrop) parts.push(backdropKindLabel(backdrop));
    if (music) parts.push(`♪ ${music.name.replace(/\.[^.]+$/, '')}`);
    const kinds = [backdrop ? 'backdrop' : null, video ? 'video' : null, music ? 'music' : null].filter(Boolean);
    return {
      id: cue.id,
      order: cue.order,
      label: cue.label,
      kind: (kinds.length === 0 ? 'empty' : kinds.length > 1 ? 'mixed' : kinds[0]) as RemoteCue['kind'],
      thumb: thumbOf(backdrop) ?? thumbOf(video),
      detail: parts.join(' · ') || 'Empty cue',
      notes: cue.notes ?? null,
      follow: describeFollow(cue, cues)?.replace('→ ', 'auto: ') ?? null
    };
  });
}

/** Live status pushed to phone remotes. */
export function buildRemoteStatus(now: number = Date.now()): RemoteStatus {
  const stage = useStageStore.getState();
  const audio = useAudioStore.getState();
  const cues = sortCues(stage.cues);
  const next = cues.find((c) => c.id === stage.selectedCueId) ?? null;
  const telemetry = stage.telemetry;
  const hasVideo =
    stage.program.foreground !== null && telemetry !== null && telemetry.currentForeground?.id === stage.program.foreground.id;
  const musicPlaying = audio.telemetry ? audio.telemetry.isBgMusicPlaying : audio.isBgMusicPlaying;
  return {
    showName: useShowStore.getState().showName,
    liveCue: stage.program.liveCueLabel || null,
    liveCueId: stage.program.liveCueId,
    nextCue: next ? next.label : null,
    nextCueId: next ? next.id : null,
    nextCueNumber: next ? next.order : null,
    isFrozen: stage.program.isFrozen,
    isBlackout: stage.program.isBlackout,
    videoPlaying: hasVideo && telemetry !== null && telemetry.isForegroundPlaying,
    videoRemaining: hasVideo && telemetry ? Math.max(0, telemetry.foregroundDuration - telemetry.foregroundCurrentTime) : null,
    musicName: audio.bgMusicMedia ? audio.bgMusicMedia.name : null,
    musicPlaying,
    autoFollowEnabled: stage.autoFollowEnabled,
    followCountdown: followSecondsLeft(stage.pendingFollow, now),
    projector: stage.displayStatus ? stage.displayStatus.mode : null,
    paging: currentPaging(),
    timer: useOnAirStore.getState().remoteTimer(now)
  };
}

export async function exportRunSheet(mode: 'pdf' | 'print'): Promise<void> {
  const show = useShowStore.getState();
  const html = buildRunSheetHtml({
    showName: show.showName,
    cues: useStageStore.getState().cues,
    items: useMediaStore.getState().items,
    autoFollowEnabled: useStageStore.getState().autoFollowEnabled,
    generatedAt: new Date()
  });
  try {
    const result = await window.api.invoke('runsheet:export', { html, mode, suggestedName: `${show.showName} - Run Sheet` });
    if (result.ok) {
      show.pushAlert('success', mode === 'pdf' ? 'Run sheet exported' : 'Run sheet sent to printer', result.filePath ?? '', false);
    } else if (!result.canceled) {
      show.pushAlert('error', 'Run sheet failed', result.error ?? 'Unknown error');
    }
  } catch (error) {
    show.pushAlert('error', 'Run sheet failed', error instanceof Error ? error.message : String(error));
  }
}

export async function saveShow(saveAs: boolean): Promise<boolean> {
  const show = useShowStore.getState();
  try {
    const result = await saveShowToDisk(currentShowSnapshot(), show.showFilePath, saveAs);
    if (result.ok) {
      const name = stripExtension(baseName(result.filePath));
      show.markSaved(result.filePath, result.savedAt, name);
      clearAutosave();
      show.pushAlert('success', 'Show saved', result.filePath, false);
      return true;
    }
    if (!result.canceled) show.pushAlert('error', 'Save failed', result.error ?? 'Unknown error');
    return false;
  } catch (error) {
    show.pushAlert('error', 'Save failed', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * PDF pages are stored as renders in this machine's cache. When a show moves to
 * another laptop (or the cache was cleared) the pages are re-rendered from the
 * source PDF, found by absolute path or relative to the show file. Mutates `items`.
 */
async function restorePdfPages(items: MediaItem[], baseDir: string | null): Promise<void> {
  const bySource = new Map<string, MediaItem[]>();
  for (const item of items) {
    if (!item.pdf || !item.missing) continue;
    const key = item.pdf.originalPath ?? item.pdf.sourcePath;
    const group = bySource.get(key) ?? [];
    group.push(item);
    bySource.set(key, group);
  }

  for (const [sourcePath, pageItems] of bySource) {
    const ref = pageItems[0].pdf;
    if (!ref) continue;
    try {
      // Slides are re-converted from the original deck; PDF pages from the PDF.
      const isDeck = Boolean(ref.originalPath);
      const [source] = await window.api.invoke('media:read-metadata', [
        {
          filePath: sourcePath,
          relativePath: isDeck ? ref.relativeOriginalPath : ref.relativeSourcePath,
          baseDir: baseDir ?? undefined
        }
      ]);
      if (!source || !source.exists) continue;
      const pages = pageItems.map((i) => (i.pdf ? i.pdf.page : 0)).filter((p) => p > 0);
      const rendered = isDeck
        ? await useMediaStore.getState().renderPresentation(source, pages)
        : await useMediaStore.getState().renderPdf(source, pages);
      const byPage = new Map(rendered.map((r) => [r.pdf ? r.pdf.page : 0, r] as const));
      for (const item of pageItems) {
        const page = item.pdf ? byPage.get(item.pdf.page) : undefined;
        if (!page || !page.pdf) continue;
        item.filePath = page.filePath;
        item.fileUrl = page.fileUrl;
        item.sizeBytes = page.sizeBytes;
        item.missing = false;
        item.pdf = {
          ...page.pdf,
          relativeSourcePath: ref.relativeSourcePath,
          ...(ref.relativeOriginalPath ? { relativeOriginalPath: ref.relativeOriginalPath } : {})
        };
      }
    } catch (error) {
      useShowStore
        .getState()
        .pushAlert('warning', `Could not render “${baseName(sourcePath)}”`, error instanceof Error ? error.message : String(error));
    }
  }
}

/** Loads a parsed show. The live stage output is not touched. */
export async function applyShow(show: ShowFile, filePath: string | null, baseDir: string | null): Promise<void> {
  // Web pages and window captures are not files; everything else is looked up on disk.
  const fileRefs = show.media.filter((m) => m.type !== 'web' && m.type !== 'screen');
  const resolvedFiles = await window.api.invoke(
    'media:read-metadata',
    fileRefs.map((m) => ({
      filePath: m.filePath,
      relativePath: m.relativePath,
      baseDir: baseDir ?? undefined
    }))
  );
  const resolvedById = new Map(fileRefs.map((m, index) => [m.id, resolvedFiles[index]] as const));

  const items: MediaItem[] = show.media.map((ref) => {
    if (ref.web) {
      return { id: ref.id, name: ref.name, type: 'web', filePath: ref.web.url, fileUrl: ref.web.url, web: { ...ref.web } };
    }
    if (ref.capture) {
      return { id: ref.id, name: ref.name, type: 'screen', filePath: ref.filePath, fileUrl: '', capture: { ...ref.capture } };
    }
    const file = resolvedById.get(ref.id);
    const exists = Boolean(file && file.exists);
    const item: MediaItem = {
      id: ref.id,
      name: ref.name,
      type: ref.type,
      filePath: file ? file.filePath : ref.filePath,
      fileUrl: file ? file.fileUrl : '',
      missing: !exists
    };
    if (file && file.exists) item.sizeBytes = file.sizeBytes;
    if (ref.duration !== undefined) item.duration = ref.duration;
    if (ref.dimensions) item.dimensions = ref.dimensions;
    if (ref.pdf) item.pdf = { ...ref.pdf };
    return item;
  });

  await restorePdfPages(items, baseDir);

  useMediaStore.getState().replaceAll(items, show.folders ?? []);
  useStageStore.getState().setCues(show.cues);
  useStageStore.getState().setAutoFollow(show.settings ? show.settings.autoFollowEnabled : true, false);
  useAudioStore.getState().applyMix(show.audio, false);
  useAudioStore.getState().applyOutputPref(show.audioOutput ?? null);
  useDriveStore.getState().loadSources(show.driveSources ?? []);
  useOnAirStore.getState().loadSettings(show.onAir ?? DEFAULT_ON_AIR);
  useShowStore.getState().loadedShow(show.name, filePath, filePath === null);
  // Fetch any performer tracks uploaded since the show was saved (runs in the background).
  if ((show.driveSources ?? []).length > 0) void useDriveStore.getState().syncAll('open');

  // Pick up anything added to the event folders since the show was saved.
  const folders = show.folders ?? [];
  if (folders.length > 0) {
    const outcomes = await Promise.all(folders.map((folder) => useMediaStore.getState().rescanFolder(folder)));
    const changed = outcomes.some(
      (o) => o !== null && (o.added.length > 0 || o.missingCount > 0 || o.restoredCount > 0)
    );
    useShowStore.getState().loadedShow(show.name, filePath, filePath === null || changed);
  }

  const missing = useMediaStore.getState().items.filter((i) => i.missing);
  if (missing.length > 0) {
    useShowStore
      .getState()
      .pushAlert(
        'warning',
        `${missing.length} media file(s) not found`,
        `${missing
          .slice(0, 4)
          .map((m) => m.name)
          .join(', ')}${missing.length > 4 ? '…' : ''}. Re-import them before the show.`
      );
  }
}

export async function openShow(): Promise<void> {
  const show = useShowStore.getState();
  if (show.isDirty && !window.confirm('The current show has unsaved changes. Open another show anyway?')) return;
  try {
    const opened = await openShowFromDisk();
    if (!opened) return;
    await applyShow(opened.show, opened.result.filePath, opened.result.baseDir);
    useShowStore.getState().pushAlert('success', 'Show opened', opened.result.filePath, false);
  } catch (error) {
    const message = error instanceof ShowFileError || error instanceof Error ? error.message : String(error);
    show.pushAlert('error', 'Could not open show', message);
  }
}

export function newShow(): void {
  const show = useShowStore.getState();
  if (show.isDirty && !window.confirm('Discard unsaved changes and start a new show? The stage output is not affected.')) {
    return;
  }
  useMediaStore.getState().replaceAll([]);
  useStageStore.getState().setCues([]);
  useStageStore.getState().cancelFollow();
  useStageStore.getState().setAutoFollow(true, false);
  useDriveStore.getState().loadSources([]);
  useOnAirStore.getState().loadSettings(DEFAULT_ON_AIR);
  show.resetShow();
  clearAutosave();
}

export function runMenuCommand(command: MenuCommand): void {
  switch (command) {
    case 'new-show':
      newShow();
      break;
    case 'open-show':
      void openShow();
      break;
    case 'save-show':
      void saveShow(false);
      break;
    case 'save-show-as':
      void saveShow(true);
      break;
    case 'import-media':
      void useMediaStore.getState().importFromDialog(['image', 'video', 'audio']);
      break;
    case 'import-folder':
      void useMediaStore.getState().importFolderFromDialog();
      break;
    case 'preshow-check':
      useShowStore.getState().setPanel('preshow');
      break;
    case 'export-runsheet':
      void exportRunSheet('pdf');
      break;
    case 'print-runsheet':
      void exportRunSheet('print');
      break;
    case 'open-settings':
      useShowStore.getState().setPanel('settings');
      break;
    default: {
      const exhaustive: never = command;
      throw new Error(`Unknown menu command ${String(exhaustive)}`);
    }
  }
}

/** Wires all operator-window side effects. Mount exactly once. */
export function useOperatorBridge(): void {
  useEffect(() => {
    const api = window.api;
    const stage = useStageStore.getState;
    const audio = useAudioStore.getState;

    const unsubscribers: Array<() => void> = [
      api.on('stage:state-update', (t) => stage().handleTelemetry(t)),
      api.on('stage:freeze-ack', (ack) => stage().handleFreezeAck(ack)),
      api.on('stage:media-error', (payload) => {
        stage().handleMediaError(payload);
        if (payload.layer === 'music') useAudioStore.setState({ isBgMusicPlaying: false });
      }),
      api.on('stage:foreground-ended', (payload) => stage().handleForegroundEnded(payload)),
      api.on('audio:state-update', (t) => audio().handleTelemetry(t)),
      api.on('display:changed', (status) => stage().setDisplayStatus(status)),
      api.on('stage:connected', (payload) => stage().handleStageConnection(payload)),
      api.on('menu:command', (command) => runMenuCommand(command)),
      api.on('audio:devices', (payload) => audio().handleDevices(payload)),
      api.on('remote:action', (event) => api.send('remote:ack', runRemoteAction(event))),
      api.on('remote:info', (info) => {
        const wasEnabled = usePrefsStore.getState().remoteInfo?.enabled ?? false;
        usePrefsStore.getState().setRemoteInfo(info);
        if (info.enabled && !wasEnabled) {
          lastStatusJson = '';
          queueRemoteStatus();
          queueRemoteCues();
        }
      }),
      api.on('drive:progress', (progress) => useDriveStore.getState().setProgress(progress)),
      api.on('web:offline-progress', (progress) => useMediaStore.getState().setOfflineProgress(progress)),
      api.on('app:update-status', (status) => {
        const before = useUpdateStore.getState().status?.state;
        useUpdateStore.getState().setStatus(status);
        if (status.state === 'ready' && before !== 'ready') {
          useShowStore
            .getState()
            .pushAlert(
              'success',
              `StageCue ${status.version ?? ''} is ready to install`,
              'It installs when you close StageCue, or press “Restart to update” in the header after the show.',
              false
            );
        }
      }),
      api.on('web:frame', (frame) => {
        const before = useWebStore.getState().frame?.page ?? null;
        useWebStore.getState().handleFrame(frame);
        // Phones show the flipbook's page number.
        if (frame.page !== before) queueRemoteStatus();
      }),
      api.on('remote:message', (message) => {
        useCrewStore.getState().addMessage(message);
        if (message.role !== 'av-room') {
          const urgent = message.kind === 'problem' || message.kind === 'hold';
          useShowStore
            .getState()
            .pushAlert(urgent ? 'warning' : 'info', `${message.role === 'stage' ? 'Stage team' : 'AV phone'} · ${message.from}`, message.text, urgent);
        }
      })
    ];

    // Restore the phone remote if it was left switched on.
    if (usePrefsStore.getState().remoteEnabled) void usePrefsStore.getState().configureRemote(true);

    // Phone remotes get a status push on every change (throttled) plus a 1 s heartbeat for countdowns.
    let lastStatusJson = '';
    let statusTimer: ReturnType<typeof setTimeout> | null = null;
    const pushRemoteStatus = (): void => {
      statusTimer = null;
      if (!usePrefsStore.getState().remoteInfo?.enabled) return;
      const status = buildRemoteStatus();
      const json = JSON.stringify(status);
      if (json === lastStatusJson) return;
      lastStatusJson = json;
      api.send('remote:status', status);
    };
    const queueRemoteStatus = (): void => {
      if (statusTimer === null) statusTimer = setTimeout(pushRemoteStatus, 250);
    };
    // Cue list (with thumbnails) is sent only when cues or thumbnails change.
    let cuesTimer: ReturnType<typeof setTimeout> | null = null;
    const pushRemoteCues = (): void => {
      cuesTimer = null;
      if (!usePrefsStore.getState().remoteInfo?.enabled) return;
      api.send('remote:cues', buildRemoteCues());
    };
    function queueRemoteCues(): void {
      if (cuesTimer === null) cuesTimer = setTimeout(pushRemoteCues, 400);
    }
    const unsubRemoteCues = useStageStore.subscribe((state, prev) => {
      if (state.cues !== prev.cues) queueRemoteCues();
    });
    const unsubRemoteMedia = useMediaStore.subscribe((state, prev) => {
      if (state.items !== prev.items) queueRemoteCues();
    });
    const remoteHeartbeat = window.setInterval(queueRemoteStatus, 1000);

    // Google Drive auto-sync: late performer uploads arrive without anyone pressing a button.
    const driveTimer = window.setInterval(() => {
      for (const source of useDriveStore.getState().dueSources(Date.now())) {
        void useDriveStore.getState().syncSource(source.id, 'auto');
      }
    }, 10_000);
    const unsubDrive = useDriveStore.subscribe((state, prev) => {
      if (state.sources !== prev.sources) scheduleAutosave();
    });
    const unsubRemoteStage = useStageStore.subscribe(queueRemoteStatus);

    // Captions, countdown and speaker timer: mirrored to the projector on every change,
    // to the podium phones through the status, and saved with the show.
    let lastOverlaysJson = '';
    const unsubOnAir = useOnAirStore.subscribe((state, prev) => {
      const overlays = state.overlays();
      const json = JSON.stringify(overlays);
      if (json !== lastOverlaysJson) {
        lastOverlaysJson = json;
        api.send('stage:overlays', overlays);
      }
      if (state.timer !== prev.timer) queueRemoteStatus();
      if (state.captions !== prev.captions || state.captionStyle !== prev.captionStyle) scheduleAutosave();
    });
    const unsubRemoteAudio = useAudioStore.subscribe((state, prev) => {
      if (state.telemetry?.isBgMusicPlaying !== prev.telemetry?.isBgMusicPlaying) queueRemoteStatus();
    });

    api
      .invoke('display:get-list')
      .then((status) => {
        if (!useStageStore.getState().displayStatus) stage().setDisplayStatus(status);
      })
      .catch((error: unknown) => {
        useShowStore
          .getState()
          .pushAlert('warning', 'Display detection failed', error instanceof Error ? error.message : String(error));
      });

    // The stage may have finished loading before this window subscribed.
    stage().fullSync();

    const actions: HotkeyAction[] = [
      'take',
      'freeze',
      'blackout',
      'instant-backdrop',
      'fade-audio',
      'next-cue',
      'prev-cue',
      'toggle-video',
      'toggle-follow',
      'page-next',
      'page-prev',
      'clicker-next',
      'clicker-prev'
    ];
    const hotkeys = new HotkeyManager(
      window,
      Object.fromEntries(actions.map((action) => [action, () => runOperatorAction(action)])),
      { isModalOpen: isAnyModalOpen, isClickerEnabled: () => usePrefsStore.getState().clickerEnabled }
    );
    hotkeys.attach();

    // Files dropped anywhere outside a specific drop zone are imported into the library.
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onWindowDrop = (event: DragEvent): void => {
      event.preventDefault();
      if ((event as DragEvent & { stagecueHandled?: boolean }).stagecueHandled) return;
      const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
      if (files.length > 0) void useMediaStore.getState().importDroppedFiles(files);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onWindowDrop);

    // Crash-recovery autosave + dirty flag mirrored to the main process (quit prompt).
    let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleAutosave = (): void => {
      if (autosaveTimer !== null) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        if (useShowStore.getState().isDirty) writeAutosave(currentShowSnapshot());
      }, AUTOSAVE_DEBOUNCE_MS);
    };
    let lastDirty = useShowStore.getState().isDirty;
    api.send('app:set-dirty', { dirty: lastDirty });
    const unsubShow = useShowStore.subscribe((state) => {
      if (state.isDirty !== lastDirty) {
        lastDirty = state.isDirty;
        api.send('app:set-dirty', { dirty: state.isDirty });
        if (state.isDirty) scheduleAutosave();
      }
    });
    const unsubCues = useStageStore.subscribe((state, prev) => {
      if (state.cues !== prev.cues || state.autoFollowEnabled !== prev.autoFollowEnabled) scheduleAutosave();
    });
    const unsubMedia = useMediaStore.subscribe((state, prev) => {
      if (state.items !== prev.items || state.folders !== prev.folders) scheduleAutosave();
    });

    return () => {
      unsubscribers.forEach((off) => off());
      hotkeys.detach();
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onWindowDrop);
      unsubShow();
      unsubCues();
      unsubMedia();
      unsubRemoteStage();
      unsubOnAir();
      unsubRemoteAudio();
      unsubRemoteCues();
      unsubRemoteMedia();
      window.clearInterval(remoteHeartbeat);
      window.clearInterval(driveTimer);
      unsubDrive();
      if (statusTimer !== null) clearTimeout(statusTimer);
      if (cuesTimer !== null) clearTimeout(cuesTimer);
      if (autosaveTimer !== null) clearTimeout(autosaveTimer);
    };
  }, []);
}

/** Marks a drop event as consumed by a component-level drop zone. */
export function markDropHandled(event: { nativeEvent: Event }): void {
  (event.nativeEvent as Event & { stagecueHandled?: boolean }).stagecueHandled = true;
}
