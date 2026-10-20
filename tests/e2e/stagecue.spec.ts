import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type {
  AudioOutputDevice,
  CueItem,
  FreezeAck,
  InternetConfig,
  MediaItem,
  RemoteInfo,
  ResolvedMediaFile,
  StageCueApi,
  StageTelemetry
} from '../../src/renderer/src/types';
import { createRelayServer } from '../../relay/server';

/** Structural view of the store hooks the operator window exposes in E2E mode. */
interface StoreHook<S> {
  getState(): S;
}

interface E2EHooks {
  media: StoreHook<{
    importFiles(files: ResolvedMediaFile[]): { added: MediaItem[] };
    rescanFolder(folderPath: string): Promise<{ added: MediaItem[]; skipped: number } | null>;
    addWebPage(url: string, name: string, thumbnail: string | null): MediaItem;
    items: MediaItem[];
    folders: string[];
  }>;
  web: StoreHook<{ frame: { mediaId: string; url: string; title: string } | null }>;
  show: StoreHook<{ alerts: Array<{ title: string; message: string }> }>;
  stage: StoreHook<{
    addMediaAsCue(media: MediaItem): string;
    cues: CueItem[];
    addCue(input?: Partial<CueItem>): string;
    selectCue(id: string | null): void;
    takeCue(id: string): boolean;
    takeMedia(media: MediaItem): boolean;
    setAutoFollow(enabled: boolean, markDirty?: boolean): void;
    autoFollowEnabled: boolean;
    lastFreezeAck: FreezeAck | null;
    selectedCueId: string | null;
    telemetry: StageTelemetry | null;
    program: { liveCueId: string | null; isBlackout: boolean; isFrozen: boolean };
  }>;
  audio: StoreHook<{
    toggleMute(): void;
    isMuted: boolean;
    pauseMusic(): void;
    telemetry: { isBgMusicPlaying: boolean; musicCurrentTime: number; bgMusicName: string | null; levels: { music: number } } | null;
    outputSupported: boolean;
    outputDevices: AudioOutputDevice[];
    currentSinkId: string;
    setOutputDevice(deviceId: string): void;
  }>;
  prefs: StoreHook<{
    setClickerEnabled(enabled: boolean): void;
    configureRemote(enabled: boolean, port?: number): Promise<RemoteInfo | null>;
    setInternet(patch: Partial<InternetConfig>): Promise<void>;
    remoteInfo: RemoteInfo | null;
    internet: InternetConfig;
  }>;
  drive: StoreHook<{
    setApiKey(key: string): void;
    setAutoSync(enabled: boolean): void;
    addSource(url: string, localDir: string | null): Promise<{ id: string; localPath: string } | null>;
  }>;
}

declare global {
  interface Window {
    api: StageCueApi;
    __STAGECUE_TEST__?: E2EHooks;
  }
}

/* =========================================================================
 * Dual-window integration test: drives the real Electron app (built by
 * `electron-vite build`) and checks that operator actions reach the stage
 * window — TAKE, software freeze isolation, reveal-from-freeze and blackout.
 * ========================================================================= */

const ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(ROOT, 'out', 'main', 'index.js');
const ARTIFACTS = path.join(ROOT, 'test-results');
const INSTALLED_EXE = process.env.STAGECUE_E2E_EXECUTABLE || null;

let app: ElectronApplication;
let operator: Page;
let stage: Page;
let fixtureDir: string;
let posterPath: string;
let welcomePath: string;

