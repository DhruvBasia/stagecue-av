import type { UpdateStatus } from '../renderer/src/types';

/* =========================================================================
 * Self-update from the public installers repo (DhruvBasia/stagecue-av-releases).
 *
 * New versions download quietly in the background. StageCue never restarts by
 * itself during a show: the update installs when StageCue is closed, or right
 * away when the operator presses "Restart to update".
 * ========================================================================= */

const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** The parts of electron-updater's autoUpdater used here (injectable for tests). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdaterOptions {
  currentVersion: string;
  /** False in development builds and automated tests. */
  enabled: boolean;
  /** Loaded lazily so development builds never touch electron-updater. */
  loadUpdater: () => Promise<UpdaterLike>;
  onStatus: (status: UpdateStatus) => void;
  /** Called right before the app quits to install (skips the "quit?" prompt). */
  onBeforeInstall: () => void;
}

/** Turns updater errors into something an operator can act on. */
export function describeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ENETUNREACH/i.test(message)) return 'No internet connection';
  if (/404|latest\.yml|Cannot find/i.test(message)) return 'No published update found yet';
  if (/ETIMEDOUT|timeout/i.test(message)) return 'The update server did not answer in time';
  return message.split('\n')[0].slice(0, 200);
}

export class AppUpdater {
  private status: UpdateStatus;
  private updater: UpdaterLike | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: AppUpdaterOptions) {
    this.status = {
      state: options.enabled ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
      version: null,
      percent: null,
      error: null,
      checkedAt: null
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /** Starts the background checks (first one shortly after launch, then every few hours). */
  start(): void {
    if (!this.options.enabled) return;
    this.firstTimer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.firstTimer !== null) clearTimeout(this.firstTimer);
    if (this.interval !== null) clearInterval(this.interval);
    this.firstTimer = null;
    this.interval = null;
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.options.onStatus(this.getStatus());
  }

  private async load(): Promise<UpdaterLike> {
    if (this.updater) return this.updater;
    const updater = await this.options.loadUpdater();
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on('checking-for-update', () => {
      if (this.status.state !== 'downloading' && this.status.state !== 'ready') this.set({ state: 'checking', error: null });
    });
    updater.on('update-available', (info) => this.set({ state: 'downloading', version: info.version, percent: 0, error: null }));
    updater.on('update-not-available', () => this.set({ state: 'up-to-date', version: null, percent: null, error: null, checkedAt: Date.now() }));
    updater.on('download-progress', (progress) =>
      this.set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) })
    );
    updater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version, percent: 100, checkedAt: Date.now() }));
    updater.on('error', (error) => {
      // A failed check never hides an update that is already downloaded.
      if (this.status.state === 'ready') return;
      this.set({ state: 'error', error: describeUpdateError(error), percent: null, checkedAt: Date.now() });
    });
    this.updater = updater;
    return updater;
  }

  async check(): Promise<UpdateStatus> {
    if (!this.options.enabled) return this.getStatus();
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'ready') return this.getStatus();
    try {
      const updater = await this.load();
      this.set({ state: 'checking', error: null });
      await updater.checkForUpdates();
    } catch (error) {
      // Events may have moved the state on while the check was running.
      if (!this.isReady()) this.set({ state: 'error', error: describeUpdateError(error), checkedAt: Date.now() });
    }
    return this.getStatus();
  }

  private isReady(): boolean {
    return this.status.state === 'ready';
  }

  /** Installs the downloaded update now: StageCue closes, updates silently and opens again. */
  install(): boolean {
    if (this.status.state !== 'ready' || !this.updater) return false;
    this.options.onBeforeInstall();
    this.updater.quitAndInstall(true, true);
    return true;
  }
}
