import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type FileFilter,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron';
import {
  OPERATOR_TO_STAGE_CHANNELS,
  STAGE_TO_OPERATOR_CHANNELS,
  type ExpandedPaths,
  type FolderScanResult,
  type InvokeContracts,
  type MediaDialogOptions,
  type MediaPathRequest,
  type FileMediaType,
  type ReceivePayloads,
  type CrewMessageRequest,
  type DriveInspectRequest,
  type DriveSource,
  type DriveSyncRequest,
  type DriveSyncResult,
  type RemoteAck,
  type RemoteConfigRequest,
  type RemoteCue,
  type RemoteInfo,
  type RemoteStatus,
  type ResolvedMediaFile,
  type RunSheetExportResult,
  type ShowOpenResult,
  type ShowSaveRequest,
  type ShowSaveResult,
  type StageConnectionPayload
} from '../renderer/src/types';
import type { DisplayManager } from './displayManager';
import { expandMediaPaths, scanMediaFolder } from './mediaScanner';
import { isPdfCacheRequest, isPdfCacheStoreRequest, lookupCachedPage, storeCachedPage } from './pdfCache';
import { DriveClient, parseDriveFolderLink, safeFileName, syncDriveSource } from './driveSync';
import { convertPresentation, isPresentationPath } from './presentationConverter';
import { normalizeInternet, normalizePermissions, type RemoteServer } from './remoteServer';
import { exportRunSheet, isRunSheetRequest } from './runSheetExporter';
import { isMediaPathAllowed, MEDIA_EXTENSIONS, resolveMediaFile } from './protocolHandler';
import {
  inspectWebPage,
  isCaptureResolveRequest,
  listCaptureSources,
  parseWebInput,
  resolveCaptureSource,
  type WebStageController
} from './webStage';

export interface WindowRegistry {
  getOperatorWindow(): BrowserWindow | null;
  getStageWindow(): BrowserWindow | null;
}

export interface IpcHandlerHooks {
  onDirtyChange(dirty: boolean): void;
  onStageReady(): void;
  /** Folder where rendered PDF pages are cached. */
  renderCacheDir: string;
  /** Scratch folder for run-sheet rendering. */
  tempDir: string;
  remote: RemoteServer;
  /** Set only by the E2E suite: run sheets are written here without a dialog. */
  e2eOutputDir: string | null;
  /** Default parent folder for Drive downloads (Documents). */
  documentsDir: string;
  /** Overrides for Google endpoints (automated tests only). */
  driveEndpoints: { apiBase?: string; pageBase?: string; downloadBase?: string };
  /** Live web pages on stage (flipbooks): operator picture + input forwarding. */
  web: WebStageController;
}

const MAX_SHOW_FILE_BYTES = 20 * 1024 * 1024;
const MAX_METADATA_BATCH = 2000;

function isAlive(win: BrowserWindow | null): win is BrowserWindow {
  return win !== null && !win.isDestroyed() && !win.webContents.isDestroyed();
}

function isSender(event: IpcMainEvent | IpcMainInvokeEvent, win: BrowserWindow | null): boolean {
  return isAlive(win) && event.sender === win.webContents;
}

export function sendToWindow<C extends keyof ReceivePayloads>(
  win: BrowserWindow | null,
  channel: C,
  payload: ReceivePayloads[C]
): void {
  if (isAlive(win)) win.webContents.send(channel, payload);
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

function stripDot(ext: string): string {
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

const TYPE_LABELS: Record<FileMediaType, string> = {
  image: 'Backdrops & Posters',
  video: 'Videos',
  audio: 'Background Tracks'
};

export function buildMediaFilters(types: FileMediaType[]): FileFilter[] {
  const selected: FileMediaType[] = types.length > 0 ? types : ['image', 'video', 'audio'];
  const all = selected.flatMap((t) => MEDIA_EXTENSIONS[t].map(stripDot));
  const filters: FileFilter[] = [{ name: 'All supported media', extensions: all }];
  for (const type of selected) {
    filters.push({ name: TYPE_LABELS[type], extensions: MEDIA_EXTENSIONS[type].map(stripDot) });
  }
  return filters;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'Untitled Show';
}

function isMediaDialogOptions(value: unknown): value is MediaDialogOptions {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MediaDialogOptions>;
  return Array.isArray(candidate.types) && typeof candidate.multiSelections === 'boolean';
}

function isPathRequestArray(value: unknown): value is MediaPathRequest[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_METADATA_BATCH &&
    value.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as MediaPathRequest).filePath === 'string' &&
        (r as MediaPathRequest).filePath.length > 0
    )
  );
}

