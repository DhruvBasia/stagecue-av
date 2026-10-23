import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AppUpdater, describeUpdateError, type UpdaterLike } from '../../src/main/updater';
import type { UpdateStatus } from '../../src/renderer/src/types';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installed: Array<[boolean | undefined, boolean | undefined]> = [];
  nextCheck: () => void = () => this.emit('update-not-available', { version: '1.2.0' });

  async checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    this.nextCheck();
    return null;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installed.push([isSilent, isForceRunAfter]);
  }
}

function setup(enabled = true): { updater: AppUpdater; fake: FakeUpdater; statuses: UpdateStatus[]; beforeInstall: ReturnType<typeof vi.fn> } {
  const fake = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  const beforeInstall = vi.fn();
  const updater = new AppUpdater({
    currentVersion: '1.2.0',
    enabled,
    loadUpdater: async () => fake as unknown as UpdaterLike,
    onStatus: (s) => statuses.push(s),
    onBeforeInstall: beforeInstall
  });
  return { updater, fake, statuses, beforeInstall };
}

describe('self-update', () => {
  it('does nothing in development builds and tests', async () => {
    const { updater, fake } = setup(false);
    expect((await updater.check()).state).toBe('unsupported');
    expect(fake.checks).toBe(0);
    expect(updater.install()).toBe(false);
  });

  it('downloads a new version in the background and installs only when asked', async () => {
    const { updater, fake, statuses, beforeInstall } = setup();
    fake.nextCheck = () => {
      fake.emit('update-available', { version: '1.3.0' });
      fake.emit('download-progress', { percent: 41.7 });
      fake.emit('update-downloaded', { version: '1.3.0' });
    };
    const status = await updater.check();
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(statuses.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloading', 'ready']);
    expect(statuses[2].percent).toBe(42);
    expect(status).toMatchObject({ state: 'ready', version: '1.3.0', currentVersion: '1.2.0' });
    // Nothing restarts by itself; the operator decides.
    expect(fake.installed).toEqual([]);
    // A later check or a network error never hides the ready update.
    fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect((await updater.check()).state).toBe('ready');
    expect(fake.checks).toBe(1);

    expect(updater.install()).toBe(true);
    expect(beforeInstall).toHaveBeenCalledTimes(1);
    expect(fake.installed).toEqual([[true, true]]);
  });

  it('reports up to date, and explains errors', async () => {
    const { updater, fake } = setup();
    expect((await updater.check()).state).toBe('up-to-date');
    fake.nextCheck = () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    };
    expect(await updater.check()).toMatchObject({ state: 'error', error: 'No internet connection' });
    expect(updater.install()).toBe(false);
    expect(describeUpdateError(new Error('HttpError: 404 \nCannot find latest.yml'))).toBe('No published update found yet');
  });
});
