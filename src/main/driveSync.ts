import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { DriveSource, DriveSyncProgress, DriveSyncResult } from '../renderer/src/types';
import { classifyMediaPath } from './protocolHandler';

/* =========================================================================
 * Google Drive → local folder sync for performer tracks.
 *
 * Performers upload to a Drive folder shared as "Anyone with the link".
 * StageCue downloads every playable file into a local folder (linked to the
 * media library), so nothing depends on the internet during the show.
 *
 *  - With an API key: official Drive API v3 (reliable, sizes, change detection).
 *  - Without a key:   the public "embedded folder view" page (undocumented,
 *                     best effort; Google may change it).
 *
 * A small manifest remembers what was downloaded, so later syncs only fetch
 * new or changed files. Files deleted on Drive are kept locally.
 * ========================================================================= */

export const DEFAULT_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DEFAULT_PAGE_BASE = 'https://drive.google.com';
export const DEFAULT_DOWNLOAD_BASE = 'https://drive.usercontent.google.com';
export const MANIFEST_NAME = '.stagecue-drive.json';
const MAX_DEPTH = 3;
const MAX_FILES = 2000;
const DOWNLOAD_CONCURRENCY = 2;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveLink {
  folderId: string;
  resourceKey?: string;
}

/** Accepts folder share links, "open?id=" links, or a bare folder id. */
export function parseDriveFolderLink(input: string): DriveLink | null {
  const text = input.trim();
  if (!text) return null;
  let folderId: string | null = null;
  let resourceKey: string | undefined;
  const folderMatch = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(text);
  if (folderMatch) folderId = folderMatch[1];
  if (!folderId && /^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (!/(^|\.)google\.com$/i.test(url.hostname)) return null;
      const id = url.searchParams.get('id');
      if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) folderId = id;
    } catch {
      return null;
    }
  }
  if (!folderId && /^[A-Za-z0-9_-]{20,}$/.test(text)) folderId = text;
  if (!folderId) return null;
  const keyMatch = /[?&]resourcekey=([A-Za-z0-9_-]+)/i.exec(text);
  if (keyMatch) resourceKey = keyMatch[1];
  return resourceKey ? { folderId, resourceKey } : { folderId };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Makes a Drive file or folder name safe as a single local path segment. */
export function safeFileName(name: string): string {
  let cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!cleaned) cleaned = 'untitled';
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > 150) {
    const ext = path.extname(cleaned).slice(0, 10);
    cleaned = `${cleaned.slice(0, 150 - ext.length)}${ext}`;
  }
  return cleaned;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export interface DriveEntry {
  id: string;
  name: string;
  /** Sub-folder path relative to the shared folder ('' = top level). */
  dir: string;
  isFolder: boolean;
  size: number | null;
  modifiedTime: string | null;
  md5: string | null;
}

/** Parses Drive's public embedded folder page (keyless mode). */
export function parseEmbeddedFolderPage(html: string): { title: string | null; entries: Array<{ id: string; name: string; isFolder: boolean }> } {
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeHtml(titleMatch[1]).trim() || null : null;
  const entries: Array<{ id: string; name: string; isFolder: boolean }> = [];
  const blocks = html.split(/<div class="flip-entry"/i).slice(1);
  for (const block of blocks) {
    const id = /id="entry-([A-Za-z0-9_-]+)"/.exec(block)?.[1];
    const name = /<div class="flip-entry-title">([\s\S]*?)<\/div>/i.exec(block)?.[1];
    if (!id || name === undefined) continue;
    const isFolder = /\/drive\/(?:u\/\d+\/)?folders\//.test(block) || /folder/i.test(/<img[^>]*>/i.exec(block)?.[0] ?? '');
    entries.push({ id, name: decodeHtml(name).trim(), isFolder });
  }
  return { title, entries };
}

export interface DriveClientOptions {
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  pageBase?: string;
  downloadBase?: string;
}