function svgPoster(color: string, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="${color}"/>
  <text x="960" y="560" font-size="120" font-family="sans-serif" text-anchor="middle" fill="#ffffff">${label}</text>
</svg>`;
}

/** Minimal valid PDF: one solid-colour 16:9 page per RGB triple (no fonts needed). */
function buildPdf(pageColors: Array<[number, number, number]>): Buffer {
  const objects: string[] = [];
  const pageIds = pageColors.map((_, i) => 3 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageColors.length} >>`;
  pageColors.forEach(([r, g, b], i) => {
    const pageId = pageIds[i];
    const content = `${r} ${g} ${b} rg 0 0 960 540 re f 1 1 1 rg 380 220 200 100 re f`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Contents ${pageId + 1} 0 R /Resources << >> >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A short, quiet sine-wave WAV, so downloaded "performer tracks" really decode and play. */
function sineWav(seconds: number, frequency: number): Buffer {
  const rate = 8000;
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 3000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const DRIVE_FOLDER = '1PerformerTracksFolder2026';

interface FakeDriveFile {
  id: string;
  name: string;
  body: Buffer;
}

/** Stands in for Google's Drive API v3 (list + download with an API key). */
function startFakeDrive(files: FakeDriveFile[]): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.searchParams.get('key') !== 'E2E_KEY') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'API key not valid' } }));
      return;
    }
    if (url.pathname === `/drive/v3/files/${DRIVE_FOLDER}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'Performer Tracks', mimeType: 'application/vnd.google-apps.folder' }));
      return;
    }
    if (url.pathname === '/drive/v3/files') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            mimeType: 'audio/wav',
            size: String(f.body.length),
            modifiedTime: '2026-10-15T09:00:00.000Z',
            md5Checksum: `md5-${f.id}`
          }))
        })
      );
      return;
    }
    const file = files.find((f) => url.pathname === `/drive/v3/files/${f.id}` && url.searchParams.get('alt') === 'media');
    if (file) {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(file.body.length) });
      res.end(file.body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

let fakeDrive: { server: Server; base: string };
const driveFiles: FakeDriveFile[] = [
  { id: 'trk1', name: 'Team Aarohi - Classical Dance.wav', body: sineWav(6, 440) },
  { id: 'trk2', name: 'Rhythm Crew - Drum Medley.wav', body: sineWav(6, 330) }
];

async function waitForWindows(application: ElectronApplication): Promise<{ operator: Page; stage: Page }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pages = application.windows();
    const op = pages.find((p) => p.url().includes('index.html'));
    const st = pages.find((p) => p.url().includes('stage.html'));
    if (op && st) return { operator: op, stage: st };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Operator and stage windows did not both open');
}

async function importAsCue(page: Page, filePath: string): Promise<string> {
  return page.evaluate(async (target) => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    const resolved = await window.api.invoke('media:read-metadata', [{ filePath: target }]);
    const outcome = hooks.media.getState().importFiles(resolved);
    const item = outcome.added[0];
    if (!item) throw new Error(`Import failed for ${target}`);
    hooks.stage.getState().addMediaAsCue(item);
    return item.id;
  }, filePath);
}

test.beforeAll(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), 'stagecue-e2e-'));
  posterPath = path.join(fixtureDir, 'Convocation Poster.svg');
  welcomePath = path.join(fixtureDir, 'Welcome Slide.svg');
  writeFileSync(posterPath, svgPoster('#1d4ed8', 'CONVOCATION 2026'));
  writeFileSync(welcomePath, svgPoster('#15803d', 'WELCOME'));

  fakeDrive = await startFakeDrive(driveFiles);
  // STAGECUE_E2E_EXECUTABLE runs the suite against an installed build ("StageCue AV.exe")
  // with throwaway app data, so a real installation's settings are never touched.
  app = await electron.launch({
    ...(INSTALLED_EXE
      ? { executablePath: INSTALLED_EXE, args: ['--stagecue-e2e', `--user-data-dir=${path.join(fixtureDir, 'user-data')}`] }
      : { args: [MAIN_ENTRY, '--stagecue-e2e'] }),
    env: {
      ...process.env,
      STAGECUE_E2E: '1',
      STAGECUE_E2E_OUTPUT: fixtureDir,
      STAGECUE_DRIVE_BASE: fakeDrive.base,
      NODE_ENV: 'production'
    }
  });
  ({ operator, stage } = await waitForWindows(app));
  await operator.waitForLoadState('domcontentloaded');
  await stage.waitForLoadState('domcontentloaded');
  await expect(operator.getByTestId('operator-root')).toBeVisible();
  await expect(stage.getByTestId('stage-root')).toBeAttached();
});

test.afterAll(async () => {
  if (app) await app.close();
  if (fakeDrive) await new Promise<void>((resolve) => fakeDrive.server.close(() => resolve()));
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

test('stage window is a separate, decoupled output with a known display mode', async () => {
  await expect(stage.getByTestId('stage-root')).not.toHaveAttribute('data-mode', 'unknown');
  const mode = await stage.getByTestId('stage-root').getAttribute('data-mode');
  if (mode === 'projector') {
    await expect(operator.getByTestId('projector-badge')).toContainText('HDMI ACTIVE');
  } else {
    await expect(stage.getByTestId('rehearsal-label')).toContainText('[STAGE OUTPUT - REHEARSAL MODE]');
    await expect(operator.getByTestId('projector-badge')).toContainText('REHEARSAL MODE');
  }
  await expect(operator.getByTestId('stage-link')).toContainText('STAGE LINK');
});

test('Space takes the highlighted cue onto the stage', async () => {
  const posterId = await importAsCue(operator, posterPath);
  await expect(operator.getByTestId('media-card')).toHaveCount(1);
  await expect(operator.getByTestId('cue-row')).toHaveCount(1);

  await operator.keyboard.press('Space');

  const liveBackdrop = stage.locator(`[data-testid="backdrop-layer"] [data-active="true"] img[data-media-id="${posterId}"]`);
  await expect(liveBackdrop).toBeAttached();
  await expect
    .poll(() => liveBackdrop.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))
    .toBe(true);
  await expect(operator.locator('[data-testid="cue-row"][data-live="true"]')).toHaveCount(1);
  await expect(operator.getByTestId('monitor-program')).toContainText('Convocation Poster');
});

test('F8 freezes the projector; operator changes stay invisible until the reveal', async () => {
  // Freeze captures exactly what the audience sees, so let the poster finish fading in first.
  await expect
    .poll(() => stage.locator('[data-testid="backdrop-layer"] [data-active="true"]').evaluate((el) => getComputedStyle(el).opacity))
    .toBe('1');
  await operator.keyboard.press('F8');
  await expect(stage.getByTestId('freeze-layer')).toHaveAttribute('data-active', 'true');
  await expect(operator.getByTestId('status-frozen')).toBeVisible();
  await expect(operator.getByTestId('pad-freeze')).toHaveAttribute('data-state', 'freeze');

  const ack = await operator.evaluate(() => window.__STAGECUE_TEST__?.stage.getState().lastFreezeAck ?? null);
  expect(ack?.isFrozen).toBe(true);
  expect(ack?.source).toBe('backdrop');
  expect(ack?.latencyMs ?? 1000).toBeLessThan(250);

  // Operator prepares the next cue while frozen: the stage must not change.
  const welcomeId = await importAsCue(operator, welcomePath);
  await operator.waitForTimeout(400);
  await expect(stage.getByTestId('freeze-layer')).toHaveAttribute('data-active', 'true');
  await expect(stage.locator(`img[data-media-id="${welcomeId}"]`)).toHaveCount(0);

  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-frozen.png') });

  // Taking the new cue loads it underneath, then reveals it out of the freeze.
  await operator.keyboard.press('Space');
  await expect(stage.getByTestId('freeze-layer')).toHaveAttribute('data-active', 'false');
  await expect(
    stage.locator(`[data-testid="backdrop-layer"] [data-active="true"] img[data-media-id="${welcomeId}"]`)
  ).toBeAttached();
  await expect(operator.getByTestId('status-frozen')).toHaveCount(0);
});

test('ESC blacks out instantly and toggles back', async () => {
  await operator.keyboard.press('Escape');
  await expect(stage.getByTestId('blackout-layer')).toHaveAttribute('data-active', 'true');
  await expect(operator.getByTestId('status-blackout')).toBeVisible();
  await expect(operator.getByTestId('program-blackout')).toBeVisible();

  await operator.keyboard.press('Escape');
  await expect(stage.getByTestId('blackout-layer')).toHaveAttribute('data-active', 'false');
  await expect(operator.getByTestId('status-blackout')).toHaveCount(0);
});

test('an entire event folder (with sub-folders) imports into the right bins', async () => {
  const eventFolder = path.join(fixtureDir, 'Annual Day');
  mkdirSync(path.join(eventFolder, 'Posters'), { recursive: true });
  mkdirSync(path.join(eventFolder, 'Music'), { recursive: true });
  writeFileSync(path.join(eventFolder, 'Posters', '01 Stage Backdrop.svg'), svgPoster('#7c3aed', 'ANNUAL DAY'));
  writeFileSync(path.join(eventFolder, 'Posters', '02 Sponsors.svg'), svgPoster('#b45309', 'SPONSORS'));
  writeFileSync(path.join(eventFolder, 'Music', 'Walk-in.mp3'), Buffer.alloc(0));
  writeFileSync(path.join(eventFolder, 'Run of show.txt'), 'ignored');

  const outcome = await operator.evaluate(async (folder) => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    const result = await hooks.media.getState().rescanFolder(folder);
    return result ? { added: result.added.map((m) => `${m.type}:${m.name}`), skipped: result.skipped } : null;
  }, eventFolder);

  expect(outcome).toEqual({
    added: ['audio:Walk-in.mp3', 'image:01 Stage Backdrop.svg', 'image:02 Sponsors.svg'],
    skipped: 1
  });
  await expect(operator.getByTestId('linked-folder')).toContainText('Annual Day');
  await expect(operator.getByTestId('linked-folder')).toContainText('3 files');
  await expect(operator.getByTestId('media-card')).toHaveCount(4); // 2 earlier posters + 2 new ones in the Backdrops bin

  // A file added to the folder later is picked up by Rescan.
  writeFileSync(path.join(eventFolder, 'Posters', '03 Thank You.svg'), svgPoster('#0f766e', 'THANK YOU'));
  await operator.getByRole('button', { name: 'Rescan Annual Day' }).click();
  await expect(operator.getByTestId('linked-folder')).toContainText('4 files');
  await expect(operator.getByTestId('media-card')).toHaveCount(5);
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-folder.png') });
});

test('PDF pages become backdrops, and cues are built from the folder with thumbnails', async () => {
  const pdfFolder = path.join(fixtureDir, 'Seminar');
  mkdirSync(pdfFolder, { recursive: true });
  writeFileSync(path.join(pdfFolder, '01 Agenda.pdf'), buildPdf([[0.86, 0.15, 0.15], [0.1, 0.4, 0.9]]));
  writeFileSync(path.join(pdfFolder, '02 Keynote Poster.svg'), svgPoster('#be185d', 'KEYNOTE'));

  const outcome = await operator.evaluate(async (folder) => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    const result = await hooks.media.getState().rescanFolder(folder);
    return result
      ? result.added.map((m) => ({ name: m.name, page: m.pdf ? m.pdf.page : null, png: m.filePath.endsWith('.png') }))
      : null;
  }, pdfFolder);

  expect(outcome).toEqual([
    { name: '01 Agenda · p1', page: 1, png: true },
    { name: '01 Agenda · p2', page: 2, png: true },
    { name: '02 Keynote Poster.svg', page: null, png: false }
  ]);
  await expect(operator.getByTestId('pdf-badge')).toHaveCount(2);
  await expect(operator.getByTestId('pdf-badge').first()).toHaveText('PDF 1/2');

  // Build the running order from the folder.
  await operator
    .getByTestId('linked-folder')
    .filter({ hasText: 'Seminar' })
    .getByRole('button', { name: 'Build cues from Seminar' })
    .click();
  await expect(operator.getByTestId('build-cues-modal')).toBeVisible();
  await expect(operator.getByTestId('build-cues-modal')).toContainText('Agenda · p1');
  await operator.getByTestId('build-cues-confirm').click();

  const labels = operator.locator('[data-testid="cue-row"] span.truncate.text-sm');
  await expect(labels).toContainText(['Agenda · p1', 'Agenda · p2', 'Keynote Poster']);
  await expect(operator.locator('[data-testid="cue-thumb"] img').first()).toBeVisible();

  // The first built cue is highlighted: take it and check the rendered page is on stage.
  const pageId = await operator.evaluate(() => window.__STAGECUE_TEST__?.stage.getState().selectedCueId ?? null);
  expect(pageId).not.toBeNull();
  await operator.keyboard.press('Space');
  const stageImage = stage.locator('[data-testid="backdrop-layer"] [data-active="true"] img');
  await expect
    .poll(() => stageImage.evaluate((img) => (img as HTMLImageElement).naturalWidth).catch(() => 0))
    .toBeGreaterThanOrEqual(1920);
  await expect(stageImage).toHaveAttribute('src', /\.png$|page-0001/);
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-pdf-cues.png') });
  await stage.screenshot({ path: path.join(ARTIFACTS, 'stage-pdf.png') });
});

test('stage telemetry flows back to the operator', async () => {
  await expect
    .poll(async () =>
      operator.evaluate(() => {
        const t = window.__STAGECUE_TEST__?.stage.getState().telemetry;
        return t ? { backdrop: t.currentBackdrop?.name ?? null, frozen: t.isFrozen, blackout: t.isBlackout } : null;
      })
    )
    .toEqual({ backdrop: '01 Agenda · p1', frozen: false, blackout: false });

  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-live.png') });
  await stage.screenshot({ path: path.join(ARTIFACTS, 'stage-live.png') });
});

const liveCueId = (): Promise<string | null> =>
  operator.evaluate(() => window.__STAGECUE_TEST__?.stage.getState().program.liveCueId ?? null);

const stageBackdropName = (): Promise<string | null> =>
  operator.evaluate(() => window.__STAGECUE_TEST__?.stage.getState().telemetry?.currentBackdrop?.name ?? null);

test('a PDF booklet turns its pages live from one cue: buttons, page number and the clicker', async () => {
  const bookletCue = await liveCueId();
  expect(await stageBackdropName()).toBe('01 Agenda · p1');
  const controls = operator.getByTestId('monitor-program').getByTestId('page-controls');
  await expect(controls).toHaveAttribute('data-kind', 'pdf');
  await expect(controls.getByTestId('page-number')).toHaveValue('1');
  await expect(operator.getByTestId('cue-booklet-badge').first()).toHaveText('PDF ⇆');

  await controls.getByTestId('page-next').click();
  await expect.poll(stageBackdropName).toBe('01 Agenda · p2');
  await expect(controls.getByTestId('page-number')).toHaveValue('2');
  // Still the same cue: pages are turned inside it.
  expect(await liveCueId()).toBe(bookletCue);
  await expect(controls.getByTestId('page-next')).toBeDisabled();
  await stage.screenshot({ path: path.join(ARTIFACTS, 'stage-booklet-p2.png') });

  await controls.getByTestId('page-prev').click();
  await expect.poll(stageBackdropName).toBe('01 Agenda · p1');

  // Type a page number.
  await controls.getByTestId('page-number').fill('2');
  await controls.getByTestId('page-number').press('Enter');
  await expect.poll(stageBackdropName).toBe('01 Agenda · p2');
  await controls.getByTestId('page-number').fill('1');
  await controls.getByTestId('page-number').press('Enter');
  await expect.poll(stageBackdropName).toBe('01 Agenda · p1');

  // The clicker turns pages, then moves on to the next cue after the last page.
  const nextCue = await operator.evaluate(() => window.__STAGECUE_TEST__?.stage.getState().selectedCueId ?? null);
  expect(nextCue).not.toBe(bookletCue);
  // (Key presses are spaced out: faster than 150 ms is treated as a clicker double-fire.)
  await operator.locator('body').click({ position: { x: 5, y: 600 } });
  await operator.waitForTimeout(200);
  await operator.keyboard.press('PageDown');
  await expect.poll(stageBackdropName).toBe('01 Agenda · p2');
  expect(await liveCueId()).toBe(bookletCue);
  await operator.waitForTimeout(250);
  await operator.keyboard.press('PageUp');
  await expect.poll(stageBackdropName).toBe('01 Agenda · p1');
  await operator.waitForTimeout(250);
  await operator.keyboard.press(']');
  await expect.poll(stageBackdropName).toBe('01 Agenda · p2');
  await operator.waitForTimeout(350);
  await operator.keyboard.press('PageDown');
  await expect.poll(liveCueId).toBe(nextCue);
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-booklet.png') });
  // Let the double-take guard expire before the next test takes a cue.
  await operator.waitForTimeout(350);
});

test('auto-follow advances on its own, pauses while frozen, and obeys the ON/OFF switch', async () => {
  const ids = await operator.evaluate(() => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    const images = hooks.media.getState().items.filter((i) => i.type === 'image' && !i.missing);
    const a = hooks.stage.getState().addCue({
      label: 'Auto A',
      backdropMediaId: images[0].id,
      transition: 'cut',
      followMode: 'after-delay',
      followDelaySec: 1
    });
    const b = hooks.stage.getState().addCue({ label: 'Auto B', backdropMediaId: images[1].id, transition: 'cut' });
    hooks.stage.getState().setAutoFollow(true);
    return { a, b };
  });

  // 1. Advances by itself after 1 s.
  await operator.evaluate((id) => window.__STAGECUE_TEST__?.stage.getState().takeCue(id), ids.a);
  await expect(operator.getByTestId('follow-countdown')).toBeVisible();
  await expect.poll(liveCueId, { timeout: 4000 }).toBe(ids.b);

  // 2. Freeze pauses the countdown; unfreezing resumes it. (Waits respect the 300 ms double-take guard.)
  await operator.waitForTimeout(350);
  await operator.evaluate((id) => window.__STAGECUE_TEST__?.stage.getState().takeCue(id), ids.a);
  await expect.poll(liveCueId).toBe(ids.a);
  await operator.keyboard.press('F8');
  await expect(operator.getByTestId('follow-countdown')).toContainText('paused: frozen');
  await operator.waitForTimeout(1600);
  expect(await liveCueId()).toBe(ids.a);
  await operator.keyboard.press('F8');
  await expect.poll(liveCueId, { timeout: 4000 }).toBe(ids.b);

  // 3. Master switch OFF: nothing advances; switching ON again resumes.
  await operator.getByTestId('auto-follow-toggle').click();
  await expect(operator.getByTestId('auto-follow-toggle')).toHaveAttribute('data-state', 'off');
  await operator.waitForTimeout(350);
  await operator.evaluate((id) => window.__STAGECUE_TEST__?.stage.getState().takeCue(id), ids.a);
  await expect.poll(liveCueId).toBe(ids.a);
  await operator.waitForTimeout(1600);
  expect(await liveCueId()).toBe(ids.a);
  await expect(operator.getByTestId('follow-badge').first()).toHaveClass(/line-through/);
  await operator.getByTestId('auto-follow-toggle').click();
  await expect.poll(liveCueId, { timeout: 4000 }).toBe(ids.b);
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-follow.png') });
});

test('presentation clicker keys take cues only while the clicker is ON', async () => {
  const target = await operator.evaluate(() => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    hooks.stage.getState().setAutoFollow(false);
    const images = hooks.media.getState().items.filter((i) => i.type === 'image' && !i.missing);
    const id = hooks.stage.getState().addCue({ label: 'Clicker cue', backdropMediaId: images[2].id, transition: 'cut' });
    hooks.stage.getState().selectCue(id);
    hooks.prefs.getState().setClickerEnabled(false);
    return id;
  });
  await operator.locator('body').click({ position: { x: 5, y: 600 } });
  await operator.waitForTimeout(350);
  await operator.keyboard.press('PageDown');
  await operator.waitForTimeout(400);
  expect(await liveCueId()).not.toBe(target);

  await operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().setClickerEnabled(true));
  await operator.keyboard.press('PageDown');
  await expect.poll(liveCueId).toBe(target);
});

interface CrewClient {
  ws: WebSocket;
  next: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  send: (message: unknown) => void;
}

/** A phone on the crew remote: a real WebSocket client with a typed message queue. */
function crewClient(port: number, token: string, basePath = '/'): Promise<CrewClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${basePath}ws?t=${token}`);
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const index = waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else queue.push(message);
    });
    ws.addEventListener('error', () => reject(new Error('websocket rejected')));
    ws.addEventListener('open', () =>
      resolve({
        ws,
        send: (message) => ws.send(JSON.stringify(message)),
        next: (type, timeoutMs = 5000) =>
          new Promise((done, fail) => {
            const index = queue.findIndex((m) => m.type === type);
            if (index >= 0) {
              done(queue.splice(index, 1)[0]);
              return;
            }
            const timer = setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), timeoutMs);
            waiters.push({
              type,
              resolve: (m) => {
                clearTimeout(timer);
                done(m);
              }
            });
          })
      })
    );
  });
}

