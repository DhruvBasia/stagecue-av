import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { PdfCacheRequest, PdfCacheStoreRequest, ResolvedMediaFile } from '../renderer/src/types';
import { isMediaPathAllowed, resolveMediaFile } from './protocolHandler';

/* =========================================================================
 * Disk cache for PDF pages rendered to PNG by the operator window.
 *
 * Each page is rendered once at projector resolution and stored under
 *   <userData>/render-cache/<hash(source, size, mtime, renderKey)>/page-0001.png
 * so the stage shows a plain image (instant cuts, freeze capture, no PDF
 * engine on the projector). Editing the PDF changes its mtime and therefore
 * the cache key, so stale pages are never reused.
 * ========================================================================= */

export const MAX_RENDERED_PAGE_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;

function validPage(page: unknown): page is number {
  return typeof page === 'number' && Number.isInteger(page) && page >= 1 && page <= MAX_PDF_PAGES;
}

function validRenderKey(key: unknown): key is string {
  return typeof key === 'string' && /^[0-9]{2,5}x[0-9]{2,5}$/.test(key);
}

export function isPdfCacheRequest(value: unknown): value is PdfCacheRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<PdfCacheRequest>;
  return typeof r.sourcePath === 'string' && r.sourcePath.length > 0 && validPage(r.page) && validRenderKey(r.renderKey);
}

export function isPdfCacheStoreRequest(value: unknown): value is PdfCacheStoreRequest {
  if (!isPdfCacheRequest(value)) return false;
  const data = (value as Partial<PdfCacheStoreRequest>).data;
  return data instanceof Uint8Array && data.byteLength > 8 && data.byteLength <= MAX_RENDERED_PAGE_BYTES;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(data: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, i) => data[i] === byte);
}

/** Absolute path of the cached render, or null when the source PDF is gone. */
export async function cachedPagePath(cacheRoot: string, request: PdfCacheRequest): Promise<string | null> {
  const source = path.resolve(request.sourcePath);
  let size: number;
  let mtime: number;
  try {
    const stat = await fsp.stat(source);
    if (!stat.isFile()) return null;
    size = stat.size;
    mtime = Math.round(stat.mtimeMs);
  } catch {
    return null;
  }
  const normalized = process.platform === 'win32' || process.platform === 'darwin' ? source.toLowerCase() : source;
  const hash = createHash('sha1').update(`${normalized}|${size}|${mtime}|${request.renderKey}`).digest('hex').slice(0, 20);
  const stem = path.basename(source, path.extname(source)).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'pdf';
  return path.join(path.resolve(cacheRoot), `${stem}-${hash}`, `page-${String(request.page).padStart(4, '0')}.png`);
}

export async function lookupCachedPage(cacheRoot: string, request: PdfCacheRequest): Promise<ResolvedMediaFile | null> {
  const target = await cachedPagePath(cacheRoot, request);
  if (!target) return null;
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile() || stat.size === 0) return null;
  } catch {
    return null;
  }
  return resolveMediaFile({ filePath: target });
}

export async function storeCachedPage(cacheRoot: string, request: PdfCacheStoreRequest): Promise<ResolvedMediaFile> {
  // Only PDFs the operator actually imported may produce cache entries.
  if (!isMediaPathAllowed(request.sourcePath)) {
    throw new Error('PDF source was not imported into this session');
  }
  if (!isPng(request.data)) {
    throw new Error('Rendered page is not a PNG image');
  }
  const target = await cachedPagePath(cacheRoot, request);
  if (!target) throw new Error(`PDF not found: ${request.sourcePath}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, request.data);
  await fsp.rename(tmp, target);
  return resolveMediaFile({ filePath: target });
}