function isShowSaveRequest(value: unknown): value is ShowSaveRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ShowSaveRequest>;
  return (
    typeof candidate.show === 'object' &&
    candidate.show !== null &&
    Array.isArray(candidate.show.media) &&
    Array.isArray(candidate.show.cues) &&
    typeof candidate.saveAs === 'boolean'
  );
}

/**
 * Registers every IPC route. Operator → Stage and Stage → Operator traffic is
 * relayed verbatim (sub-millisecond hop) after verifying the sending window.
 * Returns a disposer that removes all handlers.
 */
export function registerIpcHandlers(
  registry: WindowRegistry,
  displayManager: DisplayManager,
  hooks: IpcHandlerHooks
): () => void {
  const disposers: Array<() => void> = [];
  const knownShowPaths = new Set<string>();

  const listen = (channel: string, handler: (event: IpcMainEvent, payload: unknown) => void): void => {
    ipcMain.on(channel, handler);
    disposers.push(() => ipcMain.removeListener(channel, handler));
  };

  const handle = <C extends keyof InvokeContracts>(
    channel: C,
    allowStage: boolean,
    handler: (
      event: IpcMainInvokeEvent,
      ...args: unknown[]
    ) => Promise<InvokeContracts[C]['result']> | InvokeContracts[C]['result']
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const fromOperator = isSender(event, registry.getOperatorWindow());
      const fromStage = isSender(event, registry.getStageWindow());
      if (!fromOperator && !(allowStage && fromStage)) {
        throw new Error(`Unauthorized sender for ${channel}`);
      }
      return handler(event, ...args);
    });
    disposers.push(() => ipcMain.removeHandler(channel));
  };

  /* ------------------------- Operator → Stage relay ------------------------ */
  for (const channel of OPERATOR_TO_STAGE_CHANNELS) {
    listen(channel, (event, payload) => {
      if (!isSender(event, registry.getOperatorWindow())) return;
      sendToWindow(registry.getStageWindow(), channel, payload as ReceivePayloads[typeof channel]);
    });
  }

  /* ------------------------- Stage → Operator relay ------------------------ */
  for (const channel of STAGE_TO_OPERATOR_CHANNELS) {
    listen(channel, (event, payload) => {
      if (!isSender(event, registry.getStageWindow())) return;
      sendToWindow(registry.getOperatorWindow(), channel, payload as ReceivePayloads[typeof channel]);
    });
  }

  /* ----------------------------- Main-bound ------------------------------- */
  listen('stage:ready', (event) => {
    const stage = registry.getStageWindow();
    if (!isSender(event, stage)) return;
    sendToWindow(stage, 'display:changed', displayManager.getStatus());
    const connection: StageConnectionPayload = { connected: true, reason: 'ready', at: Date.now() };
    sendToWindow(registry.getOperatorWindow(), 'stage:connected', connection);
    hooks.onStageReady();
  });

  listen('app:set-dirty', (event, payload) => {
    if (!isSender(event, registry.getOperatorWindow())) return;
    const dirty = typeof payload === 'object' && payload !== null && (payload as { dirty?: unknown }).dirty === true;
    hooks.onDirtyChange(dirty);
  });

  listen('remote:status', (event, payload) => {
    if (!isSender(event, registry.getOperatorWindow())) return;
    if (typeof payload !== 'object' || payload === null) return;
    hooks.remote.updateStatus(payload as RemoteStatus);
  });

  listen('remote:cues', (event, payload) => {
    if (!isSender(event, registry.getOperatorWindow()) || !Array.isArray(payload)) return;
    hooks.remote.updateCues(payload as RemoteCue[]);
  });

  listen('remote:ack', (event, payload) => {
    if (!isSender(event, registry.getOperatorWindow())) return;
    const ack = payload as Partial<RemoteAck>;
    if (typeof ack?.requestId !== 'string' || typeof ack.ok !== 'boolean') return;
    hooks.remote.resolveAck({ requestId: ack.requestId, ok: ack.ok, message: typeof ack.message === 'string' ? ack.message : '' });
  });

  listen('remote:send-message', (event, payload) => {
    if (!isSender(event, registry.getOperatorWindow())) return;
    const request = payload as Partial<CrewMessageRequest>;
    if (typeof request?.text !== 'string') return;
    const sent = hooks.remote.sendCrewMessage({
      kind: request.kind ?? 'reply',
      text: request.text,
      to: typeof request.to === 'string' ? request.to : null
    });
    if (sent) sendToWindow(registry.getOperatorWindow(), 'remote:message', sent);
  });

  /* ------------------------ Web pages & screen capture -------------------- */
  listen('stage:web-live', (event, payload) => {
    if (!isSender(event, registry.getStageWindow())) return;
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    hooks.web.setLive({
      mediaId: typeof p.mediaId === 'string' ? p.mediaId : null,
      takeId: typeof p.takeId === 'number' ? p.takeId : 0,
      webContentsId: typeof p.webContentsId === 'number' && Number.isInteger(p.webContentsId) ? p.webContentsId : null,
      homeUrl: typeof p.homeUrl === 'string' ? p.homeUrl : null
    });
  });

  listen('web:input', (event, payload) => {
    if (!isSender(event, registry.getOperatorWindow())) return;
    const input = parseWebInput(payload);
    if (input) hooks.web.handleInput(input);
  });

  handle('stage:capture-web', true, () => hooks.web.captureFull());

  handle('web:inspect', false, async (_event, request) => {
    const r = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
    return inspectWebPage({ url: typeof r.url === 'string' ? r.url : '', snapshot: r.snapshot === true });
  });

  handle('capture:list-sources', false, () => listCaptureSources());

  handle('capture:resolve', true, async (_event, request) => {
    if (!isCaptureResolveRequest(request)) throw new Error('Invalid capture request');
    return resolveCaptureSource(request);
  });

  /* ---------------------------- Remote & print ---------------------------- */
  handle('remote:configure', false, async (_event, request): Promise<RemoteInfo> => {
    if (typeof request !== 'object' || request === null) throw new Error('Invalid remote configuration');
    const r = request as Partial<RemoteConfigRequest>;
    return hooks.remote.configure({
      enabled: r.enabled === true,
      port: typeof r.port === 'number' ? r.port : 0,
      operatorToken: typeof r.operatorToken === 'string' ? r.operatorToken : undefined,
      stageToken: typeof r.stageToken === 'string' ? r.stageToken : undefined,
      regenerate: r.regenerate === true,
      stagePermissions: normalizePermissions(r.stagePermissions),
      stageLocked: r.stageLocked === true,
      internet: normalizeInternet(r.internet)
    });
  });

  handle('app:open-hotspot-settings', false, async (): Promise<boolean> => {
    const target =
      process.platform === 'win32'
        ? 'ms-settings:network-mobilehotspot'
        : process.platform === 'darwin'
          ? 'x-apple.systempreferences:com.apple.preferences.sharing'
          : null;
    if (!target) return false;
    await shell.openExternal(target);
    return true;
  });

  /* ----------------------------- Google Drive ----------------------------- */
  const driveSyncs = new Map<string, Promise<DriveSyncResult>>();
  const driveClient = (apiKey: unknown): DriveClient =>
    new DriveClient({
      apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null,
      ...hooks.driveEndpoints
    });

  handle('drive:inspect', false, async (_event, raw): Promise<DriveSource> => {
    const request = (raw ?? {}) as Partial<DriveInspectRequest>;
    const link = typeof request.url === 'string' ? parseDriveFolderLink(request.url) : null;
    if (!link) throw new Error('Paste a Google Drive folder link (drive.google.com/drive/folders/…)');
    const name = await driveClient(request.apiKey).folderName(link);
    const localPath =
      typeof request.localDir === 'string' && path.isAbsolute(request.localDir)
        ? request.localDir
        : path.join(hooks.documentsDir, 'StageCue Drive', safeFileName(name));
    await fsp.mkdir(localPath, { recursive: true });
    return {
      id: randomUUID(),
      url: String(request.url).trim(),
      folderId: link.folderId,
      ...(link.resourceKey ? { resourceKey: link.resourceKey } : {}),
      name,
      localPath
    };
  });

  handle('drive:sync', false, async (event, raw): Promise<DriveSyncResult> => {
    const request = (raw ?? {}) as Partial<DriveSyncRequest>;
    const source = request.source;
    if (
      !source ||
      typeof source.id !== 'string' ||
      typeof source.folderId !== 'string' ||
      !/^[A-Za-z0-9_-]{10,}$/.test(source.folderId) ||
      typeof source.localPath !== 'string' ||
      !path.isAbsolute(source.localPath)
    ) {
      throw new Error('Invalid Drive source');
    }
    const running = driveSyncs.get(source.id);
    if (running) return running;
    const job = syncDriveSource(source, driveClient(request.apiKey), (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('drive:progress', progress);
    }).finally(() => driveSyncs.delete(source.id));
    driveSyncs.set(source.id, job);
    return job;
  });

  handle('drive:choose-folder', false, async (): Promise<string | null> => {
    const operator = registry.getOperatorWindow();
    const options: OpenDialogOptions = {
      title: 'Where should performer tracks be saved?',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    };
    const result = isAlive(operator) ? await dialog.showOpenDialog(operator, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  handle('drive:open-folder', false, async (_event, localPath): Promise<boolean> => {
    if (typeof localPath !== 'string' || !path.isAbsolute(localPath)) return false;
    try {
      if (!(await fsp.stat(localPath)).isDirectory()) return false;
    } catch {
      return false;
    }
    return (await shell.openPath(localPath)) === '';
  });

  handle('media:convert-presentation', false, async (_event, filePath): Promise<ResolvedMediaFile> => {
    if (typeof filePath !== 'string' || !isPresentationPath(filePath) || !isMediaPathAllowed(filePath)) {
      throw new Error('Import the presentation first');
    }
    const pdfPath = await convertPresentation(filePath, hooks.renderCacheDir);
    return resolveMediaFile({ filePath: pdfPath });
  });

  handle('runsheet:export', false, async (_event, request): Promise<RunSheetExportResult> => {
    if (!isRunSheetRequest(request)) return { ok: false, canceled: false, error: 'Invalid run sheet' };
    return exportRunSheet(request, registry.getOperatorWindow(), hooks.tempDir, hooks.e2eOutputDir);
  });

  /* ------------------------------- Displays ------------------------------- */
  handle('display:get-list', true, () => displayManager.getStatus());

  handle('display:set-stage-target', false, (_event, displayId) => {
    const id = typeof displayId === 'number' && Number.isFinite(displayId) ? displayId : null;
    return displayManager.setPreferredStageDisplay(id);
  });

  handle('display:raise-stage', false, () => {
    const stage = registry.getStageWindow();
    if (!isAlive(stage)) return false;
    stage.showInactive();
    stage.moveTop();
    return true;
  });

  /* -------------------------------- Media --------------------------------- */
  handle('media:open-file-dialog', false, async (_event, rawOptions): Promise<ResolvedMediaFile[]> => {
    const options: MediaDialogOptions = isMediaDialogOptions(rawOptions)
      ? rawOptions
      : { types: ['image', 'video', 'audio'], multiSelections: true };
    const properties: OpenDialogOptions['properties'] = options.multiSelections
      ? ['openFile', 'multiSelections']
      : ['openFile'];
    const dialogOptions: OpenDialogOptions = {
      title: 'Import media into StageCue AV',
      buttonLabel: 'Import',
      properties,
      filters: buildMediaFilters(options.types)
    };
    const operator = registry.getOperatorWindow();
    const result = isAlive(operator)
      ? await dialog.showOpenDialog(operator, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return [];
    return Promise.all(result.filePaths.map((filePath) => resolveMediaFile({ filePath })));
  });

  handle('media:read-metadata', false, async (_event, rawRequests): Promise<ResolvedMediaFile[]> => {
    if (!isPathRequestArray(rawRequests)) {
      throw new Error('media:read-metadata expects an array of { filePath } requests');
    }
    return Promise.all(rawRequests.map((request) => resolveMediaFile(request)));
  });

  handle('media:open-folder-dialog', false, async (): Promise<FolderScanResult | null> => {
    const operator = registry.getOperatorWindow();
    const dialogOptions: OpenDialogOptions = {
      title: 'Import an event folder',
      buttonLabel: 'Import Folder',
      properties: ['openDirectory']
    };
    const result = isAlive(operator)
      ? await dialog.showOpenDialog(operator, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return scanMediaFolder(result.filePaths[0]);
  });

  handle('media:scan-folder', false, async (_event, folderPath): Promise<FolderScanResult> => {
    if (typeof folderPath !== 'string' || folderPath.length === 0) {
      throw new Error('media:scan-folder expects a folder path');
    }
    return scanMediaFolder(folderPath);
  });

  handle('media:expand-paths', false, async (_event, rawPaths): Promise<ExpandedPaths> => {
    if (
      !Array.isArray(rawPaths) ||
      rawPaths.length > MAX_METADATA_BATCH ||
      !rawPaths.every((p): p is string => typeof p === 'string' && p.length > 0)
    ) {
      throw new Error('media:expand-paths expects an array of paths');
    }
    return expandMediaPaths(rawPaths);
  });

  handle('media:pdf-cache-lookup', false, async (_event, request): Promise<ResolvedMediaFile | null> => {
    if (!isPdfCacheRequest(request)) throw new Error('Invalid PDF cache request');
    return lookupCachedPage(hooks.renderCacheDir, request);
  });

  handle('media:pdf-cache-store', false, async (_event, request): Promise<ResolvedMediaFile> => {
    if (!isPdfCacheStoreRequest(request)) throw new Error('Invalid rendered PDF page');
    return storeCachedPage(hooks.renderCacheDir, request);
  });

  /* --------------------------------- Shows -------------------------------- */
  handle('show:save', false, async (_event, rawRequest): Promise<ShowSaveResult> => {
    if (!isShowSaveRequest(rawRequest)) {
      return { ok: false, canceled: false, error: 'Invalid show payload' };
    }
    const request = rawRequest;
    try {
      let target: string | null =
        request.filePath && !request.saveAs && knownShowPaths.has(pathKey(request.filePath))
          ? request.filePath
          : null;

      if (!target) {
        const operator = registry.getOperatorWindow();
        const saveOptions = {
          title: 'Save StageCue show',
          buttonLabel: 'Save Show',
          defaultPath: request.filePath ?? `${sanitizeFileName(request.show.name)}.stagecue.json`,
          filters: [{ name: 'StageCue Show', extensions: ['json'] }]
        };
        const result = isAlive(operator)
          ? await dialog.showSaveDialog(operator, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        target = result.filePath;
      }

      const dir = path.dirname(target);
      const savedAt = new Date().toISOString();
      const show = {
        ...request.show,
        savedAt,
        media: request.show.media.map((m) => ({
          ...m,
          // Web pages and window captures are not files: nothing to resolve relative to the show.
          ...(m.type === 'web' || m.type === 'screen' ? {} : { relativePath: path.relative(dir, m.filePath) }),
          ...(m.pdf
            ? {
                pdf: {
                  ...m.pdf,
                  relativeSourcePath: path.relative(dir, m.pdf.sourcePath),
                  ...(m.pdf.originalPath ? { relativeOriginalPath: path.relative(dir, m.pdf.originalPath) } : {})
                }
              }
            : {})
        }))
      };
      const tmp = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(show, null, 2), 'utf8');
      await fsp.rename(tmp, target);
      knownShowPaths.add(pathKey(target));
      return { ok: true, filePath: target, savedAt };
    } catch (error) {
      return { ok: false, canceled: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  handle('show:open', false, async (): Promise<ShowOpenResult | null> => {
    const operator = registry.getOperatorWindow();
    const openOptions: OpenDialogOptions = {
      title: 'Open StageCue show',
      buttonLabel: 'Open Show',
      properties: ['openFile'],
      filters: [{ name: 'StageCue Show', extensions: ['json'] }]
    };
    const result = isAlive(operator)
      ? await dialog.showOpenDialog(operator, openOptions)
      : await dialog.showOpenDialog(openOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const stat = await fsp.stat(filePath);
    if (stat.size > MAX_SHOW_FILE_BYTES) {
      throw new Error('Show file is larger than 20 MB and was not opened.');
    }
    const content = await fsp.readFile(filePath, 'utf8');
    knownShowPaths.add(pathKey(filePath));
    return { filePath, baseDir: path.dirname(filePath), content };
  });

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