test('stage team phones control the show over WebSockets, within the AV room’s permissions', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const info = await operator.evaluate((p) => window.__STAGECUE_TEST__?.prefs.getState().configureRemote(true, p) ?? null, port);
  expect(info?.enabled).toBe(true);
  if (!info) throw new Error('remote did not start');
  await expect(operator.getByTestId('remote-indicator')).toContainText('Crew');

  // HTTP page per role link; bad links refused.
  expect((await fetch(`http://127.0.0.1:${port}/?t=${'0'.repeat(32)}`)).status).toBe(401);
  const page = await fetch(`http://127.0.0.1:${port}/?t=${info.stageToken}`);
  expect(await page.text()).toContain('StageCue Crew');

  const phone = await crewClient(port, info.stageToken);
  expect(await phone.next('hello')).toMatchObject({ role: 'stage', locked: false, permissions: { takeCues: true, emergency: false } });
  phone.send({ type: 'hello', name: 'Stage Left – Rahul' });
  // The first list can arrive before the AV room has pushed the show; wait for the populated one.
  let cues: Array<{ id: string; label: string; thumb: string | null }> = [];
  while (cues.length === 0) cues = (await phone.next('cues')).cues as typeof cues;
  expect(cues.length).toBeGreaterThan(3);
  expect(cues.some((c) => c.thumb?.startsWith('data:image/jpeg'))).toBe(true);

  // Tap-to-play from the stage → live on the projector, acknowledged on the phone, reported in the AV room.
  const keynote = cues.find((c) => c.label === 'Keynote Poster');
  if (!keynote) throw new Error('Keynote Poster cue missing');
  await operator.waitForTimeout(350); // the app's double-take guard
  phone.send({ type: 'action', action: 'take-cue', cueId: keynote.id, requestId: 'tk1' });
  expect(await phone.next('ack')).toMatchObject({ requestId: 'tk1', ok: true, message: expect.stringContaining('Keynote Poster') });
  await expect.poll(liveCueId).toBe(keynote.id);
  await expect(operator.getByTestId('operator-alert').filter({ hasText: 'Stage Left – Rahul' }).first()).toBeVisible();

  // Not permitted for the stage team by default.
  phone.send({ type: 'action', action: 'blackout', requestId: 'bk1' });
  expect(await phone.next('ack')).toMatchObject({ requestId: 'bk1', ok: false, message: 'Not allowed for the stage team' });
  await expect(stage.getByTestId('blackout-layer')).toHaveAttribute('data-active', 'false');

  // Crew panel: the device is listed; the lock blocks stage commands instantly.
  await operator.getByTestId('remote-indicator').click();
  await expect(operator.getByTestId('crew-clients')).toContainText('Stage Left – Rahul');
  await operator.getByTestId('crew-lock').click();
  expect(await phone.next('access')).toMatchObject({ locked: true });
  phone.send({ type: 'action', action: 'take', requestId: 'tk2' });
  expect(await phone.next('ack')).toMatchObject({ ok: false, message: 'Controls are locked by the AV room' });
  await operator.getByTestId('crew-lock').click();
  expect(await phone.next('access')).toMatchObject({ locked: false });

  // Two-way messaging.
  phone.send({ type: 'message', kind: 'guest-arrived', text: 'Chief guest has arrived' });
  await expect(operator.getByTestId('crew-message').filter({ hasText: 'Chief guest has arrived' })).toBeVisible();
  await operator.getByTestId('crew-input').fill('Copy, rolling the anthem');
  await operator.getByTestId('crew-input').press('Enter');
  const own = (await phone.next('message')).message as { kind: string };
  expect(own.kind).toBe('guest-arrived');
  expect((await phone.next('message')).message).toMatchObject({ role: 'av-room', text: 'Copy, rolling the anthem' });
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-crew.png') });
  await operator.keyboard.press('Escape');

  // The stage team turns booklet pages from the phone (part of "GO / play cues").
  const agenda = cues.find((c) => c.label === 'Agenda · p1');
  if (!agenda) throw new Error('Agenda cue missing');
  await operator.waitForTimeout(350);
  phone.send({ type: 'action', action: 'take-cue', cueId: agenda.id, requestId: 'pg0' });
  expect(await phone.next('ack')).toMatchObject({ requestId: 'pg0', ok: true });
  let paging: unknown = null;
  while (!paging) paging = ((await phone.next('status')).status as { paging: unknown }).paging;
  expect(paging).toEqual({ kind: 'pdf', page: 1, pageCount: 2 });
  phone.send({ type: 'action', action: 'page-next', requestId: 'pg1' });
  expect(await phone.next('ack')).toMatchObject({ requestId: 'pg1', ok: true, message: 'Page 2 / 2' });
  await expect.poll(stageBackdropName).toBe('01 Agenda · p2');
  await operator.waitForTimeout(200);
  phone.send({ type: 'action', action: 'page-next', requestId: 'pg2' });
  expect(await phone.next('ack')).toMatchObject({ requestId: 'pg2', ok: false, message: 'Already on the last page' });

  // The AV room's own phone has full control.
  const avPhone = await crewClient(port, info.operatorToken);
  expect(await avPhone.next('hello')).toMatchObject({ role: 'operator' });
  avPhone.send({ type: 'action', action: 'blackout', requestId: 'av1' });
  expect(await avPhone.next('ack')).toMatchObject({ ok: true, message: 'Blackout ON' });
  await expect(stage.getByTestId('blackout-layer')).toHaveAttribute('data-active', 'true');
  await operator.waitForTimeout(300);
  avPhone.send({ type: 'action', action: 'blackout', requestId: 'av2' });
  expect(await avPhone.next('ack')).toMatchObject({ ok: true, message: 'Blackout OFF' });

  // Render the real phone page (390×844) for a visual check.
  const stageUrl = `http://127.0.0.1:${port}/?t=${info.stageToken}`;
  const opened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const win = new BrowserWindow({ width: 390, height: 844, show: true, title: 'Phone preview' });
    void win.loadURL(url);
  }, stageUrl);
  const phonePage = await opened;
  await phonePage.waitForURL(/\/\?t=/);
  await phonePage.waitForSelector('#nameInput');
  await phonePage.fill('#nameInput', 'Stage Right – Priya');
  await phonePage.click('#nameSave');
  await expect(phonePage.locator('#link')).toContainText('LIVE');
  await expect(phonePage.locator('.cue').first()).toBeVisible();
  await phonePage.screenshot({ path: path.join(ARTIFACTS, 'phone-stage-team.png'), fullPage: true });
  await phonePage.locator('.cue').filter({ hasText: 'Clicker cue' }).click();
  await phonePage.click('#confirmYes');
  await expect(phonePage.locator('#toast')).toContainText('Clicker cue');
  await expect.poll(liveCueId).not.toBe(keynote.id);
  await phonePage.close();

  phone.ws.close();
  avPhone.ws.close();
  await operator.getByTestId('open-settings').click();
  await expect(operator.getByTestId('remote-qr-stage')).toBeVisible();
  await expect(operator.getByTestId('remote-qr-operator')).toBeVisible();
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-settings.png') });
  await operator.keyboard.press('Escape');
  await operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().configureRemote(false));
  await expect(fetch(stageUrl)).rejects.toThrow();
});

