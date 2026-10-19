import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { FolderScanResult, ResolvedMediaFile } from '../renderer/src/types';
import { classifyMediaPath, resolveMediaFile } from './protocolHandler';

/* =========================================================================
 * Event-folder scanning: walks a show folder (and its sub-folders), collects
 * every supported image / video / audio file in natural order, and registers
 * them with the local-media:// allowlist.
 * ========================================================================= */

export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_FILES = 3000;

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  '__macosx',
  '.git',
  '.trash',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd'
]);

export interface ScanOptions {
  maxDepth?: number;
  maxFiles?: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** "02 Poster" sorts before "10 Poster", folders before their deeper contents. */
export function compareMediaPaths(root: string, a: string, b: string): number {
  const ra = path.relative(root, a).split(path.sep);
  const rb = path.relative(root, b).split(path.sep);
  const length = Math.min(ra.length, rb.length);
  for (let i = 0; i < length; i += 1) {
    const aIsLast = i === ra.length - 1;
    const bIsLast = i === rb.length - 1;
    // Files directly in a folder come before that folder's sub-folders.
    if (aIsLast !== bIsLast) return aIsLast ? -1 : 1;
    const diff = collator.compare(ra[i], rb[i]);
    if (diff !== 0) return diff;
  }
  return ra.length - rb.length;
}

function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') || IGNORED_DIRECTORIES.has(name.toLowerCase());
}

interface CollectState {
  mediaPaths: string[];
  skipped: number;
  truncated: boolean;
}

async function collect(dir: string, depth: number, options: Required<ScanOptions>, state: CollectState): Promise<void> {
  if (state.truncated) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    state.skipped += 1;
    return;
  }
  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (isIgnoredName(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < options.maxDepth) subdirectories.push(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!classifyMediaPath(full)) {
      state.skipped += 1;
      continue;
    }
    if (state.mediaPaths.length >= options.maxFiles) {
      state.truncated = true;
      return;
    }
    state.mediaPaths.push(full);
  }
  for (const sub of subdirectories) {
    await collect(sub, depth + 1, options, state);
    if (state.truncated) return;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function scanMediaFolder(folderPath: string, options: ScanOptions = {}): Promise<FolderScanResult> {
  const root = path.resolve(folderPath);
  if (!(await isDirectory(root))) {
    return { folderPath: root, exists: false, files: [], skipped: 0, truncated: false };
  }
  const resolvedOptions: Required<ScanOptions> = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES
  };
  const state: CollectState = { mediaPaths: [], skipped: 0, truncated: false };
  await collect(root, 0, resolvedOptions, state);
  state.mediaPaths.sort((a, b) => compareMediaPaths(root, a, b));
  const files: ResolvedMediaFile[] = await Promise.all(state.mediaPaths.map((filePath) => resolveMediaFile({ filePath })));
  return {
    folderPath: root,
    exists: true,
    files: files.filter((f) => f.exists),
    skipped: state.skipped,
    truncated: state.truncated
  };
}

/** Expands a mixed list of dropped files and folders into importable media. */
export async function expandMediaPaths(
  paths: string[],
  options: ScanOptions = {}
): Promise<{ files: ResolvedMediaFile[]; folders: FolderScanResult[] }> {
  const files: ResolvedMediaFile[] = [];
  const folders: FolderScanResult[] = [];
  for (const target of paths) {
    if (await isDirectory(target)) {
      const scan = await scanMediaFolder(target, options);
      folders.push(scan);
      files.push(...scan.files);
    } else {
      files.push(await resolveMediaFile({ filePath: target }));
    }
  }
  return { files, folders };
}
