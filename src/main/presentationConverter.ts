import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* =========================================================================
 * PowerPoint / Impress decks → PDF, so every slide becomes a backdrop through
 * the existing PDF pipeline (rendered once at projector resolution).
 *
 *   Windows : Microsoft PowerPoint (COM automation) → LibreOffice fallback
 *   macOS   : LibreOffice
 *   Linux   : LibreOffice
 *
 * Results are cached by source path + size + modification time, so a deck is
 * converted once; editing and saving it triggers a fresh conversion.
 * ========================================================================= */

export const PRESENTATION_EXTENSIONS = ['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odp'] as const;
export const CONVERSION_TIMEOUT_MS = 180_000;

export function isPresentationPath(filePath: string): boolean {
  return (PRESENTATION_EXTENSIONS as readonly string[]).includes(path.extname(filePath).toLowerCase());
}

export type ConverterName = 'powerpoint' | 'libreoffice';

export function converterOrder(platform: string): ConverterName[] {
  return platform === 'win32' ? ['powerpoint', 'libreoffice'] : ['libreoffice'];
}

/** Standard LibreOffice locations plus PATH. */
export function sofficeCandidates(platform: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']) {
      if (base) candidates.push(path.win32.join(base, 'LibreOffice', 'program', 'soffice.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  } else {
    candidates.push('/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice');
  }
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of pathDirs) {
    candidates.push(path.join(dir, platform === 'win32' ? 'soffice.exe' : 'soffice'));
  }
  return [...new Set(candidates)];
}

export function findSoffice(platform: string, exists: (p: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env): string | null {
  return sofficeCandidates(platform, env).find((p) => exists(p)) ?? null;
}

/**
 * PowerShell script driving PowerPoint through COM. Paths arrive in
 * environment variables, never inside the script text. If PowerPoint was
 * already running with the operator's own decks open, it is left running.
 */
export const POWERPOINT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$src = $env:STAGECUE_PPT_SRC',
  '$dst = $env:STAGECUE_PPT_DST',
  '$app = New-Object -ComObject PowerPoint.Application',
  "'STAGE:STARTED'",
  '$pres = $null',
  'try {',
  '  $pres = $app.Presentations.Open($src, -1, 0, 0)',
  "  'STAGE:OPENED'",
  '  $pres.SaveAs($dst, 32)',
  "  'STAGE:SAVED'",
  '} finally {',
  '  if ($pres -ne $null) { $pres.Close() }',
  '  if ($app.Presentations.Count -eq 0) { $app.Quit() }',
  '}'
].join('\n');

class ConversionStepError extends Error {
  constructor(
    message: string,
    readonly stdout: string
  ) {
    super(message);
  }
}

/** Last progress marker the PowerPoint script printed ("STAGE:OPENED" → "opened"). */
export function lastStage(stdout: string): string {
  const stages = [...stdout.matchAll(/STAGE:([A-Z]+)/g)].map((m) => m[1].toLowerCase());
  return stages.length > 0 ? stages[stages.length - 1] : 'not started';
}

/** The meaningful part of a PowerShell/LibreOffice error (drops "At line" and "+ ~~~" decoration). */
export function summarizeError(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('+') && !/^At line:\d+/i.test(l) && !/^At [A-Z]:\\/.test(l));
  return lines.slice(0, 2).join(' ').slice(0, 400);
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = summarizeError(String(stderr || '')) || error.message;
        reject(new ConversionStepError(error.killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : detail, String(stdout)));
        return;
      }
      resolve(String(stdout));
    });
  });
}