test('phones on another network (mobile data) reach the laptop through the internet relay', async () => {
  // A StageCue relay as it would run on a cloud host; the laptop and the phone both dial out to it.
  const relay = createRelayServer();
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', () => resolve()));
  const relayAddress = relay.address();
  const relayPort = typeof relayAddress === 'object' && relayAddress ? relayAddress.port : 0;
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  try {
    const prefs = await operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().internet ?? null);
    expect(prefs?.mode).toBe('tunnel'); // internet is the default, no same-Wi-Fi needed
    const room = prefs?.roomId ?? '';
    expect(room).toMatch(/^[a-z0-9]{8,32}$/);

    await operator.evaluate((url) => window.__STAGECUE_TEST__?.prefs.getState().setInternet({ mode: 'relay', relayUrl: url }), relayUrl);
    const port = 20000 + Math.floor(Math.random() * 20000);
    await operator.evaluate((p) => window.__STAGECUE_TEST__?.prefs.getState().configureRemote(true, p), port);
    const remoteInfo = (): Promise<RemoteInfo | null> => operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().remoteInfo ?? null);
    await expect.poll(async () => (await remoteInfo())?.internet.state, { timeout: 10_000 }).toBe('online');
    const info = await remoteInfo();
    if (!info) throw new Error('remote did not start');
    const base = `/r/${room}/`;
    const stageLink = info.links.find((l) => l.role === 'stage' && l.scope === 'internet');
    expect(stageLink?.url).toBe(`${relayUrl}${base}?t=${info.stageToken}`);

    // The phone only knows the relay address.
    const phone = await crewClient(relayPort, info.stageToken, base);
    expect(await phone.next('hello')).toMatchObject({ role: 'stage' });
    phone.send({ type: 'hello', name: 'Stage Left on 4G' });
    let cues: Array<{ id: string; label: string }> = [];
    while (cues.length === 0) cues = (await phone.next('cues')).cues as typeof cues;
    const live = await liveCueId();
    const target = cues.find((c) => c.label === 'Keynote Poster' && c.id !== live) ?? cues.find((c) => c.id !== live) ?? cues[0];
    await operator.waitForTimeout(350);
    phone.send({ type: 'action', action: 'take-cue', cueId: target.id, requestId: 'net1' });
    expect(await phone.next('ack')).toMatchObject({ requestId: 'net1', ok: true });
    await expect.poll(liveCueId).toBe(target.id);

    // Wrong links are refused by the laptop even though the relay forwards them.
    const intruder = new WebSocket(`ws://127.0.0.1:${relayPort}${base}ws?t=${'0'.repeat(32)}`);
    const code = await new Promise<number>((resolve) => intruder.addEventListener('close', (e) => resolve(e.code)));
    expect(code).toBe(4001);

    // The AV room sees the phone as an internet client, and Settings shows the internet link.
    await operator.getByTestId('remote-indicator').click();
    await expect(operator.getByTestId('crew-clients')).toContainText('internet');
    await operator.keyboard.press('Escape');
    await operator.getByTestId('open-settings').click();
    await expect(operator.getByTestId('internet-state')).toContainText(/online/i);
    await expect(operator.getByTestId('remote-links-stage')).toContainText(base);
    await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-settings-internet.png') });
    await operator.keyboard.press('Escape');

    // The real phone page, served through the relay, connects over the relay too.
    const opened = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ width: 390, height: 844, show: true, title: 'Phone preview (internet)' });
      void win.loadURL(url);
    }, stageLink?.url ?? '');
    const phonePage = await opened;
    await phonePage.waitForSelector('#nameInput');
    await phonePage.fill('#nameInput', 'Stage Right on Jio');
    await phonePage.click('#nameSave');
    await expect(phonePage.locator('#link')).toContainText('LIVE');
    await expect(phonePage.locator('.cue').first()).toBeVisible();
    await phonePage.screenshot({ path: path.join(ARTIFACTS, 'phone-internet.png'), fullPage: true });
    await phonePage.close();
    phone.ws.close();
  } finally {
    await operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().configureRemote(false));
    await operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().setInternet({ mode: 'tunnel' }));
    await relay.closeRelay();
  }
});

