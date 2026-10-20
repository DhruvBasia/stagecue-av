import {
  BrowserWindow,
  desktopCapturer,
  net,
  session,
  webContents,
  type Event as ElectronEvent,
  type KeyboardInputEvent,
  type MouseInputEvent,
  type MouseWheelInputEvent,
  type NativeImage,
  type WebContents,
  type WebPreferences
} from 'electron';
import {
  WEB_KEYS,
  WEB_PARTITION,
  type CaptureResolveRequest,
  type CaptureSourceInfo,
  type StageWebLivePayload,
  type WebFrame,
  type WebInput,
  type WebInspectRequest,
  type WebInspectResult,
  type WebKey
} from '../renderer/src/types';
import { pageFromUrl } from '../renderer/src/services/paging';

/* =========================================================================
 * Live web pages on stage (e.g. an online flipbook magazine) and window /
 * screen capture.
 *
 * The page runs in a sandboxed <webview> inside the stage window, so freeze,
 * blackout and transitions keep working. The operator never touches the
 * projector: they get a live picture of the page and their clicks, drags and
 * keys are forwarded to it from here.
 * ========================================================================= */

export { WEB_PARTITION };

const FRAME_INTERVAL_MS = 125;
const PREVIEW_WIDTH = 960;
const VIEWPORT_REFRESH_MS = 2000;
const INSPECT_TIMEOUT_MS = 12_000;
const SNAPSHOT_SETTLE_MS = 1500;

export function isWebAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

const KEY_CODES: Record<WebKey, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Space: 'Space',
  Enter: 'Enter',
  Escape: 'Escape'
};

function unit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

/** Validates untrusted operator input (IPC payloads are not trusted blindly). */
export function parseWebInput(value: unknown): WebInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case 'pointer': {
      const x = unit(raw.x);
      const y = unit(raw.y);
      if (x === null || y === null || (raw.phase !== 'down' && raw.phase !== 'move' && raw.phase !== 'up')) return null;
      return { type: 'pointer', phase: raw.phase, x, y };
    }
    case 'wheel': {
      const x = unit(raw.x);
      const y = unit(raw.y);
      const deltaY = typeof raw.deltaY === 'number' && Number.isFinite(raw.deltaY) ? Math.max(-2000, Math.min(2000, raw.deltaY)) : null;
      return x === null || y === null || deltaY === null ? null : { type: 'wheel', x, y, deltaY };
    }
    case 'key':
      return (WEB_KEYS as readonly string[]).includes(raw.key as string) ? { type: 'key', key: raw.key as WebKey } : null;
    case 'nav':
      return raw.action === 'back' || raw.action === 'forward' || raw.action === 'reload' || raw.action === 'home'
        ? { type: 'nav', action: raw.action }
        : null;
    case 'mute':
      return typeof raw.muted === 'boolean' ? { type: 'mute', muted: raw.muted } : null;
    default:
      return null;
  }
}

/** Locks down the session used by on-stage web pages: no downloads, no camera/mic/notifications, no fullscreen. */
export function configureWebSession(): void {
  const web = session.fromPartition(WEB_PARTITION);
  web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  web.setPermissionCheckHandler(() => false);
  web.on('will-download', (event) => event.preventDefault());
}

/** `will-attach-webview` guard for the stage window: only sandboxed http(s) pages in our partition. */
export function sanitizeWebview(
  event: ElectronEvent,
  webPreferences: WebPreferences,
  params: Record<string, string>
): void {
  if (!isWebAddress(params.src) || params.partition !== WEB_PARTITION) {
    event.preventDefault();
    return;
  }
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.backgroundThrottling = false;
}

/** Hardens a freshly attached guest page. */
export function hardenGuest(guest: WebContents): void {
  // Links that open new windows stay on the same page instead of popping up on the projector.
  guest.setWindowOpenHandler(({ url }) => {
    if (isWebAddress(url)) void guest.loadURL(url).catch(() => undefined);
    return { action: 'deny' };
  });
  guest.on('will-navigate', (event, url) => {
    if (!isWebAddress(url)) event.preventDefault();
  });
  guest.setAudioMuted(true);
}

interface LivePage {
  contents: WebContents;
  mediaId: string;
  homeUrl: string;
}

export interface WebStageHooks {
  /** Delivers a picture/state update to the operator window. */
  sendFrame(frame: WebFrame): void;
}

export class WebStageController {
  private live: LivePage | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private capturing = false;
  private lastImage: Buffer | null = null;
  private lastState = '';
  private viewport = { width: 1920, height: 1080, at: 0 };
  private pointerDown = false;

