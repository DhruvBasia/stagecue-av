import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn()
  }
}));

import { compareMediaPaths, expandMediaPaths, scanMediaFolder } from '../../src/main/mediaScanner';
import { clearAllowedMediaPaths, handleMediaRequest } from '../../src/main/protocolHandler';

/*
 * Event folder used by the tests:
 *
 *   Convocation 2026/
 *     10 Closing.png
 *     2 Welcome.png
 *     notes.docx                 (ignored: not media)
 *     .DS_Store                  (ignored: hidden)
 *     Videos/
 *       Kulgeet.mp4
 *       Anthem.MOV
 *     Tracks/
 *       Walk-in.mp3
 *       Deep/Deeper/Deepest/bonus.wav
 *     node_modules/x.mp4         (ignored folder)
 */

let root: string;
let eventFolder: string;

function touch(relative: string, content = 'x'): string {
  const full = path.join(eventFolder, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'stagecue-scan-'));
  eventFolder = path.join(root, 'Convocation 2026');
  touch('10 Closing.png');
  touch('2 Welcome.png');
  touch('notes.docx');
  touch('.DS_Store');
  touch(path.join('Videos', 'Kulgeet.mp4'), 'video-bytes');
  touch(path.join('Videos', 'Anthem.MOV'));
  touch(path.join('Tracks', 'Walk-in.mp3'));
  touch(path.join('Tracks', 'Deep', 'Deeper', 'Deepest', 'bonus.wav'));
  touch(path.join('node_modules', 'x.mp4'));
  clearAllowedMediaPaths();
});

afterAll(() => {
  clearAllowedMediaPaths();
  rmSync(root, { recursive: true, force: true });
});

describe('event folder scanning', () => {
  it('finds every image, video and track in the folder tree, in natural order', async () => {
    const scan = await scanMediaFolder(eventFolder);
    expect(scan.exists).toBe(true);
    expect(scan.truncated).toBe(false);
    expect(scan.files.map((f) => path.relative(eventFolder, f.filePath))).toEqual([
      '2 Welcome.png',
      '10 Closing.png',
      path.join('Tracks', 'Walk-in.mp3'),
      path.join('Tracks', 'Deep', 'Deeper', 'Deepest', 'bonus.wav'),
      path.join('Videos', 'Anthem.MOV'),
      path.join('Videos', 'Kulgeet.mp4')
    ]);
    expect(scan.files.map((f) => f.type)).toEqual(['image', 'image', 'audio', 'audio', 'video', 'video']);
    expect(scan.skipped).toBe(1); // notes.docx
  });

  it('allow-lists scanned files for the local-media:// protocol', async () => {
    const scan = await scanMediaFolder(eventFolder);
    const kulgeet = scan.files.find((f) => f.name === 'Kulgeet.mp4');
    expect(kulgeet).toBeDefined();
    const response = await handleMediaRequest(new Request(kulgeet?.fileUrl ?? ''));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('video-bytes');
  });

  it('respects depth and file limits', async () => {
    const shallow = await scanMediaFolder(eventFolder, { maxDepth: 1 });
    expect(shallow.files.some((f) => f.name === 'bonus.wav')).toBe(false);
    expect(shallow.files.some((f) => f.name === 'Walk-in.mp3')).toBe(true);

    const limited = await scanMediaFolder(eventFolder, { maxFiles: 2 });
    expect(limited.files).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('reports a missing folder instead of throwing', async () => {
    const scan = await scanMediaFolder(path.join(root, 'Unplugged USB'));
    expect(scan).toMatchObject({ exists: false, files: [] });
  });

  it('expands a drop that mixes folders and loose files', async () => {
    const loose = path.join(root, 'Sponsor Logo.jpg');
    writeFileSync(loose, 'jpg');
    const expanded = await expandMediaPaths([path.join(eventFolder, 'Videos'), loose]);
    expect(expanded.folders).toHaveLength(1);
    expect(expanded.files.map((f) => f.name)).toEqual(['Anthem.MOV', 'Kulgeet.mp4', 'Sponsor Logo.jpg']);
  });

  it('sorts numbered files naturally and files before sub-folders', () => {
    const base = path.resolve('show');
    const sorted = [
      path.join(base, 'b', 'a.png'),
      path.join(base, '10.png'),
      path.join(base, '9.png'),
      path.join(base, 'a', 'z.png')
    ].sort((a, b) => compareMediaPaths(base, a, b));
    expect(sorted.map((p) => path.relative(base, p))).toEqual(['9.png', '10.png', path.join('a', 'z.png'), path.join('b', 'a.png')]);
  });
});