// Opt-in (needs cloudflared and internet): STAGECUE_E2E_REAL_TUNNEL=1
test('a phone reaches the app through a real Cloudflare tunnel', async () => {
  test.skip(process.env.STAGECUE_E2E_REAL_TUNNEL !== '1', 'set STAGECUE_E2E_REAL_TUNNEL=1 to use the real internet');
  test.setTimeout(150_000);
  try {
    await operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().setInternet({ mode: 'tunnel' }));
    const port = 20000 + Math.floor(Math.random() * 20000);
    await operator.evaluate((p) => window.__STAGECUE_TEST__?.prefs.getState().configureRemote(true, p), port);
    const remoteInfo = (): Promise<RemoteInfo | null> => operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().remoteInfo ?? null);
    await expect.poll(async () => (await remoteInfo())?.internet.state, { timeout: 60_000 }).toBe('online');
    const info = await remoteInfo();
    if (!info?.internet.publicBase) throw new Error('no tunnel address');
    const base = info.internet.publicBase;
    expect(base).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    const stageLink = info.links.find((l) => l.role === 'stage' && l.scope === 'internet');
    expect(stageLink?.url).toBe(`${base}/?t=${info.stageToken}`);

    // A brand-new trycloudflare name can take a few seconds to resolve.
    let status = 0;
    for (let i = 0; i < 30 && status !== 200; i++) {
      status = (await fetch(stageLink?.url ?? '').catch(() => null))?.status ?? 0;
      if (status !== 200) await operator.waitForTimeout(2000);
    }
    expect(status).toBe(200);

    const phone = await new Promise<CrewClient>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('https://', 'wss://')}/ws?t=${info.stageToken}`);
      const queue: Array<Record<string, unknown>> = [];
      ws.addEventListener('message', (e) => queue.push(JSON.parse(String(e.data)) as Record<string, unknown>));
      ws.addEventListener('error', () => reject(new Error('wss rejected')));
      ws.addEventListener('open', () =>
        resolve({
          ws,
          send: (m) => ws.send(JSON.stringify(m)),
          next: async (type, timeoutMs = 10_000) => {
            const deadline = Date.now() + timeoutMs;
            for (;;) {
              const i = queue.findIndex((m) => m.type === type);
              if (i >= 0) return queue.splice(i, 1)[0];
              if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
              await new Promise((r) => setTimeout(r, 25));
            }
          }
        })
      );
    });
    expect(await phone.next('hello')).toMatchObject({ role: 'stage' });
    let cues: Array<{ id: string }> = [];
    while (cues.length === 0) cues = (await phone.next('cues')).cues as typeof cues;
    const live = await liveCueId();
    const target = cues.find((c) => c.id !== live) ?? cues[0];
    await operator.waitForTimeout(350);
    const sent = Date.now();
    phone.send({ type: 'action', action: 'take-cue', cueId: target.id, requestId: 'cf1' });
    expect(await phone.next('ack')).toMatchObject({ requestId: 'cf1', ok: true });
    console.log(`real tunnel ${base}: command round trip ${Date.now() - sent} ms`);
    await expect.poll(liveCueId).toBe(target.id);
    await expect.poll(async () => (await remoteInfo())?.clients.some((c) => c.via === 'internet')).toBe(true);
    phone.ws.close();
  } finally {
    await operator.evaluate(() => window.__STAGECUE_TEST__?.prefs.getState().configureRemote(false));
  }
});

test('performer tracks download from Google Drive, show as NEW and play offline', async () => {
  // The Drive dialog itself.
  await operator.getByTestId('open-drive').click();
  await expect(operator.getByTestId('drive-modal')).toContainText('Anyone with the link');
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-drive-dialog.png') });
  await operator.keyboard.press('Escape');

  const localDir = path.join(fixtureDir, 'Drive Performer Tracks');
  const added = await operator.evaluate(
    async ({ folder, dir }) => {
      const hooks = window.__STAGECUE_TEST__;
      if (!hooks) throw new Error('E2E hooks are not exposed');
      hooks.drive.getState().setAutoSync(false);
      hooks.drive.getState().setApiKey('E2E_KEY');
      return hooks.drive.getState().addSource(`https://drive.google.com/drive/folders/${folder}?usp=sharing`, dir);
    },
    { folder: DRIVE_FOLDER, dir: localDir }
  );
  expect(added?.localPath).toBe(localDir);

  // Both tracks land on disk and in the library, marked NEW.
  const source = operator.getByTestId('drive-source');
  await expect(source).toContainText('Performer Tracks');
  await expect(source.getByTestId('drive-status')).toContainText('2 files', { timeout: 20_000 });
  expect(existsSync(path.join(localDir, 'Team Aarohi - Classical Dance.wav'))).toBe(true);
  await operator.getByRole('tab', { name: /Tracks/ }).click();
  await expect(operator.getByTestId('new-badge')).toHaveCount(2);

  // Play one: real decode through the Web Audio engine (master muted so the test is silent).
  const playing = await operator.evaluate(() => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    if (!hooks.audio.getState().isMuted) hooks.audio.getState().toggleMute();
    const track = hooks.media.getState().items.find((i) => i.name === 'Team Aarohi - Classical Dance.wav');
    if (!track) throw new Error('track missing');
    return hooks.stage.getState().takeMedia(track);
  });
  expect(playing).toBe(true);
  await expect
    .poll(() => operator.evaluate(() => window.__STAGECUE_TEST__?.audio.getState().telemetry?.musicCurrentTime ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(0.5);
  await expect
    .poll(() => operator.evaluate(() => window.__STAGECUE_TEST__?.audio.getState().telemetry?.levels.music ?? 0))
    .toBeGreaterThan(0.01);
  await expect(operator.getByTestId('new-badge')).toHaveCount(1);

  // A late submission: uploaded to Drive after the first sync, fetched by "Sync now".
  driveFiles.push({ id: 'trk3', name: 'Late Entry - Solo Vocal.wav', body: sineWav(3, 523) });
  await operator.waitForTimeout(500);
  await source.getByTestId('drive-sync-now').click();
  await expect(operator.getByTestId('operator-alert').filter({ hasText: 'Late Entry - Solo Vocal.wav' })).toBeVisible({ timeout: 15_000 });
  await expect(source.getByTestId('drive-status')).toContainText('3 files');
  await expect(operator.getByTestId('new-badge')).toHaveCount(2);
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-drive.png') });

  await operator.evaluate(() => {
    const hooks = window.__STAGECUE_TEST__;
    hooks?.audio.getState().pauseMusic();
    if (hooks?.audio.getState().isMuted) hooks.audio.getState().toggleMute();
  });
});

