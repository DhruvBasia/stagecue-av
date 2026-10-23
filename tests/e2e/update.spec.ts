import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { StageCueApi, UpdateStatus } from '../../src/renderer/src/types';

/* =========================================================================
 * Opt-in, real-network check of self-updating, run against an installed
 * OLDER build (e.g. 1.1.9):
 *
 *   $env:STAGECUE_E2E_EXECUTABLE = "$env:LOCALAPPDATA\Programs\StageCue AV\StageCue AV.exe"
 *   $env:STAGECUE_E2E_UPDATE_TO  = "1.2.0"     # the latest published version
 *   npx playwright test tests/e2e/update.spec.ts
 *
 * It finds the newer version on github.com/DhruvBasia/stagecue-av-releases,
 * downloads it, installs it silently and checks Windows now lists that version.
 * ========================================================================= */

declare global {
  interface Window {
    api: StageCueApi;
  }
}

const EXE = process.env.STAGECUE_E2E_EXECUTABLE;
const TARGET = process.env.STAGECUE_E2E_UPDATE_TO;

function installedVersion(): string | null {
  const script =
    "(Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object DisplayName -like 'StageCue*' | Select-Object -First 1).DisplayVersion";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
  return out || null;
}

test('an installed StageCue finds, downloads and installs the published update', async () => {
  test.skip(!EXE || !TARGET, 'set STAGECUE_E2E_EXECUTABLE and STAGECUE_E2E_UPDATE_TO to run');
  test.setTimeout(600_000);
  const before = installedVersion();
  expect(before).not.toBe(TARGET);

  const app = await electron.launch({
    executablePath: EXE as string,
    args: ['--stagecue-e2e', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'stagecue-update-'))}`],
    env: { ...process.env, STAGECUE_E2E: '1', STAGECUE_E2E_UPDATER: '1' }
  });
  // The operator window (the stage window may open first).
  let operator = app.windows().find((w) => w.url().includes('index.html'));
  const deadline = Date.now() + 30_000;
  while (!operator && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    operator = app.windows().find((w) => w.url().includes('index.html'));
  }
  if (!operator) throw new Error('operator window did not open');
  await operator.waitForLoadState('domcontentloaded');

  const status = (): Promise<UpdateStatus> => operator.evaluate(() => window.api.invoke('app:update-check'));
  expect((await status()).currentVersion).toBe(before);
  await expect
    .poll(async () => {
      const s = await status();
      return s.state === 'ready' ? `ready:${s.version}` : s.state === 'error' ? `error:${s.error}` : s.state;
    }, { timeout: 300_000, intervals: [2000] })
    .toBe(`ready:${TARGET}`);
  await expect(operator.getByTestId('update-ready')).toContainText(TARGET as string);
  await operator.screenshot({ path: path.join(__dirname, '..', '..', 'test-results', 'operator-update-ready.png') });

  // "Restart to update": StageCue closes, installs silently and reopens.
  const startedAt = Date.now();
  const closed = app.waitForEvent('close', { timeout: 120_000 });
  await operator.evaluate(() => void window.api.invoke('app:update-install')).catch(() => undefined);
  await closed;
  test.info().annotations.push({ type: 'closed after', description: `${Date.now() - startedAt} ms` });
  await expect.poll(installedVersion, { timeout: 180_000, intervals: [3000] }).toBe(TARGET);
  test.info().annotations.push({ type: 'installed after', description: `${Date.now() - startedAt} ms` });
  // …and opens again by itself.
  await expect.poll(stageCueWindowOpen, { timeout: 120_000, intervals: [2000] }).toBe(true);
});

function stageCueWindowOpen(): boolean {
  const script =
    "@(Get-Process 'StageCue AV' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'StageCue AV*' }).Count";
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()) > 0;
}
