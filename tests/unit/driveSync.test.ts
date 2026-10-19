import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}));

import {
  decodeHtml,
  DriveClient,
  MANIFEST_NAME,
  parseDriveFolderLink,
  parseEmbeddedFolderPage,
  safeFileName,
  syncDriveSource
} from '../../src/main/driveSync';
import type { DriveSource, DriveSyncProgress } from '../../src/renderer/src/types';

const FOLDER = 'FOLDER_performers_2026';
const SUB = 'FOLDER_team_rhythm_001';

interface FakeFile {
  id: string;
  name: string;
  parent: string;
  body: string;
  md5: string;
  folder?: boolean;
}

/** Minimal stand-in for the Drive API v3 + public pages, enough to exercise the sync. */
function fakeDrive(files: FakeFile[], options: { pageSize?: number; htmlFor?: string } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.startsWith('/drive/v3/files/') && url.searchParams.get('alt') === 'media') {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      if (id === options.htmlFor) return new Response('<html>quota</html>', { headers: { 'content-type': 'text/html' } });
      const file = files.find((f) => f.id === id);
      return file ? new Response(file.body, { headers: { 'content-type': 'audio/mpeg' } }) : new Response('{}', { status: 404 });
    }
    if (url.pathname.startsWith('/drive/v3/files/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      if (id === FOLDER) return Response.json({ name: 'Annual Day – Performer Tracks', mimeType: 'application/vnd.google-apps.folder' });
      return Response.json({ error: { message: 'File not found' } }, { status: 404 });
    }
    if (url.pathname === '/drive/v3/files') {
      if (url.searchParams.get('key') !== 'TEST_KEY') return Response.json({ error: { message: 'API key not valid' } }, { status: 400 });
      const parent = /'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')?.[1];
      const children = files.filter((f) => f.parent === parent);
      const size = options.pageSize ?? 1000;
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = children.slice(start, start + size);
      return Response.json({
        nextPageToken: start + size < children.length ? String(start + size) : undefined,
        files: page.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.folder ? 'application/vnd.google-apps.folder' : 'audio/mpeg',
          size: f.folder ? undefined : String(f.body.length),
          modifiedTime: '2026-10-15T10:00:00.000Z',
          md5Checksum: f.folder ? undefined : f.md5
        }))
      });
    }
    if (url.pathname === '/embeddedfolderview') {
      const id = url.searchParams.get('id');
      const children = files.filter((f) => f.parent === id);
      const entries = children
        .map(
          (f) =>
            `<div class="flip-entry" id="entry-${f.id}" tabindex="0"><a href="https://drive.google.com/${
              f.folder ? `drive/folders/${f.id}` : `file/d/${f.id}/view`
            }"><div class="flip-entry-title">${f.name.replace(/&/g, '&amp;')}</div></a></div>`
        )
        .join('');
      return new Response(`<html><head><title>Annual Day &amp; Friends</title></head><body>${entries}</body></html>`, {
        headers: { 'content-type': 'text/html' }
      });
    }
    if (url.pathname === '/download') {
      const file = files.find((f) => f.id === url.searchParams.get('id'));
      return file ? new Response(file.body, { headers: { 'content-type': 'application/octet-stream' } }) : new Response('', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE = 'http://drive.test';
const endpoints = { apiBase: `${BASE}/drive/v3`, pageBase: BASE, downloadBase: BASE };

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'stagecue-drive-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function source(name: string): DriveSource {
  return { id: `src-${name}`, url: `https://drive.google.com/drive/folders/${FOLDER}`, folderId: FOLDER, name, localPath: path.join(root, name) };
}

describe('Drive links and names', () => {
  it('understands every common way of sharing a folder', () => {
    expect(parseDriveFolderLink('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?usp=sharing')).toEqual({
      folderId: '1AbCdEfGhIjKlMnOpQrStUv'
    });
    expect(parseDriveFolderLink('https://drive.google.com/drive/u/1/folders/1AbCdEfGhIjKlMnOpQrStUv')?.folderId).toBe('1AbCdEfGhIjKlMnOpQrStUv');
    expect(parseDriveFolderLink('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUv')?.folderId).toBe('1AbCdEfGhIjKlMnOpQrStUv');
    expect(parseDriveFolderLink('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv?resourcekey=0-xyz_AB')).toEqual({
      folderId: '1AbCdEfGhIjKlMnOpQrStUv',
      resourceKey: '0-xyz_AB'
    });
    expect(parseDriveFolderLink('1AbCdEfGhIjKlMnOpQrStUvWxYz')?.folderId).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(parseDriveFolderLink('https://evil.example.com/open?id=1AbCdEfGhIjKlMnOpQrStUv')).toBeNull();
    expect(parseDriveFolderLink('hello')).toBeNull();
  });

  it('makes Drive names safe on Windows', () => {
    expect(safeFileName('Team A: Dance/Mix?.mp3')).toBe('Team A_ Dance_Mix_.mp3');
    expect(safeFileName('..\\..\\evil.mp3')).toBe('_.._evil.mp3');
    expect(safeFileName('CON.mp3')).toBe('_CON.mp3');
    expect(safeFileName('   ')).toBe('untitled');
    expect(safeFileName(`${'x'.repeat(300)}.mp3`).length).toBe(150);
    expect(decodeHtml('Rock &amp; Roll &#39;26 &#x263A;')).toBe("Rock & Roll '26 ☺");
  });

  it('reads the public folder page', () => {
    const page = parseEmbeddedFolderPage(
      '<title>Tracks</title><div class="flip-entry" id="entry-AAA111222333"><a href="https://drive.google.com/file/d/AAA111222333/view"><div class="flip-entry-title">Song &amp; Dance.mp3</div></a></div>' +
        '<div class="flip-entry" id="entry-BBB111222333"><a href="https://drive.google.com/drive/folders/BBB111222333"><div class="flip-entry-title">Team B</div></a></div>'
    );
    expect(page).toEqual({
      title: 'Tracks',
      entries: [
        { id: 'AAA111222333', name: 'Song & Dance.mp3', isFolder: false },
        { id: 'BBB111222333', name: 'Team B', isFolder: true }
      ]
    });
  });
});

describe('Drive sync (API key mode)', () => {
  const files: FakeFile[] = [
    { id: 'f1', name: '01 Opening Dance.mp3', parent: FOLDER, body: 'mp3-opening', md5: 'a1' },
    { id: 'f2', name: 'Group Song.wav', parent: FOLDER, body: 'wav-group', md5: 'b1' },
    { id: 'f3', name: 'Lyrics.docx', parent: FOLDER, body: 'doc', md5: 'c1' },
    { id: SUB, name: 'Team Rhythm', parent: FOLDER, body: '', md5: '', folder: true },
    { id: 'f4', name: 'Drum Solo.m4a', parent: SUB, body: 'm4a-drums', md5: 'd1' },
    { id: 'f5', name: 'Group Song.wav', parent: SUB, body: 'wav-second', md5: 'e1' }
  ];

  it('downloads every playable file, keeps sub-folders, skips documents and reports progress', async () => {
    const { fetchImpl } = fakeDrive(files, { pageSize: 2 });
    const client = new DriveClient({ apiKey: 'TEST_KEY', fetchImpl, ...endpoints });
    expect(await client.folderName({ folderId: FOLDER })).toBe('Annual Day – Performer Tracks');
    const progress: DriveSyncProgress[] = [];
    const src = source('api');
    const result = await syncDriveSource(src, client, (p) => progress.push(p));

    expect(result).toMatchObject({ ok: true, mode: 'api', listed: 5, unchanged: 0, failed: [], error: null });
    expect(result.skipped).toEqual(['Lyrics.docx']);
    expect(result.downloaded.map((p) => path.relative(src.localPath, p)).sort()).toEqual(
      ['01 Opening Dance.mp3', 'Group Song.wav', path.join('Team Rhythm', 'Drum Solo.m4a'), path.join('Team Rhythm', 'Group Song.wav')].sort()
    );
    expect(readFileSync(path.join(src.localPath, 'Team Rhythm', 'Drum Solo.m4a'), 'utf8')).toBe('m4a-drums');
    expect(existsSync(path.join(src.localPath, MANIFEST_NAME))).toBe(true);
    expect(progress[0].phase).toBe('listing');
    expect(progress[progress.length - 1]).toMatchObject({ phase: 'done', done: 4, total: 4 });
  });

  it('only fetches new or changed files on later syncs, and keeps files deleted on Drive', async () => {
    const src = source('api');
    const unchanged = fakeDrive(files);
    const again = await syncDriveSource(src, new DriveClient({ apiKey: 'TEST_KEY', fetchImpl: unchanged.fetchImpl, ...endpoints }), () => undefined);
    expect(again).toMatchObject({ ok: true, downloaded: [], updated: [], unchanged: 4 });
    expect(unchanged.calls.some((c) => c.includes('alt=media'))).toBe(false);

    const changed = files
      .filter((f) => f.id !== 'f2')
      .map((f) => (f.id === 'f1' ? { ...f, body: 'mp3-opening-v2', md5: 'a2' } : f))
      .concat({ id: 'f6', name: 'Late Entry.mp3', parent: FOLDER, body: 'late', md5: 'g1' });
    const drive = fakeDrive(changed);
    const third = await syncDriveSource(src, new DriveClient({ apiKey: 'TEST_KEY', fetchImpl: drive.fetchImpl, ...endpoints }), () => undefined);
    expect(third.downloaded.map((p) => path.basename(p))).toEqual(['Late Entry.mp3']);
    expect(third.updated.map((p) => path.basename(p))).toEqual(['01 Opening Dance.mp3']);
    expect(third.removedRemote).toEqual(['Group Song.wav']);
    expect(readFileSync(path.join(src.localPath, '01 Opening Dance.mp3'), 'utf8')).toBe('mp3-opening-v2');
    expect(existsSync(path.join(src.localPath, 'Group Song.wav'))).toBe(true);
  });

  it('reports bad keys and Google HTML answers without crashing', async () => {
    const bad = fakeDrive(files);
    const result = await syncDriveSource(source('badkey'), new DriveClient({ apiKey: 'WRONG', fetchImpl: bad.fetchImpl, ...endpoints }), () => undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('The Google API key is not valid');

    const html = fakeDrive(files, { htmlFor: 'f2' });
    const partial = await syncDriveSource(source('html'), new DriveClient({ apiKey: 'TEST_KEY', fetchImpl: html.fetchImpl, ...endpoints }), () => undefined);
    expect(partial.ok).toBe(true);
    expect(partial.failed).toEqual([{ name: 'Group Song.wav', error: expect.stringMatching(/did not release the file/) }]);
    expect(existsSync(path.join(source('html').localPath, 'Group Song.wav.stagecue-download'))).toBe(false);
  });
});

describe('Drive sync (keyless public page mode)', () => {
  it('lists the public folder page and downloads through the public link', async () => {
    const files: FakeFile[] = [
      { id: 'p1', name: 'Rock & Roll.mp3', parent: FOLDER, body: 'rock', md5: '' },
      { id: SUB, name: 'Team Rhythm', parent: FOLDER, body: '', md5: '', folder: true },
      { id: 'p2', name: 'Beat.mp3', parent: SUB, body: 'beat', md5: '' }
    ];
    const { fetchImpl, calls } = fakeDrive(files);
    const client = new DriveClient({ apiKey: null, fetchImpl, ...endpoints });
    expect(client.mode).toBe('public-page');
    expect(await client.folderName({ folderId: FOLDER })).toBe('Annual Day & Friends');
    const src = source('public');
    const result = await syncDriveSource(src, client, () => undefined);
    expect(result).toMatchObject({ ok: true, mode: 'public-page', listed: 2 });
    expect(readFileSync(path.join(src.localPath, 'Rock & Roll.mp3'), 'utf8')).toBe('rock');
    expect(readFileSync(path.join(src.localPath, 'Team Rhythm', 'Beat.mp3'), 'utf8')).toBe('beat');
    expect(calls.some((c) => c.startsWith('/download?id=p1') && c.includes('confirm=t'))).toBe(true);

    writeFileSync(path.join(src.localPath, 'unrelated.txt'), 'x');
    const again = await syncDriveSource(src, client, () => undefined);
    expect(again).toMatchObject({ downloaded: [], unchanged: 2 });
  });
});
