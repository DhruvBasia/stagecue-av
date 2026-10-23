import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, type NativeImage } from 'electron';
import { WEB_PARTITION, type OfflineCopyProgress, type OfflineCopyRequest, type OfflineCopyResult } from '../renderer/src/types';
import { pageFromUrl } from '../renderer/src/services/paging';
import { resolveMediaFile } from './protocolHandler';
import { isWebAddress } from './webStage';

/* =========================================================================
 * Offline copy of a web flipbook: the page is opened off-screen at projector
 * size, turned with the → key one view at a time, and every view is saved
 * into a PDF. That PDF imports like any other booklet, so the magazine plays
 * on show day without internet.
 * ========================================================================= */

export const OFFLINE_WIDTH = 1920;
export const OFFLINE_HEIGHT = 1080;
export const MAX_OFFLINE_PAGES = 200;
const LOAD_TIMEOUT_MS = 45_000;
const FIRST_SETTLE_MS = 3000;
/** Time for a page-turn animation to finish before the view is captured. */
const TURN_SETTLE_MS = 1400;
/** The view counts as still once nothing has repainted for this long. */
const QUIET_MS = 450;
const MAX_WAIT_MS = 6000;
/** Mean per-channel difference (0–255) below which two views are "the same page". */
const SAME_VIEW_THRESHOLD = 1.5;

/** Mean absolute difference of two equally sized BGRA bitmaps (0–255). Alpha is ignored. */
export function bitmapDifference(a: Buffer, b: Buffer): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let total = 0;
  let samples = 0;
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    samples += 3;
  }
  return total / samples;
}

/**
 * Did the → key bring up a new view? Sites that put the page in the address
 * (?page=12) are judged by the address; others by the picture.
 */
export function isNewView(previousUrl: string, currentUrl: string, pictureDifference: number): boolean {
  const before = pageFromUrl(previousUrl);
  const after = pageFromUrl(currentUrl);
  if (after !== null && (before === null || after !== before)) return after > (before ?? 0);
  if (before !== null && after !== null) return false;
  return pictureDifference >= SAME_VIEW_THRESHOLD;
}

/** Extra tries (with longer waits) before a page that did not turn counts as the last one. */
export const TURN_RETRIES = 2;

/** "Netted Bytes" → "Netted Bytes (offline copy).pdf" with characters Windows does not allow removed. */
export function offlinePdfName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Web page';
  return `${cleaned} (offline copy).pdf`;
}