  constructor(private readonly hooks: WebStageHooks) {}

  /** The stage reports which webview is live (or that none is). */
  setLive(payload: StageWebLivePayload): void {
    if (payload.webContentsId === null || payload.mediaId === null) {
      this.clear();
      return;
    }
    const contents = webContents.fromId(payload.webContentsId);
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return;
    if (this.live && this.live.contents === contents && this.live.mediaId === payload.mediaId) return;
    this.live = { contents, mediaId: payload.mediaId, homeUrl: isWebAddress(payload.homeUrl) ? payload.homeUrl : contents.getURL() };
    this.lastImage = null;
    this.lastState = '';
    this.viewport.at = 0;
    this.pointerDown = false;
    contents.once('destroyed', () => {
      if (this.live?.contents === contents) this.clear();
    });
    if (this.timer === null) this.timer = setInterval(() => void this.pushFrame(), FRAME_INTERVAL_MS);
    void this.pushFrame();
  }

  getLiveContents(): WebContents | null {
    return this.live && !this.live.contents.isDestroyed() ? this.live.contents : null;
  }

  stop(): void {
    this.clear();
  }

  private clear(): void {
    this.live = null;
    this.lastImage = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refreshViewport(contents: WebContents): Promise<void> {
    if (Date.now() - this.viewport.at < VIEWPORT_REFRESH_MS) return;
    this.viewport.at = Date.now();
    try {
      const size: unknown = await contents.executeJavaScript('[window.innerWidth, window.innerHeight]', false);
      if (Array.isArray(size) && typeof size[0] === 'number' && typeof size[1] === 'number' && size[0] > 0 && size[1] > 0) {
        this.viewport.width = size[0];
        this.viewport.height = size[1];
      }
    } catch {
      // The page is between navigations; keep the last known size.
    }
  }

  private async pushFrame(): Promise<void> {
    const live = this.live;
    if (!live || this.capturing || live.contents.isDestroyed()) return;
    this.capturing = true;
    try {
      const contents = live.contents;
      await this.refreshViewport(contents);
      const image = await contents.capturePage();
      if (this.live !== live) return;
      let dataUrl: string | null = null;
      if (!image.isEmpty()) {
        const size = image.getSize();
        const scaled = size.width > PREVIEW_WIDTH ? image.resize({ width: PREVIEW_WIDTH, quality: 'good' }) : image;
        const jpeg = scaled.toJPEG(70);
        if (!this.lastImage || !jpeg.equals(this.lastImage)) {
          this.lastImage = jpeg;
          dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
        }
      }
      const url = contents.getURL();
      const state = {
        url,
        title: contents.getTitle(),
        loading: contents.isLoading(),
        canGoBack: contents.canGoBack(),
        canGoForward: contents.canGoForward(),
        muted: contents.isAudioMuted()
      };
      const stateKey = JSON.stringify(state);
      if (dataUrl === null && stateKey === this.lastState) return;
      this.lastState = stateKey;
      this.hooks.sendFrame({ mediaId: live.mediaId, image: dataUrl, page: pageFromUrl(url), at: Date.now(), ...state });
    } catch {
      // A capture can fail mid-navigation; the next tick tries again.
    } finally {
      this.capturing = false;
    }
  }

  /** Applies operator input to the live page. Returns false when no web page is live. */
  handleInput(input: WebInput): boolean {
    const contents = this.getLiveContents();
    if (!contents || !this.live) return false;
    const point = (x: number, y: number): { x: number; y: number } => ({
      x: Math.round(x * this.viewport.width),
      y: Math.round(y * this.viewport.height)
    });
    const send = (event: MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent): void => contents.sendInputEvent(event);

    switch (input.type) {
      case 'pointer': {
        const { x, y } = point(input.x, input.y);
        if (input.phase === 'down') {
          this.pointerDown = true;
          send({ type: 'mouseMove', x, y });
          send({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        } else if (input.phase === 'move') {
          send({ type: 'mouseMove', x, y, ...(this.pointerDown ? { modifiers: ['leftButtonDown'] } : {}) });
        } else {
          this.pointerDown = false;
          send({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        }
        break;
      }
      case 'wheel': {
        const { x, y } = point(input.x, input.y);
        // Electron's wheel deltas point the other way round from DOM wheel events.
        send({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -input.deltaY, canScroll: true });
        break;
      }
      case 'key': {
        const keyCode = KEY_CODES[input.key];
        send({ type: 'keyDown', keyCode });
        send({ type: 'keyUp', keyCode });
        break;
      }
      case 'nav': {
        if (input.action === 'back' && contents.canGoBack()) contents.goBack();
        else if (input.action === 'forward' && contents.canGoForward()) contents.goForward();
        else if (input.action === 'reload') contents.reload();
        else if (input.action === 'home') void contents.loadURL(this.live.homeUrl).catch(() => undefined);
        break;
      }
      case 'mute':
        contents.setAudioMuted(input.muted);
        break;
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
    this.lastState = '';
    return true;
  }

  /** Full-quality still of the live page for the freeze layer. */
  async captureFull(): Promise<string | null> {
    const contents = this.getLiveContents();
    if (!contents) return null;
    try {
      const image = await contents.capturePage();
      return image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(90).toString('base64')}`;
    } catch {
      return null;
    }
  }
}

/* ------------------------------ Inspect a URL ----------------------------- */

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i.test(message)) return 'Address not found. Check the spelling and the internet connection';
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ENETUNREACH/i.test(message)) return 'No internet connection';
  if (/timeout|TimeoutError|aborted/i.test(message)) return 'The site did not answer in time';
  return message;
}

function snapshotPage(url: string): Promise<{ title: string | null; thumbnail: string | null }> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { partition: WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.setAudioMuted(true);
    win.webContents.setFrameRate(10);
    let latest: NativeImage | null = null;
    let finished = false;
    win.webContents.on('paint', (_event, _dirty, image) => {
      latest = image;
    });
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(hardStop);
      let thumbnail: string | null = null;
      const frame = latest as NativeImage | null;
      if (frame && !frame.isEmpty()) {
        thumbnail = `data:image/jpeg;base64,${frame.resize({ width: 320, quality: 'good' }).toJPEG(75).toString('base64')}`;
      }
      const title = win.isDestroyed() ? null : win.webContents.getTitle() || null;
      if (!win.isDestroyed()) win.destroy();
      resolve({ title, thumbnail });
    };
    const hardStop = setTimeout(finish, INSPECT_TIMEOUT_MS);
    win.webContents.once('did-finish-load', () => setTimeout(finish, SNAPSHOT_SETTLE_MS));
    win.webContents.once('did-fail-load', () => finish());
    win.loadURL(url).catch(() => finish());
  });
}

export async function inspectWebPage(request: WebInspectRequest): Promise<WebInspectResult> {
  const empty: WebInspectResult = { ok: false, status: null, error: null, finalUrl: request.url, title: null, thumbnail: null };
  if (!isWebAddress(request.url)) return { ...empty, error: 'Only http:// and https:// addresses can be shown' };
  try {
    const response = await net.fetch(request.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS)
    });
    void response.body?.cancel().catch(() => undefined);
    const ok = response.status < 400;
    const result: WebInspectResult = {
      ...empty,
      ok,
      status: response.status,
      finalUrl: response.url || request.url,
      error: ok ? null : `The site answered ${response.status}`
    };
    if (ok && request.snapshot) Object.assign(result, await snapshotPage(request.url));
    return result;
  } catch (error) {
    return { ...empty, error: errorText(error) };
  }
}

/* ------------------------------ Screen capture ---------------------------- */

const OWN_WINDOW = /^StageCue AV/;

function sourceKind(id: string): 'window' | 'screen' {
  return id.startsWith('screen:') ? 'screen' : 'window';
}

export async function listCaptureSources(): Promise<CaptureSourceInfo[]> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return sources
    .filter((s) => s.name.trim().length > 0 && !OWN_WINDOW.test(s.name))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: sourceKind(s.id),
      thumbnail: s.thumbnail.isEmpty() ? '' : `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString('base64')}`
    }));
}

/** Finds the window again by id, or by its title after the app was restarted. */
export async function resolveCaptureSource(request: CaptureResolveRequest): Promise<string | null> {
  const sources = await desktopCapturer.getSources({
    types: [request.kind === 'screen' ? 'screen' : 'window'],
    thumbnailSize: { width: 0, height: 0 }
  });
  const byId = sources.find((s) => s.id === request.sourceId);
  if (byId) return byId.id;
  const byName = sources.find((s) => s.name === request.name);
  return byName ? byName.id : null;
}

export function isCaptureResolveRequest(value: unknown): value is CaptureResolveRequest {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Partial<CaptureResolveRequest>;
  return typeof raw.sourceId === 'string' && typeof raw.name === 'string' && (raw.kind === 'window' || raw.kind === 'screen');
}
