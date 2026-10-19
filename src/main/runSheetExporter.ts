import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import type { RunSheetExportRequest, RunSheetExportResult } from '../renderer/src/types';

/* Renders the run-sheet HTML in a hidden, script-less window and either saves
 * it as an A4 landscape PDF or opens the system print dialog. */

export const MAX_RUNSHEET_BYTES = 40 * 1024 * 1024;

export function isRunSheetRequest(value: unknown): value is RunSheetExportRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<RunSheetExportRequest>;
  return (
    typeof r.html === 'string' &&
    r.html.length > 0 &&
    r.html.length <= MAX_RUNSHEET_BYTES &&
    (r.mode === 'pdf' || r.mode === 'print') &&
    typeof r.suggestedName === 'string'
  );
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Run Sheet').slice(0, 120);
}

export async function exportRunSheet(
  request: RunSheetExportRequest,
  parent: BrowserWindow | null,
  tempDir: string,
  /** Automated tests only: write here instead of asking with a save dialog. */
  fixedOutputDir: string | null = null
): Promise<RunSheetExportResult> {
  let targetPath: string | null = null;
  if (request.mode === 'pdf' && fixedOutputDir) {
    targetPath = path.join(fixedOutputDir, `${safeFileName(request.suggestedName)}.pdf`);
  } else if (request.mode === 'pdf') {
    const options = {
      title: 'Export run sheet',
      buttonLabel: 'Export PDF',
      defaultPath: `${safeFileName(request.suggestedName)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    };
    const choice = parent && !parent.isDestroyed() ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };
    targetPath = choice.filePath;
  }

  const htmlPath = path.join(tempDir, `stagecue-runsheet-${process.pid}-${Date.now()}.html`);
  await fsp.writeFile(htmlPath, request.html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 1123,
    height: 794,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false, spellcheck: false }
  });
  try {
    await win.loadFile(htmlPath);
    if (request.mode === 'pdf' && targetPath) {
      const pdf = await win.webContents.printToPDF({
        landscape: true,
        pageSize: 'A4',
        printBackground: true,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
      });
      await fsp.writeFile(targetPath, pdf);
      return { ok: true, filePath: targetPath };
    }
    const result = await new Promise<{ success: boolean; reason: string }>((resolve) => {
      win.webContents.print({ silent: false, printBackground: true, landscape: true }, (success, reason) =>
        resolve({ success, reason })
      );
    });
    if (result.success) return { ok: true, filePath: null };
    return { ok: false, canceled: result.reason === 'cancelled', error: result.reason === 'cancelled' ? undefined : result.reason };
  } catch (error) {
    return { ok: false, canceled: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    win.destroy();
    await fsp.rm(htmlPath, { force: true });
  }
}
