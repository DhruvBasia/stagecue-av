import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  powerSaveBlocker,
  screen,
  session,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron';
import type { DisplayStatus, MenuCommand, StageConnectionPayload } from '../renderer/src/types';
import {
  applyPlacementToWindow,
  DisplayManager,
  type ScreenLike,
  type StagePlacement
} from './displayManager';
import { registerIpcHandlers, sendToWindow } from './ipcHandlers';
import { registerMediaProtocol, registerMediaSchemePrivileges } from './protocolHandler';
import { RemoteServer } from './remoteServer';
import { AppUpdater, type UpdaterLike } from './updater';
import { configureWebSession, hardenGuest, sanitizeWebview, WebStageController } from './webStage';

/* ------------------------------------------------------------------------ */
/* Process-level configuration (must run before `ready`).                    */
/* ------------------------------------------------------------------------ */

registerMediaSchemePrivileges();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const isE2E = process.env.STAGECUE_E2E === '1' || process.argv.includes('--stagecue-e2e');
const rendererDevUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
const isMac = process.platform === 'darwin';

let operatorWindow: BrowserWindow | null = null;
let stageWindow: BrowserWindow | null = null;
let displayManager: DisplayManager | null = null;
let disposeIpc: (() => void) | null = null;
let powerBlockerId: number | null = null;
let showDirty = false;
let quitConfirmed = false;
let quitPromptOpen = false;
let stageRecreateTimer: ReturnType<typeof setTimeout> | null = null;
let remoteServer: RemoteServer = new RemoteServer({ onAction: () => undefined, onMessage: () => undefined });
const webStage = new WebStageController({ sendFrame: (frame) => sendToWindow(operatorWindow, 'web:frame', frame) });
// Self-update only in the installed app (tests can opt in to exercise it against the real releases).
const appUpdater = new AppUpdater({
  currentVersion: app.getVersion(),
  enabled: app.isPackaged && (!isE2E || process.env.STAGECUE_E2E_UPDATER === '1'),
  loadUpdater: async () => {
    const mod = (await import('electron-updater')) as unknown as { autoUpdater?: UpdaterLike; default?: { autoUpdater: UpdaterLike } };
    const updater = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!updater) throw new Error('Updater unavailable');
    return updater;
  },
  onStatus: (status) => sendToWindow(operatorWindow, 'app:update-status', status),
  onBeforeInstall: () => {
    quitConfirmed = true;
  }
});

/* ------------------------------------------------------------------------ */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------ */

function preloadPath(): string {
  return join(__dirname, '../preload/index.js');
}

function loadPage(win: BrowserWindow, page: 'index' | 'stage'): void {
  const load = rendererDevUrl
    ? win.loadURL(`${rendererDevUrl}/${page}.html`)
    : win.loadFile(join(__dirname, `../renderer/${page}.html`));
  load.catch((error: unknown) => {
    console.error(`[StageCue] Failed to load ${page}.html`, error);
  });
}

function hardenWebContents(contents: WebContents, allowWebPages = false): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  if (allowWebPages) {
    // Only the stage may embed web pages (web-page cues), sandboxed in their own session.
    contents.on('will-attach-webview', sanitizeWebview);
    contents.on('did-attach-webview', (_event, guest) => hardenGuest(guest));
  } else {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  }
}

function notifyOperatorStageConnection(payload: StageConnectionPayload): void {
  sendToWindow(operatorWindow, 'stage:connected', payload);
}

function broadcastDisplayStatus(status: DisplayStatus): void {
  sendToWindow(operatorWindow, 'display:changed', status);
  sendToWindow(stageWindow, 'display:changed', status);
}

function sendMenuCommand(command: MenuCommand): void {
  sendToWindow(operatorWindow, 'menu:command', command);
}