test('PowerPoint decks import as one backdrop per slide', async () => {
  test.setTimeout(180_000);
  const hasPowerPoint =
    process.platform === 'win32' &&
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "[bool][type]::GetTypeFromProgID('PowerPoint.Application')"], {
      encoding: 'utf8'
    }).trim() === 'True';
  test.skip(!hasPowerPoint, 'Microsoft PowerPoint is not installed on this machine');

  const deckFolder = path.join(fixtureDir, 'Awards');
  mkdirSync(deckFolder, { recursive: true });
  const deckPath = path.join(deckFolder, 'Award Night.pptx');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$app = New-Object -ComObject PowerPoint.Application',
    '$pres = $app.Presentations.Add(0)',
    "foreach ($pair in @(@(255,'WELCOME'), @(16744448,'AWARDS'), @(32768,'THANK YOU'))) {",
    '  $slide = $pres.Slides.Add($pres.Slides.Count + 1, 12)',
    '  $slide.FollowMasterBackground = 0',
    '  $slide.Background.Fill.Solid()',
    '  $slide.Background.Fill.ForeColor.RGB = $pair[0]',
    '  $box = $slide.Shapes.AddTextbox(1, 100, 200, 760, 120)',
    '  $box.TextFrame.TextRange.Text = $pair[1]',
    '  $box.TextFrame.TextRange.Font.Size = 60',
    '}',
    '$pres.SaveAs($env:STAGECUE_DECK, 24)',
    '$pres.Close()',
    'if ($app.Presentations.Count -eq 0) { $app.Quit() }'
  ].join('\n');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, STAGECUE_DECK: deckPath },
    timeout: 120_000
  });
  expect(existsSync(deckPath)).toBe(true);

  const outcome = await operator.evaluate(async (folder) => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    const result = await hooks.media.getState().rescanFolder(folder);
    return result ? result.added.map((m) => ({ name: m.name, deck: m.pdf?.originalPath ?? null, id: m.id })) : null;
  }, deckFolder);
  expect(outcome?.map((o) => o.name)).toEqual(['Award Night · slide 1', 'Award Night · slide 2', 'Award Night · slide 3']);
  expect(outcome?.every((o) => o.deck?.endsWith('Award Night.pptx'))).toBe(true);
  await operator.getByTestId('bin-image').click();
  await expect(operator.getByTestId('pdf-badge').filter({ hasText: 'SLIDE 2/3' })).toHaveCount(1);

  const slideId = outcome?.[1].id ?? '';
  await operator.waitForTimeout(350);
  const cueId = await operator.evaluate((id) => {
    const hooks = window.__STAGECUE_TEST__;
    const media = hooks?.media.getState().items.find((i) => i.id === id);
    if (!hooks || !media) throw new Error('slide missing');
    const cue = hooks.stage.getState().addMediaAsCue(media);
    hooks.stage.getState().takeCue(cue);
    return cue;
  }, slideId);
  await expect.poll(liveCueId).toBe(cueId);
  const slideImg = stage.locator(`[data-testid="backdrop-layer"] [data-active="true"] img[data-media-id="${slideId}"]`);
  await expect
    .poll(() => slideImg.evaluate((img) => (img as HTMLImageElement).naturalWidth).catch(() => 0), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1920);
  // Slides are turned live like booklet pages.
  const controls = operator.getByTestId('monitor-program').getByTestId('page-controls');
  await expect(controls).toContainText('Slide');
  await controls.getByTestId('page-next').click();
  await expect.poll(stageBackdropName).toBe('Award Night · slide 3');
  expect(await liveCueId()).toBe(cueId);
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-slides.png') });
});