/** One full-bleed 16:9 page per captured view. */
export function buildBookletHtml(imageFiles: string[]): string {
  const pages = imageFiles
    .map((file) => `<div class="p"><img src="${pathToFileURL(file).href}" alt=""></div>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${OFFLINE_WIDTH}px ${OFFLINE_HEIGHT}px; margin: 0; }
html, body { margin: 0; padding: 0; background: #000; }
.p { width: ${OFFLINE_WIDTH}px; height: ${OFFLINE_HEIGHT}px; overflow: hidden; break-after: page; }
.p:last-child { break-after: auto; }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style></head><body>${pages}</body></html>`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Off-screen browser that keeps the latest painted frame. */
class OffscreenPage {
  readonly win: BrowserWindow;
  private latest: NativeImage | null = null;
  private lastPaintAt = 0;

  constructor() {
    this.win = new BrowserWindow({
      show: false,
      width: OFFLINE_WIDTH,
      height: OFFLINE_HEIGHT,
      useContentSize: true,
      webPreferences: { partition: WEB_PARTITION, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    const contents = this.win.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isWebAddress(url)) event.preventDefault();
    });
    contents.setAudioMuted(true);
    contents.setFrameRate(30);
    contents.on('paint', (_event, _dirty, image) => {
      this.latest = image;
      this.lastPaintAt = Date.now();
    });
  }

  load(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const contents = this.win.webContents;
      const timer = setTimeout(() => reject(new Error('The page did not finish loading in time')), LOAD_TIMEOUT_MS);
      contents.once('did-finish-load', () => {
        clearTimeout(timer);
        resolve();
      });
      contents.once('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === -3) return;
        clearTimeout(timer);
        reject(new Error(`The page could not be loaded (${description || `error ${code}`})`));
      });
      this.win.loadURL(url).catch(() => undefined);
    });
  }

  /** Waits for animations to finish (no repaint for a moment) and returns the view. */
  async still(minWaitMs: number): Promise<NativeImage | null> {
    const started = Date.now();
    await delay(minWaitMs);
    while (Date.now() - this.lastPaintAt < QUIET_MS && Date.now() - started < MAX_WAIT_MS) await delay(100);
    // Force a fresh frame in case nothing repainted since the page settled.
    this.win.webContents.invalidate();
    await delay(120);
    return this.latest && !this.latest.isEmpty() ? this.latest : null;
  }

  pressRight(): void {
    const contents = this.win.webContents;
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  }

  url(): string {
    return this.win.webContents.getURL();
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

function signature(image: NativeImage): Buffer {
  return image.resize({ width: 96, height: 54, quality: 'good' }).toBitmap();
}

async function printBooklet(imageFiles: string[], workDir: string, pdfPath: string): Promise<void> {
  const htmlPath = path.join(workDir, 'booklet.html');
  await fsp.writeFile(htmlPath, buildBookletHtml(imageFiles), 'utf8');
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
  try {
    await printer.loadFile(htmlPath);
    const pdf = await printer.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    await fsp.mkdir(path.dirname(pdfPath), { recursive: true });
    await fsp.writeFile(pdfPath, pdf);
  } finally {
    if (!printer.isDestroyed()) printer.destroy();
  }
}

export async function makeOfflineCopy(
  request: OfflineCopyRequest,
  outDir: string,
  onProgress: (progress: OfflineCopyProgress) => void
): Promise<OfflineCopyResult> {
  if (!isWebAddress(request.url)) throw new Error('Only http:// and https:// pages can be saved');
  const report = (phase: OfflineCopyProgress['phase'], pages: number, error: string | null = null): void =>
    onProgress({ mediaId: request.mediaId, phase, pages, error });
  const workDir = await fsp.mkdtemp(path.join(tmpdir(), 'stagecue-offline-'));
  const page = new OffscreenPage();
  const files: string[] = [];
  try {
    report('loading', 0);
    await page.load(request.url);
    let view = await page.still(FIRST_SETTLE_MS);
    if (!view) throw new Error('The page did not show anything');
    let previousSignature = signature(view);
    let previousUrl = page.url();

    report('capturing', 0);
    for (let index = 1; index <= MAX_OFFLINE_PAGES; index += 1) {
      const file = path.join(workDir, `view-${String(index).padStart(3, '0')}.jpg`);
      await fsp.writeFile(file, view.toJPEG(92));
      files.push(file);
      report('capturing', files.length);
      if (index === MAX_OFFLINE_PAGES) break;

      // Turn the page; a slow site gets a couple of extra tries before this counts as the last page.
      let turned: { image: NativeImage; signature: Buffer; url: string } | null = null;
      for (let attempt = 0; attempt <= TURN_RETRIES && !turned; attempt += 1) {
        page.pressRight();
        const next = await page.still(TURN_SETTLE_MS * (attempt + 1));
        if (!next) continue;
        const nextSignature = signature(next);
        const nextUrl = page.url();
        if (isNewView(previousUrl, nextUrl, bitmapDifference(previousSignature, nextSignature))) {
          turned = { image: next, signature: nextSignature, url: nextUrl };
        }
      }
      if (!turned) break;
      view = turned.image;
      previousSignature = turned.signature;
      previousUrl = turned.url;
    }

    report('saving', files.length);
    const pdfPath = path.join(outDir, offlinePdfName(request.name));
    await printBooklet(files, workDir, pdfPath);
    const file = await resolveMediaFile({ filePath: pdfPath });
    if (!file.exists) throw new Error('The PDF could not be written');
    report('done', files.length);
    return { file, pages: files.length };
  } catch (error) {
    report('error', files.length, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    page.close();
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
