import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  cachedPagePath,
  isPdfCacheRequest,
  isPdfCacheStoreRequest,
  isPng,
  lookupCachedPage,
  storeCachedPage
} from '../../src/main/pdfCache';
import { allowMediaPath, clearAllowedMediaPaths, handleMediaRequest } from '../../src/main/protocolHandler';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

let root: string;
let cacheRoot: string;
let pdfPath: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'stagecue-pdfcache-'));
  cacheRoot = path.join(root, 'render-cache');
  pdfPath = path.join(root, 'Convocation Brochure.pdf');
  writeFileSync(pdfPath, '%PDF-1.4 fake');
  clearAllowedMediaPaths();
});

afterAll(() => {
  clearAllowedMediaPaths();
  rmSync(root, { recursive: true, force: true });
});

describe('PDF render cache', () => {
  it('validates requests', () => {
    expect(isPdfCacheRequest({ sourcePath: pdfPath, page: 1, renderKey: '1920x1080' })).toBe(true);
    expect(isPdfCacheRequest({ sourcePath: pdfPath, page: 0, renderKey: '1920x1080' })).toBe(false);
    expect(isPdfCacheRequest({ sourcePath: pdfPath, page: 1, renderKey: '../../evil' })).toBe(false);
    expect(isPdfCacheStoreRequest({ sourcePath: pdfPath, page: 1, renderKey: '1920x1080', data: PNG })).toBe(true);
    expect(isPdfCacheStoreRequest({ sourcePath: pdfPath, page: 1, renderKey: '1920x1080', data: 'png' })).toBe(false);
    expect(isPng(PNG)).toBe(true);
    expect(isPng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(false);
  });

  it('keys renders by page, resolution and PDF modification time', async () => {
    const p1 = await cachedPagePath(cacheRoot, { sourcePath: pdfPath, page: 1, renderKey: '1920x1080' });
    const p2 = await cachedPagePath(cacheRoot, { sourcePath: pdfPath, page: 2, renderKey: '1920x1080' });
    const p1k = await cachedPagePath(cacheRoot, { sourcePath: pdfPath, page: 1, renderKey: '3840x2160' });
    expect(p1?.startsWith(path.resolve(cacheRoot))).toBe(true);
    expect(p1?.endsWith('page-0001.png')).toBe(true);
    expect(path.dirname(p1 ?? '')).toBe(path.dirname(p2 ?? ''));
    expect(p1k).not.toBe(p1);

    const later = new Date(Date.now() + 60_000);
    utimesSync(pdfPath, later, later);
    const edited = await cachedPagePath(cacheRoot, { sourcePath: pdfPath, page: 1, renderKey: '1920x1080' });
    expect(edited).not.toBe(p1);

    expect(await cachedPagePath(cacheRoot, { sourcePath: path.join(root, 'gone.pdf'), page: 1, renderKey: '1920x1080' })).toBeNull();
  });

  it('refuses to cache pages for PDFs that were never imported', async () => {
    await expect(storeCachedPage(cacheRoot, { sourcePath: pdfPath, page: 1, renderKey: '1920x1080', data: PNG })).rejects.toThrow(
      /not imported/
    );
  });

  it('stores, finds and serves a rendered page', async () => {
    allowMediaPath(pdfPath);
    const request = { sourcePath: pdfPath, page: 3, renderKey: '1920x1080' };
    expect(await lookupCachedPage(cacheRoot, request)).toBeNull();

    await expect(storeCachedPage(cacheRoot, { ...request, data: new Uint8Array(32) })).rejects.toThrow(/PNG/);

    const stored = await storeCachedPage(cacheRoot, { ...request, data: PNG });
    expect(stored).toMatchObject({ exists: true, type: 'image', isPdf: false, sizeBytes: PNG.byteLength });

    const found = await lookupCachedPage(cacheRoot, request);
    expect(found?.filePath).toBe(stored.filePath);

    const response = await handleMediaRequest(new Request(stored.fileUrl));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});