test('pre-show check decodes every cue and summarises the show', async () => {
  await operator.getByTestId('open-preshow').click();
  await expect(operator.getByTestId('preshow-summary')).toBeVisible({ timeout: 30_000 });
  const mode = await stage.getByTestId('stage-root').getAttribute('data-mode');
  if (mode !== 'projector') {
    await expect(operator.getByTestId('preshow-modal')).toContainText('No projector detected');
  }
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-preshow.png') });
  await operator.keyboard.press('Escape');
  await expect(operator.getByTestId('preshow-modal')).toHaveCount(0);
  await expect(stage.getByTestId('blackout-layer')).toHaveAttribute('data-active', 'false');
});

test('the run sheet exports as a real PDF', async () => {
  const pdfPath = path.join(fixtureDir, 'Untitled Show - Run Sheet.pdf');
  await operator.getByRole('button', { name: 'Export run sheet PDF' }).click();
  await expect.poll(() => (existsSync(pdfPath) ? statSync(pdfPath).size : 0), { timeout: 20_000 }).toBeGreaterThan(5000);
  expect(readFileSync(pdfPath).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  copyFileSync(pdfPath, path.join(ARTIFACTS, 'run-sheet.pdf'));
});

test('audio output devices are listed and selectable', async () => {
  await expect
    .poll(() => operator.evaluate(() => window.__STAGECUE_TEST__?.audio.getState().outputSupported ?? false))
    .toBe(true);
  const devices = await operator.evaluate(() => window.__STAGECUE_TEST__?.audio.getState().outputDevices ?? []);
  test.info().annotations.push({ type: 'audio outputs', description: devices.map((d) => d.label).join(' | ') || 'none' });
  test.skip(devices.length === 0, 'This machine reports no audio output devices');
  const target = devices[0].deviceId;
  await operator.evaluate((id) => window.__STAGECUE_TEST__?.audio.getState().setOutputDevice(id), target);
  await expect.poll(() => operator.evaluate(() => window.__STAGECUE_TEST__?.audio.getState().currentSinkId ?? '')).toBe(target);
  await operator.evaluate(() => window.__STAGECUE_TEST__?.audio.getState().setOutputDevice(''));
  await expect.poll(() => operator.evaluate(() => window.__STAGECUE_TEST__?.audio.getState().currentSinkId ?? 'x')).toBe('');
});

/** A tiny flipbook: arrow keys and clicks turn pages; the title reports the last input and whether it was real (trusted). */
const FLIPBOOK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Test Flipbook</title>
<style>html,body{margin:0;height:100%;background:#0b1d3a;color:#fff;font:bold 30vh system-ui;display:flex;align-items:center;justify-content:center}</style></head>
<body><div id="n">1</div><script>
var page = Number(new URLSearchParams(location.search).get('page') || 1), last = 'none';
function show() { document.getElementById('n').textContent = page; history.replaceState(null, '', location.pathname + '?page=' + page); document.title = 'Test Flipbook p' + page + ' ' + last; }
addEventListener('keydown', function (e) { last = 'key:' + e.key + ':' + e.isTrusted; if (e.key === 'ArrowRight') page++; if (e.key === 'ArrowLeft' && page > 1) page--; show(); });
addEventListener('click', function (e) { last = 'click:' + e.isTrusted; if (e.clientX > innerWidth / 2) page++; else if (page > 1) page--; show(); });
show();
</script></body></html>`;

interface WebFrameLike {
  mediaId: string;
  url: string;
  title: string;
}

const webFrame = (): Promise<WebFrameLike | null> =>
  operator.evaluate(() => {
    const frame = window.__STAGECUE_TEST__?.web.getState().frame;
    return frame ? { mediaId: frame.mediaId, url: frame.url, title: frame.title } : null;
  });

test('a web flipbook plays on stage and is turned from the operator window (buttons, clicker, clicks, freeze)', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(FLIPBOOK_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/magazine`;
  try {
    // Library → Live → Web page.
    await operator.getByTestId('bin-live').click();
    await operator.getByTestId('add-web-page').click();
    await operator.getByTestId('web-url').fill(url);
    await operator.getByTestId('web-add').click();
    await expect(operator.getByTestId('web-page-modal')).toHaveCount(0, { timeout: 20_000 });
    const card = operator.getByTestId('media-card').filter({ has: operator.getByTestId('live-badge') });
    await expect(card.first()).toContainText('Test Flipbook');
    await expect(card.first().getByTestId('live-badge')).toHaveText('WEB');

    const ids = await operator.evaluate((address) => {
      const hooks = window.__STAGECUE_TEST__;
      const media = hooks?.media.getState().items.find((i) => i.type === 'web' && i.filePath === address);
      if (!hooks || !media) throw new Error('web page missing');
      const cue = hooks.stage.getState().addMediaAsCue(media);
      return { cue, media: media.id };
    }, url);
    await operator.waitForTimeout(350);
    await operator.evaluate((id) => window.__STAGECUE_TEST__?.stage.getState().takeCue(id), ids.cue);
    await expect.poll(liveCueId).toBe(ids.cue);

    // The page runs inside the stage window…
    await expect(stage.locator(`[data-testid="backdrop-layer"] [data-active="true"] webview[data-media-id="${ids.media}"]`)).toBeAttached({
      timeout: 15_000
    });
    // …and the operator sees it live and controls it from the Program monitor.
    await expect.poll(async () => (await webFrame())?.title ?? '', { timeout: 15_000 }).toContain('Test Flipbook p1');
    const program = operator.getByTestId('monitor-program');
    await expect(program.getByTestId('web-remote-image')).toBeVisible();
    await expect(program.getByTestId('page-controls')).toHaveAttribute('data-kind', 'web');

    await program.getByTestId('page-next').click();
    await expect.poll(async () => (await webFrame())?.title ?? '').toContain('p2 key:ArrowRight:true');
    expect((await webFrame())?.url).toContain('?page=2');
    await expect(program.getByTestId('page-label')).toContainText('Page 2');

    // The clicker turns the flipbook too.
    await operator.locator('body').click({ position: { x: 5, y: 600 } });
    await operator.keyboard.press('PageDown');
    await expect.poll(async () => (await webFrame())?.title ?? '').toContain('p3 key:ArrowRight:true');
    await operator.waitForTimeout(250); // faster key presses count as a clicker double-fire
    await operator.keyboard.press('PageUp');
    await expect.poll(async () => (await webFrame())?.title ?? '').toContain('p2 key:ArrowLeft:true');

    // Clicking the live picture clicks the page on the projector (right half = next page).
    const picture = program.getByTestId('web-remote-image');
    const box = await picture.boundingBox();
    if (!box) throw new Error('no live picture');
    await operator.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.5);
    await expect.poll(async () => (await webFrame())?.title ?? '').toContain('p3 click:true');
    await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-web-flipbook.png') });
    await stage.screenshot({ path: path.join(ARTIFACTS, 'stage-web-flipbook.png') });

    // Freeze holds a still of the page while the operator keeps flipping underneath.
    await operator.keyboard.press('F8');
    await expect(stage.getByTestId('freeze-layer')).toHaveAttribute('data-active', 'true');
    await expect
      .poll(() => operator.evaluate(() => window.__STAGECUE_TEST__?.stage.getState().lastFreezeAck?.source ?? null))
      .toBe('backdrop');
    await program.getByTestId('page-next').click();
    await expect.poll(async () => (await webFrame())?.title ?? '').toContain('p4');
    await expect(stage.getByTestId('freeze-layer')).toHaveAttribute('data-active', 'true');
    await operator.keyboard.press('F8');
    await expect(stage.getByTestId('freeze-layer')).toHaveAttribute('data-active', 'false');

    // Home goes back to the cue's start address.
    await program.getByRole('button', { name: 'Start again' }).click();
    await expect.poll(async () => (await webFrame())?.title ?? '').toContain('Test Flipbook p1 none');
  } finally {
    server.close();
  }
});

