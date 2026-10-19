import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn()
  }
}));

import {
  allowMediaPath,
  classifyMediaPath,
  clearAllowedMediaPaths,
  getMimeType,
  handleMediaRequest,
  mediaUrlToPath,
  parseRangeHeader,
  resolveMediaFile,
  toMediaUrl
} from '../../src/main/protocolHandler';

describe('Range header parsing', () => {
  it('handles open, closed and suffix ranges', () => {
    expect(parseRangeHeader('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRangeHeader('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRangeHeader('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader('bytes=10-20, 30-40', 1000)).toEqual({ start: 10, end: 20 });
  });

  it('flags unsatisfiable ranges and ignores malformed ones', () => {
    expect(parseRangeHeader('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=50-10', 1000)).toBeNull();
    expect(parseRangeHeader('items=0-10', 1000)).toBeNull();
    expect(parseRangeHeader('bytes=abc-', 1000)).toBeNull();
    expect(parseRangeHeader(null, 1000)).toBeNull();
  });
});

describe('media URLs and types', () => {
  it('round-trips paths with spaces, unicode and drive letters', () => {
    const file = path.resolve('My Show', 'Kulgeet – final (v2).mp4');
    const url = toMediaUrl(file);
    expect(url.startsWith('local-media://media/')).toBe(true);
    expect(mediaUrlToPath(url)).toBe(file);
  });

  it('rejects foreign hosts and schemes', () => {
    expect(() => mediaUrlToPath('local-media://evil/abc')).toThrow();
    expect(() => mediaUrlToPath('file:///etc/passwd')).toThrow();
  });

  it('classifies media and maps MIME types', () => {
    expect(classifyMediaPath('poster.JPG')).toBe('image');
    expect(classifyMediaPath('anthem.mov')).toBe('video');
    expect(classifyMediaPath('bed.flac')).toBe('audio');
    expect(classifyMediaPath('notes.txt')).toBeNull();
    expect(getMimeType('clip.mp4')).toBe('video/mp4');
    expect(getMimeType('unknown.bin')).toBe('application/octet-stream');
  });
});

describe('local-media:// request handling', () => {
  let dir: string;
  let videoPath: string;
  let secretPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stagecue-protocol-'));
    videoPath = path.join(dir, 'clip.mp4');
    secretPath = path.join(dir, 'other.mp4');
    writeFileSync(videoPath, Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
    writeFileSync(secretPath, Buffer.from('not imported'));
    clearAllowedMediaPaths();
  });

  afterAll(() => {
    clearAllowedMediaPaths();
    rmSync(dir, { recursive: true, force: true });
  });

  it('only serves files that were imported', async () => {
    const response = await handleMediaRequest(new Request(toMediaUrl(secretPath)));
    expect(response.status).toBe(403);
  });

  it('resolves, allow-lists and serves full bodies', async () => {
    const resolved = await resolveMediaFile({ filePath: videoPath });
    expect(resolved).toMatchObject({ exists: true, type: 'video', sizeBytes: 256, name: 'clip.mp4' });

    const response = await handleMediaRequest(new Request(resolved.fileUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('256');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBe(256);
    expect(body[255]).toBe(255);
  });

  it('answers range requests with 206 Partial Content', async () => {
    allowMediaPath(videoPath);
    const response = await handleMediaRequest(
      new Request(toMediaUrl(videoPath), { headers: { Range: 'bytes=16-31' } })
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 16-31/256');
    expect(response.headers.get('content-length')).toBe('16');
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(body)).toEqual(Array.from({ length: 16 }, (_, i) => i + 16));
  });

  it('returns 416 for ranges past the end of the file', async () => {
    allowMediaPath(videoPath);
    const response = await handleMediaRequest(
      new Request(toMediaUrl(videoPath), { headers: { Range: 'bytes=999-' } })
    );
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */256');
  });

  it('falls back to the show-relative path when the absolute path moved', async () => {
    const resolved = await resolveMediaFile({
      filePath: path.join(dir, 'old-laptop', 'clip.mp4'),
      relativePath: 'clip.mp4',
      baseDir: dir
    });
    expect(resolved.exists).toBe(true);
    expect(resolved.filePath).toBe(videoPath);
  });

  it('reports missing files without throwing', async () => {
    const resolved = await resolveMediaFile({ filePath: path.join(dir, 'nope.mp4') });
    expect(resolved.exists).toBe(false);
    expect(resolved.type).toBe('video');
  });
});