export class DriveClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly pageBase: string;
  private readonly downloadBase: string;
  readonly mode: 'api' | 'public-page';

  constructor(private readonly options: DriveClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
    this.pageBase = (options.pageBase ?? DEFAULT_PAGE_BASE).replace(/\/$/, '');
    this.downloadBase = (options.downloadBase ?? DEFAULT_DOWNLOAD_BASE).replace(/\/$/, '');
    this.mode = options.apiKey ? 'api' : 'public-page';
  }

  private apiHeaders(link: DriveLink): Record<string, string> {
    return link.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${link.folderId}/${link.resourceKey}` } : {};
  }

  private async getText(url: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await this.fetchImpl(url, { headers, redirect: 'follow' });
    if (!response.ok) throw new Error(await describeHttpError(response));
    return response.text();
  }

  async folderName(link: DriveLink): Promise<string> {
    if (this.options.apiKey) {
      const url = `${this.apiBase}/files/${encodeURIComponent(link.folderId)}?fields=name,mimeType&supportsAllDrives=true&key=${encodeURIComponent(this.options.apiKey)}`;
      const body = JSON.parse(await this.getText(url, this.apiHeaders(link))) as { name?: string; mimeType?: string };
      if (body.mimeType && body.mimeType !== FOLDER_MIME) throw new Error('That link is a file, not a folder');
      return body.name ?? 'Drive folder';
    }
    const page = parseEmbeddedFolderPage(await this.getText(this.embeddedUrl(link)));
    return page.title ?? 'Drive folder';
  }

  private embeddedUrl(link: DriveLink): string {
    const key = link.resourceKey ? `&resourcekey=${encodeURIComponent(link.resourceKey)}` : '';
    return `${this.pageBase}/embeddedfolderview?id=${encodeURIComponent(link.folderId)}${key}`;
  }

  private async listOne(link: DriveLink, dir: string): Promise<DriveEntry[]> {
    if (this.options.apiKey) {
      const entries: DriveEntry[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          q: `'${link.folderId}' in parents and trashed = false`,
          fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)',
          pageSize: '1000',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          key: this.options.apiKey
        });
        if (pageToken) params.set('pageToken', pageToken);
        const body = JSON.parse(await this.getText(`${this.apiBase}/files?${params.toString()}`, this.apiHeaders(link))) as {
          nextPageToken?: string;
          files?: Array<{ id: string; name: string; mimeType?: string; size?: string; modifiedTime?: string; md5Checksum?: string }>;
        };
        for (const f of body.files ?? []) {
          entries.push({
            id: f.id,
            name: f.name,
            dir,
            isFolder: f.mimeType === FOLDER_MIME,
            size: f.size ? Number(f.size) : null,
            modifiedTime: f.modifiedTime ?? null,
            md5: f.md5Checksum ?? null
          });
        }
        pageToken = body.nextPageToken;
      } while (pageToken);
      return entries;
    }
    const page = parseEmbeddedFolderPage(await this.getText(this.embeddedUrl(link)));
    return page.entries.map((e) => ({ ...e, dir, size: null, modifiedTime: null, md5: null }));
  }

  /** Every file in the folder tree (sub-folders up to 3 levels, e.g. one per performer). */
  async listTree(link: DriveLink): Promise<DriveEntry[]> {
    const files: DriveEntry[] = [];
    const walk = async (current: DriveLink, dir: string, depth: number): Promise<void> => {
      for (const entry of await this.listOne(current, dir)) {
        if (files.length >= MAX_FILES) return;
        if (entry.isFolder) {
          if (depth < MAX_DEPTH) await walk({ folderId: entry.id }, path.join(dir, safeFileName(entry.name)), depth + 1);
        } else {
          files.push(entry);
        }
      }
    };
    await walk(link, '', 0);
    return files;
  }

  downloadUrl(fileId: string): string {
    if (this.options.apiKey) {
      return `${this.apiBase}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(this.options.apiKey)}`;
    }
    return `${this.downloadBase}/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
  }

  /** Streams one file to disk (via a temporary name, so half files never appear). */
  async download(fileId: string, target: string): Promise<number> {
    const response = await this.fetchImpl(this.downloadUrl(fileId), { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(await describeHttpError(response));
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      // Google answers with an HTML page instead of the file (virus-scan prompt, quota, or not shared).
      throw new Error('Google Drive did not release the file (check sharing, or the daily download limit)');
    }
    const tmp = `${target}.stagecue-download`;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), createWriteStream(tmp));
      const { size } = await fsp.stat(tmp);
      if (size === 0) throw new Error('Downloaded file is empty');
      await fsp.rm(target, { force: true });
      await fsp.rename(tmp, target);
      return size;
    } catch (error) {
      await fsp.rm(tmp, { force: true });
      throw error;
    }
  }
}

async function describeHttpError(response: Response): Promise<string> {
  let reason = '';
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    reason = parsed.error?.message ?? '';
  } catch {
    reason = '';
  }
  if (response.status === 404) return 'Folder not found, or it is not shared as “Anyone with the link”';
  if (response.status === 403) return reason || 'Access denied: share the folder as “Anyone with the link”, or check the API key';
  if (response.status === 400 && /api key/i.test(reason)) return 'The Google API key is not valid';
  return reason || `Google Drive responded ${response.status}`;
}

/* -------------------------------- Manifest -------------------------------- */

export interface ManifestEntry {
  name: string;
  relPath: string;
  size: number | null;
  modifiedTime: string | null;
  md5: string | null;
  downloadedAt: number;
}

export interface DriveManifest {
  folderId: string;
  files: Record<string, ManifestEntry>;
}

export async function readManifest(localPath: string, folderId: string): Promise<DriveManifest> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(localPath, MANIFEST_NAME), 'utf8')) as DriveManifest;
    if (raw && raw.folderId === folderId && typeof raw.files === 'object' && raw.files !== null) return raw;
  } catch {
    return { folderId, files: {} };
  }
  return { folderId, files: {} };
}