/** Keeps the operator console off the projector after hot-plug events. */
function keepOperatorOffProjector(placement: StagePlacement): void {
  if (!operatorWindow || operatorWindow.isDestroyed() || placement.mode !== 'projector') return;
  const current = screen.getDisplayMatching(operatorWindow.getBounds());
  if (current.id !== placement.displayId) return;
  const target = screen.getAllDisplays().find((d) => d.id === placement.operatorDisplayId);
  if (!target) return;
  const wasMaximized = operatorWindow.isMaximized();
  if (wasMaximized) operatorWindow.unmaximize();
  const width = Math.min(operatorWindow.getBounds().width, target.workArea.width);
  const height = Math.min(operatorWindow.getBounds().height, target.workArea.height);
  operatorWindow.setBounds({
    x: target.workArea.x + Math.round((target.workArea.width - width) / 2),
    y: target.workArea.y + Math.round((target.workArea.height - height) / 2),
    width,
    height
  });
  if (wasMaximized) operatorWindow.maximize();
}

function handlePlacementChange(placement: StagePlacement, status: DisplayStatus): void {
  if (stageWindow && !stageWindow.isDestroyed()) {
    applyPlacementToWindow(stageWindow, placement, process.platform);
  }
  keepOperatorOffProjector(placement);
  broadcastDisplayStatus(status);
  if (operatorWindow && !operatorWindow.isDestroyed() && !operatorWindow.isFocused() && placement.mode === 'docked') {
    operatorWindow.focus();
  }
}

/* ------------------------------------------------------------------------ */
/* Quit confirmation                                                          */
/* ------------------------------------------------------------------------ */

function requestQuit(): void {
  if (quitConfirmed || isE2E) {
    quitConfirmed = true;
    app.quit();
    return;
  }
  if (quitPromptOpen) return;
  quitPromptOpen = true;
  const options = {
    type: 'warning' as const,
    buttons: ['Keep Running', 'Quit StageCue AV'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Quit StageCue AV?',
    message: showDirty ? 'The show has unsaved changes. Quit anyway?' : 'Quit StageCue AV?',
    detail: 'The projector output will close immediately and the audience will see the desktop.'
  };
  const choice =
    operatorWindow && !operatorWindow.isDestroyed()
      ? dialog.showMessageBoxSync(operatorWindow, options)
      : dialog.showMessageBoxSync(options);
  quitPromptOpen = false;
  if (choice === 1) {
    quitConfirmed = true;
    app.quit();
  }
}

/* ------------------------------------------------------------------------ */
/* Windows                                                                    */
/* ------------------------------------------------------------------------ */

function createOperatorWindow(manager: DisplayManager): BrowserWindow {
  const area = manager.getOperatorWorkArea();
  const width = Math.min(1600, area.width);
  const height = Math.min(980, area.height);

  const win = new BrowserWindow({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
    minWidth: Math.min(1100, area.width),
    minHeight: Math.min(680, area.height),
    show: false,
    backgroundColor: '#0d1117',
    title: 'StageCue AV — Operator',
    autoHideMenuBar: false,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: ['--stagecue-role=operator', ...(isE2E ? ['--stagecue-e2e'] : [])]
    }
  });

  hardenWebContents(win.webContents);
  win.webContents.on('did-finish-load', () => sendToWindow(win, 'app:update-status', appUpdater.getStatus()));

  win.once('ready-to-show', () => {
    if (area.width <= 1680 || area.height <= 1000) win.maximize();
    win.show();
    win.focus();
  });

  win.on('close', (event) => {
    if (quitConfirmed || isE2E) return;
    event.preventDefault();
    requestQuit();
  });

  win.on('closed', () => {
    operatorWindow = null;
    if (stageWindow && !stageWindow.isDestroyed()) stageWindow.destroy();
  });

  loadPage(win, 'index');
  return win;
}