async function nonEmpty(filePath: string): Promise<boolean> {
  try {
    return (await fsp.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}

/**
 * PowerPoint always exports into a fresh folder under %TEMP%: some Office
 * security policies make SaveAs-PDF fail (E_FAIL) when PowerPoint writes into
 * AppData, which is where the app keeps its cache. The PDF is then copied over.
 */
async function convertWithPowerPoint(source: string, target: string, timeoutMs: number): Promise<void> {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stagecue-ppt-'));
  const exported = path.join(outDir, 'slides.pdf');
  try {
    try {
      await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERPOINT_SCRIPT],
        { ...process.env, STAGECUE_PPT_SRC: source, STAGECUE_PPT_DST: exported },
        timeoutMs
      );
    } catch (error) {
      // A failure while PowerPoint closes after a successful save still produced a usable PDF.
      if (!(await nonEmpty(exported))) {
        const stage = error instanceof ConversionStepError ? lastStage(error.stdout) : 'not started';
        throw new Error(`${error instanceof Error ? error.message : String(error)} (step reached: ${stage})`);
      }
    }
    if (!(await nonEmpty(exported))) throw new Error('PowerPoint did not produce a PDF');
    await fsp.copyFile(exported, target);
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
}

async function convertWithLibreOffice(source: string, target: string, timeoutMs: number): Promise<void> {
  const soffice = findSoffice(process.platform);
  if (!soffice) throw new Error('LibreOffice is not installed');
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stagecue-ppt-'));
  try {
    await run(soffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, source], process.env, timeoutMs);
    const produced = path.join(outDir, `${path.basename(source, path.extname(source))}.pdf`);
    if (!(await nonEmpty(produced))) throw new Error('LibreOffice did not produce a PDF');
    await fsp.copyFile(produced, target);
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true });
  }
}

export async function convertedPdfPath(cacheRoot: string, source: string): Promise<string> {
  const stat = await fsp.stat(source);
  const normalized = process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(source).toLowerCase() : path.resolve(source);
  const hash = createHash('sha1').update(`${normalized}|${stat.size}|${Math.round(stat.mtimeMs)}`).digest('hex').slice(0, 20);
  const stem = path.basename(source, path.extname(source)).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'deck';
  return path.join(path.resolve(cacheRoot), 'presentations', `${stem}-${hash}.pdf`);
}

export interface ConvertOptions {
  timeoutMs?: number;
  /** Override for tests. */
  converters?: Partial<Record<ConverterName, (source: string, target: string, timeoutMs: number) => Promise<void>>>;
  platform?: string;
}

const inFlight = new Map<string, Promise<string>>();

/** Returns the path of a PDF with one page per slide (cached). */
export function convertPresentation(source: string, cacheRoot: string, options: ConvertOptions = {}): Promise<string> {
  const key = path.resolve(source).toLowerCase();
  const running = inFlight.get(key);
  if (running) return running;
  const job = doConvert(source, cacheRoot, options).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

async function doConvert(source: string, cacheRoot: string, options: ConvertOptions): Promise<string> {
  if (!isPresentationPath(source)) throw new Error('Not a PowerPoint or Impress file');
  const target = await convertedPdfPath(cacheRoot, source);
  if (await nonEmpty(target)) return target;
  await fsp.mkdir(path.dirname(target), { recursive: true });

  const timeoutMs = options.timeoutMs ?? CONVERSION_TIMEOUT_MS;
  const converters: Record<ConverterName, (s: string, t: string, ms: number) => Promise<void>> = {
    powerpoint: options.converters?.powerpoint ?? convertWithPowerPoint,
    libreoffice: options.converters?.libreoffice ?? convertWithLibreOffice
  };
  const tmpTarget = `${target}.${process.pid}.partial.pdf`;
  const failures: string[] = [];
  for (const name of converterOrder(options.platform ?? process.platform)) {
    try {
      await fsp.rm(tmpTarget, { force: true });
      await converters[name](path.resolve(source), tmpTarget, timeoutMs);
      if (!(await nonEmpty(tmpTarget))) throw new Error('no output');
      await fsp.rename(tmpTarget, target);
      return target;
    } catch (error) {
      failures.push(`${name === 'powerpoint' ? 'PowerPoint' : 'LibreOffice'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await fsp.rm(tmpTarget, { force: true });
  throw new Error(
    `Could not convert the slides. Install Microsoft PowerPoint or LibreOffice, or save the deck as PDF ` +
      `(File → Export → PDF) and import that. Details: ${failures.join(' | ')}`
  );
}
