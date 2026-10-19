import { createReadStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import type { MediaPathRequest, MediaType, ResolvedMediaFile } from '../renderer/src/types';

/**
 * Secure `local-media://` streaming protocol.
 *
 * URLs have the shape `local-media://media/<encodeURIComponent(absolutePath)>`.
 * Only files that were explicitly imported by the operator (file dialog, drag &
 * drop or a show file) are served; everything else gets a 403. Range requests
 * are answered with HTTP 206 so the video decoder can scrub smoothly.
 */

export const MEDIA_SCHEME = 'local-media';
export const MEDIA_HOST = 'media';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  // QuickTime/Matroska containers holding H.264/VP9 play in Chromium when advertised this way.
  '.mov': 'video/mp4',
  '.mkv': 'video/webm',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm'
};

export const MEDIA_EXTENSIONS: Readonly<Record<MediaType, readonly string[]>> = {
  // PDFs and slide decks land in the backdrop bin; each page/slide is rendered to a cached PNG before use.
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg', '.pdf', '.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odp'],
  video: ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ogv'],
  audio: ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac', '.weba']
};

const allowedPaths = new Set<string>();

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

export function allowMediaPath(filePath: string): void {
  allowedPaths.add(pathKey(filePath));
}

export function isMediaPathAllowed(filePath: string): boolean {
  return allowedPaths.has(pathKey(filePath));
}

export function clearAllowedMediaPaths(): void {
  allowedPaths.clear();
}

export function classifyMediaPath(filePath: string): MediaType | null {
  const ext = path.extname(filePath).toLowerCase();
  for (const type of Object.keys(MEDIA_EXTENSIONS) as MediaType[]) {
    if (MEDIA_EXTENSIONS[type].includes(ext)) return type;
  }
  return null;
}

export function isPdfPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.pdf';
}

const DECK_EXTENSIONS = new Set(['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.odp']);

export function isDeckPath(filePath: string): boolean {
  return DECK_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function getMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function toMediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeURIComponent(path.resolve(filePath))}`;
}

export function mediaUrlToPath(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== `${MEDIA_SCHEME}:`) {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.hostname !== MEDIA_HOST) {
    throw new Error(`Unsupported media host: ${parsed.hostname}`);
  }
  const encoded = parsed.pathname.replace(/^\/+/, '');
  if (encoded.length === 0) {
    throw new Error('Empty media path');
  }
  return path.resolve(decodeURIComponent(encoded));
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses an HTTP `Range` header against a file of `size` bytes.
 * Returns `null` when the header is absent/malformed (serve the full body),
 * `'unsatisfiable'` for a 416 response, or the inclusive byte range.
 * Multi-range requests are answered with their first range.
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match) return null;
  const first = match[1].split(',')[0]?.trim() ?? '';
  const dash = first.indexOf('-');
  if (dash === -1) return null;
  const rawStart = first.slice(0, dash).trim();
  const rawEnd = first.slice(dash + 1).trim();
  if (rawStart === '' && rawEnd === '') return null;
  if (size <= 0) return 'unsatisfiable';

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix < 0) return null;
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isInteger(start) || start < 0) return null;
  if (start >= size) return 'unsatisfiable';

  if (rawEnd === '') return { start, end: size - 1 };
  const end = Number(rawEnd);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function baseHeaders(filePath: string): Record<string, string> {
  return {
    'Content-Type': getMimeType(filePath),
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };
}

function streamFile(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(filePath, { start, end, highWaterMark: 1024 * 512 });
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

export async function handleMediaRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textResponse(405, 'Method Not Allowed');
  }

  let filePath: string;
  try {
    filePath = mediaUrlToPath(request.url);
  } catch {
    return textResponse(400, 'Bad media URL');
  }

  if (!classifyMediaPath(filePath) || !isMediaPathAllowed(filePath)) {
    return textResponse(403, 'Forbidden');
  }

  let size: number;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return textResponse(404, 'Not Found');
    size = stat.size;
  } catch {
    return textResponse(404, 'Not Found');
  }

  const headers = baseHeaders(filePath);
  const range = parseRangeHeader(request.headers.get('range'), size);

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` }
    });
  }

  if (range) {
    const length = range.end - range.start + 1;
    const partialHeaders = {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(length)
    };
    if (request.method === 'HEAD') return new Response(null, { status: 206, headers: partialHeaders });
    return new Response(streamFile(filePath, range.start, range.end), { status: 206, headers: partialHeaders });
  }

  const fullHeaders = { ...headers, 'Content-Length': String(size) };
  if (request.method === 'HEAD' || size === 0) {
    return new Response(null, { status: 200, headers: fullHeaders });
  }
  return new Response(streamFile(filePath, 0, size - 1), { status: 200, headers: fullHeaders });
}

/** Must run before `app.whenReady()`. */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: false
      }
    }
  ]);
}

/** Must run after `app.whenReady()`. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => handleMediaRequest(request));
}

/**
 * Resolves a requested path (with an optional show-relative fallback), checks
 * that it exists and is a supported media type, and registers it in the
 * protocol allowlist.
 */
export async function resolveMediaFile(request: MediaPathRequest): Promise<ResolvedMediaFile> {
  const candidates: string[] = [path.resolve(request.filePath)];
  if (request.relativePath && request.baseDir) {
    const relativeCandidate = path.resolve(request.baseDir, request.relativePath);
    if (!candidates.includes(relativeCandidate)) candidates.push(relativeCandidate);
  }

  for (const candidate of candidates) {
    const type = classifyMediaPath(candidate);
    if (!type) continue;
    try {
      const stat = await fsp.stat(candidate);
      if (!stat.isFile()) continue;
      allowMediaPath(candidate);
      return {
        requestedPath: request.filePath,
        filePath: candidate,
        fileUrl: toMediaUrl(candidate),
        name: path.basename(candidate),
        type,
        sizeBytes: stat.size,
        exists: true,
        isPdf: isPdfPath(candidate),
        isPresentation: isDeckPath(candidate)
      };
    } catch {
      continue;
    }
  }

  const fallback = candidates[0];
  return {
    requestedPath: request.filePath,
    filePath: fallback,
    fileUrl: toMediaUrl(fallback),
    name: path.basename(fallback),
    type: classifyMediaPath(fallback),
    sizeBytes: 0,
    exists: false,
    isPdf: isPdfPath(fallback),
    isPresentation: isDeckPath(fallback)
  };
}