function createStageWindow(placement: StagePlacement): BrowserWindow {
  const projector = placement.mode === 'projector';

  const win = new BrowserWindow({
    ...placement.bounds,
    show: false,
    frame: false,
    fullscreen: projector && !isMac,
    alwaysOnTop: placement.alwaysOnTop,
    focusable: false,
    skipTaskbar: true,
    resizable: !projector,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: true,
    hasShadow: !projector,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    title: 'StageCue AV — Stage Output',
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      webviewTag: true,
      additionalArguments: ['--stagecue-role=stage', ...(isE2E ? ['--stagecue-e2e'] : [])]
    }
  });

  hardenWebContents(win.webContents, true);
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.once('ready-to-show', () => {
    const current = displayManager ? displayManager.getPlacement() : placement;
    applyPlacementToWindow(win, current, process.platform);
    if (operatorWindow && !operatorWindow.isDestroyed()) operatorWindow.focus();
  });

  win.on('close', (event) => {
    if (quitConfirmed || isE2E || !operatorWindow) return;
    event.preventDefault();
  });

  win.on('closed', () => {
    if (stageWindow === win) stageWindow = null;
  });

  win.on('unresponsive', () => {
    notifyOperatorStageConnection({ connected: false, reason: 'unresponsive', at: Date.now() });
  });

  win.on('responsive', () => {
    notifyOperatorStageConnection({ connected: true, reason: 'responsive', at: Date.now() });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[StageCue] Stage renderer gone:', details.reason);
    notifyOperatorStageConnection({ connected: false, reason: 'crashed', at: Date.now() });
    if (quitConfirmed) return;
    if (stageRecreateTimer !== null) clearTimeout(stageRecreateTimer);
    stageRecreateTimer = setTimeout(() => {
      stageRecreateTimer = null;
      recreateStageWindow();
    }, 400);
  });

  loadPage(win, 'stage');
  return win;
}

function recreateStageWindow(): void {
  if (!displayManager) return;
  if (stageWindow && !stageWindow.isDestroyed()) stageWindow.destroy();
  stageWindow = createStageWindow(displayManager.getPlacement());
}

/* ------------------------------------------------------------------------ */
/* Menu                                                                       */
/* ------------------------------------------------------------------------ */