test('a window or screen can be shown live on stage', async () => {
  await operator.getByTestId('bin-live').click();
  await operator.getByTestId('add-capture').click();
  await expect(operator.getByTestId('capture-source').first()).toBeVisible({ timeout: 15_000 });
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-capture-picker.png') });
  // A whole screen always exists; pick it.
  await operator.getByTestId('capture-modal').getByText('Whole screens').waitFor();
  const screenSource = operator.getByTestId('capture-source').filter({ hasText: /screen/i }).first();
  await screenSource.click();
  await expect(operator.getByTestId('capture-modal')).toHaveCount(0);

  const ids = await operator.evaluate(() => {
    const hooks = window.__STAGECUE_TEST__;
    const media = hooks?.media.getState().items.find((i) => i.type === 'screen');
    if (!hooks || !media) throw new Error('capture missing');
    return { cue: hooks.stage.getState().addMediaAsCue(media), media: media.id };
  });
  await operator.waitForTimeout(350);
  await operator.evaluate((id) => window.__STAGECUE_TEST__?.stage.getState().takeCue(id), ids.cue);
  const video = stage.locator(`[data-testid="backdrop-layer"] [data-active="true"] video[data-media-id="${ids.media}"]`);
  await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth).catch(() => 0), { timeout: 15_000 }).toBeGreaterThan(0);
  await stage.screenshot({ path: path.join(ARTIFACTS, 'stage-screen-capture.png') });
  // Nothing went wrong on the way (e.g. a refused capture permission).
  const alerts = await operator.evaluate(() => window.__STAGECUE_TEST__?.show.getState().alerts.map((a) => a.title) ?? []);
  expect(alerts.filter((t) => t.startsWith('Cannot play'))).toEqual([]);
  // Freezing a live window works like any video.
  await operator.keyboard.press('F8');
  await expect
    .poll(() => operator.evaluate(() => window.__STAGECUE_TEST__?.stage.getState().lastFreezeAck?.source ?? null))
    .toBe('backdrop');
  await operator.keyboard.press('F8');
  await expect(stage.getByTestId('freeze-layer')).toHaveAttribute('data-active', 'false');
});

// Opt-in (needs internet): STAGECUE_E2E_REAL_WEB=1 opens the real annual magazine and turns a page.
test('the real Netted Bytes flipbook turns its pages from StageCue', async () => {
  test.skip(process.env.STAGECUE_E2E_REAL_WEB !== '1', 'set STAGECUE_E2E_REAL_WEB=1 to use the real magazine');
  test.setTimeout(120_000);
  const url = 'https://fests.ggsipuedc.workers.dev/netted-bytes';
  const ids = await operator.evaluate((address) => {
    const hooks = window.__STAGECUE_TEST__;
    if (!hooks) throw new Error('E2E hooks are not exposed');
    const media = hooks.media.getState().addWebPage(address, 'Netted Bytes', null);
    return { cue: hooks.stage.getState().addMediaAsCue(media), media: media.id };
  }, url);
  await operator.waitForTimeout(350);
  await operator.evaluate((id) => window.__STAGECUE_TEST__?.stage.getState().takeCue(id), ids.cue);
  await expect.poll(async () => (await webFrame())?.title ?? '', { timeout: 45_000 }).toContain('Netted Bytes');
  await operator.waitForTimeout(3000);
  const program = operator.getByTestId('monitor-program');
  await program.getByTestId('page-next').click();
  await expect.poll(async () => (await webFrame())?.url ?? '', { timeout: 20_000 }).toMatch(/[?&]page=2/);
  await operator.waitForTimeout(1500);
  await program.getByTestId('page-next').click();
  await expect.poll(async () => (await webFrame())?.url ?? '', { timeout: 20_000 }).toMatch(/[?&]page=(3|4)/);
  await operator.waitForTimeout(1500);
  await operator.screenshot({ path: path.join(ARTIFACTS, 'operator-real-magazine.png') });
  await stage.screenshot({ path: path.join(ARTIFACTS, 'stage-real-magazine.png') });
});