async function writeManifest(localPath: string, manifest: DriveManifest): Promise<void> {
  const target = path.join(localPath, MANIFEST_NAME);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(tmp, target);
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return null;
  }
}

/** Has the Drive file changed since it was downloaded? */
export function isUnchanged(
  entry: DriveEntry,
  previous: ManifestEntry | undefined,
  localSize: number | null,
  relPath: string
): boolean {
  if (!previous || localSize === null || localSize === 0) return false;
  if (previous.name !== entry.name || previous.relPath !== relPath) return false;
  if (entry.md5 && previous.md5) return entry.md5 === previous.md5;
  if (entry.modifiedTime && previous.modifiedTime) return entry.modifiedTime === previous.modifiedTime;
  if (entry.size !== null) return entry.size === localSize;
  // Keyless mode cannot see sizes or dates: a file with the same id and name is treated as unchanged.
  return true;
}

function insideFolder(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/* ---------------------------------- Sync ---------------------------------- */

export async function syncDriveSource(
  source: DriveSource,
  client: DriveClient,
  onProgress: (progress: DriveSyncProgress) => void
): Promise<DriveSyncResult> {
  const result: DriveSyncResult = {
    sourceId: source.id,
    ok: false,
    mode: client.mode,
    listed: 0,
    downloaded: [],
    updated: [],
    unchanged: 0,
    skipped: [],
    failed: [],
    removedRemote: [],
    error: null,
    at: Date.now()
  };
  const root = path.resolve(source.localPath);
  const report = (phase: DriveSyncProgress['phase'], done: number, total: number, current: string | null, error: string | null = null): void =>
    onProgress({ sourceId: source.id, phase, done, total, current, error });

  try {
    await fsp.mkdir(root, { recursive: true });
    report('listing', 0, 0, null);
    const link: DriveLink = source.resourceKey ? { folderId: source.folderId, resourceKey: source.resourceKey } : { folderId: source.folderId };
    const entries = await client.listTree(link);
    result.listed = entries.length;
    const manifest = await readManifest(root, source.folderId);

    const playable = entries.filter((e) => {
      if (classifyMediaPath(e.name)) return true;
      result.skipped.push(path.join(e.dir, e.name));
      return false;
    });

    // Two Drive files may share a name; give each its own local file.
    const usedPaths = new Set<string>();
    const planned = playable.map((entry) => {
      let relPath = path.join(entry.dir, safeFileName(entry.name));
      const previous = manifest.files[entry.id];
      if (previous && previous.name === entry.name) relPath = previous.relPath;
      let n = 2;
      while (usedPaths.has(relPath.toLowerCase())) {
        const ext = path.extname(relPath);
        relPath = `${relPath.slice(0, relPath.length - ext.length).replace(/ \(\d+\)$/, '')} (${n})${ext}`;
        n += 1;
      }
      usedPaths.add(relPath.toLowerCase());
      return { entry, relPath, target: path.join(root, relPath) };
    });

    const work: typeof planned = [];
    for (const item of planned) {
      if (!insideFolder(root, item.target)) {
        result.failed.push({ name: item.entry.name, error: 'Unsafe file name' });
        continue;
      }
      const previous = manifest.files[item.entry.id];
      if (isUnchanged(item.entry, previous, await fileSize(item.target), item.relPath)) result.unchanged += 1;
      else work.push(item);
    }

    let done = 0;
    report('downloading', 0, work.length, null);
    const queue = [...work];
    const runWorker = async (): Promise<void> => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const { entry, relPath, target } = item;
        const previous = manifest.files[entry.id];
        report('downloading', done, work.length, entry.name);
        try {
          const existed = previous !== undefined;
          await client.download(entry.id, target);
          if (previous && previous.relPath !== relPath) {
            const old = path.join(root, previous.relPath);
            if (insideFolder(root, old)) await fsp.rm(old, { force: true });
          }
          manifest.files[entry.id] = {
            name: entry.name,
            relPath,
            size: entry.size,
            modifiedTime: entry.modifiedTime,
            md5: entry.md5,
            downloadedAt: Date.now()
          };
          (existed ? result.updated : result.downloaded).push(target);
        } catch (error) {
          result.failed.push({ name: entry.name, error: error instanceof Error ? error.message : String(error) });
        }
        done += 1;
        report('downloading', done, work.length, entry.name);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, work.length) }, runWorker));

    const remoteIds = new Set(entries.map((e) => e.id));
    for (const [id, entry] of Object.entries(manifest.files)) {
      if (!remoteIds.has(id)) result.removedRemote.push(entry.name);
    }
    await writeManifest(root, manifest);
    result.ok = true;
    result.at = Date.now();
    report('done', done, work.length, null);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    report('error', 0, 0, null, result.error);
  }
  return result;
}