function buildMenu(): Menu {
  const isDev = !app.isPackaged;
  const fileMenu: MenuItemConstructorOptions[] = [
    { label: 'New Show', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new-show') },
    { label: 'Open Show…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('open-show') },
    { label: 'Save Show', accelerator: 'CmdOrCtrl+S', click: () => sendMenuCommand('save-show') },
    { label: 'Save Show As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuCommand('save-show-as') },
    { type: 'separator' },
    { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: () => sendMenuCommand('import-media') },
    { label: 'Import Folder…', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendMenuCommand('import-folder') },
    { type: 'separator' },
    { label: 'Pre-show Check…', accelerator: 'CmdOrCtrl+Shift+C', click: () => sendMenuCommand('preshow-check') },
    { label: 'Export Run Sheet (PDF)…', accelerator: 'CmdOrCtrl+E', click: () => sendMenuCommand('export-runsheet') },
    { label: 'Print Run Sheet…', accelerator: 'CmdOrCtrl+P', click: () => sendMenuCommand('print-runsheet') },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuCommand('open-settings') },
    { type: 'separator' },
    { label: isMac ? 'Close Window' : 'Quit', accelerator: isMac ? 'Cmd+W' : 'Ctrl+Q', click: () => requestQuit() }
  ];

  const viewMenu: MenuItemConstructorOptions[] = [
    ...(isDev
      ? ([{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }] as MenuItemConstructorOptions[])
      : []),
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' }
  ];

  const stageMenu: MenuItemConstructorOptions[] = [
    {
      label: 'Bring Stage Window to Front',
      click: () => {
        if (stageWindow && !stageWindow.isDestroyed()) {
          stageWindow.showInactive();
          stageWindow.moveTop();
        }
      }
    },
    { label: 'Re-detect Displays', click: () => displayManager?.refresh('manual') },
    { type: 'separator' },
    { label: 'Reload Stage Output', click: () => recreateStageWindow() },
    {
      label: 'Toggle Stage DevTools',
      visible: isDev,
      click: () => {
        if (stageWindow && !stageWindow.isDestroyed()) stageWindow.webContents.toggleDevTools();
      }
    }
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { label: 'File', submenu: fileMenu },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    { label: 'View', submenu: viewMenu },
    { label: 'Stage', submenu: stageMenu }
  ];

  return Menu.buildFromTemplate(template);
}

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                  */
/* ------------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  await app.whenReady();

  registerMediaProtocol();
  configureWebSession();

  const isOwnWindow = (contents: WebContents | null): boolean =>
    contents !== null &&
    ((operatorWindow !== null && !operatorWindow.isDestroyed() && contents === operatorWindow.webContents) ||
      (stageWindow !== null && !stageWindow.isDestroyed() && contents === stageWindow.webContents));

  // Our own windows may pick an audio output device (names are listed via enumerateDevices).
  const ownWindowPermissions = new Set(['speaker-selection', 'clipboard-sanitized-write']);
  const isStage = (contents: WebContents | null): boolean =>
    contents !== null && stageWindow !== null && !stageWindow.isDestroyed() && contents === stageWindow.webContents;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    // Window/screen-share cues: the stage captures a window picked by the operator. Chromium asks for desktop
    // capture with an empty media-type list; camera and microphone requests list 'video'/'audio' and are refused.
    if (permission === 'media') {
      const mediaTypes = 'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
      callback(isStage(contents) && mediaTypes.length === 0);
      return;
    }
    callback(permission === 'fullscreen' || (ownWindowPermissions.has(permission) && isOwnWindow(contents)));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    if (!isOwnWindow(contents)) return false;
    return permission === 'media' || permission === 'fullscreen' || ownWindowPermissions.has(permission);
  });

  remoteServer = new RemoteServer({
    onAction: (event) => sendToWindow(operatorWindow, 'remote:action', event),
    onMessage: (message) => sendToWindow(operatorWindow, 'remote:message', message),
    onInfoChange: (info) => sendToWindow(operatorWindow, 'remote:info', info)
  });

  const manager = new DisplayManager(screen as unknown as ScreenLike, {
    onPlacementChange: handlePlacementChange
  });
  displayManager = manager;

  disposeIpc = registerIpcHandlers(
    {
      getOperatorWindow: () => operatorWindow,
      getStageWindow: () => stageWindow
    },
    manager,
    {
      renderCacheDir: join(app.getPath('userData'), 'render-cache'),
      tempDir: app.getPath('temp'),
      remote: remoteServer,
      e2eOutputDir: isE2E && process.env.STAGECUE_E2E_OUTPUT ? process.env.STAGECUE_E2E_OUTPUT : null,
      documentsDir: app.getPath('documents'),
      driveEndpoints:
        isE2E && process.env.STAGECUE_DRIVE_BASE
          ? {
              apiBase: `${process.env.STAGECUE_DRIVE_BASE}/drive/v3`,
              pageBase: process.env.STAGECUE_DRIVE_BASE,
              downloadBase: process.env.STAGECUE_DRIVE_BASE
            }
          : {},
      web: webStage,
      updater: appUpdater,
      onDirtyChange: (dirty) => {
        showDirty = dirty;
        if (operatorWindow && !operatorWindow.isDestroyed()) operatorWindow.setDocumentEdited(dirty);
      },
      onStageReady: () => {
        if (stageWindow && !stageWindow.isDestroyed()) {
          applyPlacementToWindow(stageWindow, manager.getPlacement(), process.platform);
        }
      }
    }
  );

  Menu.setApplicationMenu(buildMenu());

  operatorWindow = createOperatorWindow(manager);
  stageWindow = createStageWindow(manager.getPlacement());
  manager.start();

  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  appUpdater.start();

  app.on('activate', () => {
    if (!operatorWindow) operatorWindow = createOperatorWindow(manager);
    if (!stageWindow) stageWindow = createStageWindow(manager.getPlacement());
  });
}

const hasLock = isE2E ? true : app.requestSingleInstanceLock();

if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!operatorWindow) return;
    if (operatorWindow.isMinimized()) operatorWindow.restore();
    operatorWindow.focus();
  });

  app.on('before-quit', (event) => {
    if (quitConfirmed || isE2E) return;
    event.preventDefault();
    requestQuit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    displayManager?.stop();
    disposeIpc?.();
    void remoteServer.stop();
    webStage.stop();
    appUpdater.stop();
    if (stageRecreateTimer !== null) clearTimeout(stageRecreateTimer);
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
  });

  bootstrap().catch((error: unknown) => {
    console.error('[StageCue] Fatal startup error', error);
    dialog.showErrorBox('StageCue AV failed to start', error instanceof Error ? error.stack ?? error.message : String(error));
    app.exit(1);
  });
}
