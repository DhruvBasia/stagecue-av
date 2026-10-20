import { describe, expect, it } from 'vitest';
import { buildCuesFromMedia, DEFAULT_BUILD_OPTIONS } from '../../src/renderer/src/services/cueBuilder';
import {
  assignMediaToCue,
  buildAdHocPayload,
  buildPageTurnPayload,
  createCue,
  createInitialProgram,
  isBackdropCapable,
  PAGE_TURN_MS,
  programReducer
} from '../../src/renderer/src/services/cueManager';
import {
  adjacentPage,
  describePaging,
  documentPages,
  livePaging,
  pageFromUrl,
  pageNumbered
} from '../../src/renderer/src/services/paging';
import { parseShowFile, serializeShow } from '../../src/renderer/src/services/storage';
import { mediaIdentityKey, normalizeWebUrl, toStageMedia, webPageName } from '../../src/renderer/src/services/utils';
import { DEFAULT_MIX } from '../../src/renderer/src/services/audioEngine';
import type { MediaItem } from '../../src/renderer/src/types';

const BOOKLET = 'C:\\Event\\Souvenir Booklet.pdf';

function page(n: number, extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id: `p${n}`,
    name: `Souvenir Booklet · p${n}`,
    type: 'image',
    filePath: `C:\\cache\\p${n}.png`,
    fileUrl: `local-media://media/p${n}`,
    pdf: { sourcePath: BOOKLET, page: n, pageCount: 6 },
    ...extra
  };
}

const other: MediaItem = {
  id: 'x1',
  name: 'Agenda · p1',
  type: 'image',
  filePath: 'C:\\cache\\x1.png',
  fileUrl: 'local-media://media/x1',
  pdf: { sourcePath: 'C:\\Event\\Agenda.pdf', page: 2, pageCount: 2 }
};

const web: MediaItem = {
  id: 'mag',
  name: 'Netted Bytes',
  type: 'web',
  filePath: 'https://fests.example.dev/netted-bytes',
  fileUrl: 'https://fests.example.dev/netted-bytes',
  web: { url: 'https://fests.example.dev/netted-bytes' }
};

// Page 4 was removed from the library; page 5 is missing on disk.
const library = [page(3), page(1), page(2), page(5, { missing: true }), page(6), other, web];

describe('booklet pages', () => {
  it('lists only this document’s available pages, in page order', () => {
    expect(documentPages(library, page(2), 'win32').map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p6']);
    // Windows paths are case-insensitive.
    expect(documentPages(library, page(1, { pdf: { sourcePath: BOOKLET.toLowerCase(), page: 1, pageCount: 6 } }), 'win32')).toHaveLength(4);
  });

  it('steps forward and back, skipping pages that are not available', () => {
    expect(adjacentPage(library, page(1), 1, 'win32')?.id).toBe('p2');
    expect(adjacentPage(library, page(3), 1, 'win32')?.id).toBe('p6');
    expect(adjacentPage(library, page(6), -1, 'win32')?.id).toBe('p3');
    expect(adjacentPage(library, page(6), 1, 'win32')).toBeNull();
    expect(adjacentPage(library, page(1), -1, 'win32')).toBeNull();
    expect(adjacentPage(library, web, 1, 'win32')).toBeNull();
  });

  it('jumps to a page number, or the nearest available page', () => {
    expect(pageNumbered(library, page(1), 3, 'win32')?.id).toBe('p3');
    expect(pageNumbered(library, page(1), 6, 'win32')?.id).toBe('p6');
    expect(pageNumbered(library, page(1), 4, 'win32')?.id).toBe('p3');
  });

  it('describes what can be paged right now', () => {
    expect(livePaging(page(3), null)).toEqual({ kind: 'pdf', page: 3, pageCount: 6 });
    expect(livePaging(web, 'https://fests.example.dev/netted-bytes?page=4')).toEqual({ kind: 'web', page: 4, pageCount: null });
    expect(livePaging(web, null)).toEqual({ kind: 'web', page: null, pageCount: null });
    expect(livePaging({ ...page(1), pdf: undefined }, null)).toBeNull();
    expect(livePaging(page(1, { missing: true }), null)).toBeNull();
    expect(describePaging(livePaging(page(3), null))).toBe('Page 3 / 6');
    expect(describePaging({ kind: 'pdf', page: 2, pageCount: 10 }, true)).toBe('Slide 2 / 10');
    expect(describePaging({ kind: 'web', page: null, pageCount: null })).toBe('');
  });

  it('reads flipbook page numbers from the address', () => {
    expect(pageFromUrl('https://fests.ggsipuedc.workers.dev/netted-bytes?page=2')).toBe(2);
    expect(pageFromUrl('https://example.com/mag#page=12')).toBe(12);
    expect(pageFromUrl('https://example.com/mag#p7')).toBe(7);
    expect(pageFromUrl('https://example.com/mag/page/5/')).toBe(5);
    expect(pageFromUrl('https://example.com/mag?page=0')).toBeNull();
    expect(pageFromUrl('https://example.com/mag?page=abc')).toBeNull();
    expect(pageFromUrl('not a url')).toBeNull();
  });
});

describe('page turns and live sources in the program', () => {
  it('turns the page without changing the live cue, with a quick dissolve', () => {
    const cue = createCue({ id: 'c1', label: 'Souvenir booklet', backdropMediaId: 'p1' }, 1);
    const program = programReducer(createInitialProgram(), {
      type: 'TAKE',
      payload: { ...buildAdHocPayload(page(1), createInitialProgram(), 1), cueId: cue.id, label: cue.label }
    });
    const turned = buildPageTurnPayload(program, page(2), 2, null);
    expect(turned).toMatchObject({
      takeId: 2,
      cueId: 'c1',
      label: 'Souvenir booklet',
      transition: 'dissolve',
      transitionDurationMs: PAGE_TURN_MS,
      foreground: null
    });
    expect(turned.backdrop?.id).toBe('p2');
    // Thumbnails and page refs never travel to the stage.
    expect(turned.backdrop).not.toHaveProperty('pdf');
    expect(turned.foregroundStartAt).toBeUndefined();
  });

  it('keeps a video playing on top where it was', () => {
    const video: MediaItem = { id: 'v', name: 'Kulgeet.mp4', type: 'video', filePath: 'k.mp4', fileUrl: 'local-media://media/k' };
    const program = { ...createInitialProgram(), takeId: 4, liveCueId: 'c1', liveCueLabel: 'Booklet', foreground: video };
    expect(buildPageTurnPayload(program, page(3), 5, 12.5)).toMatchObject({ foreground: { id: 'v' }, foregroundStartAt: 12.5 });
  });

  it('treats web pages and window captures as full-screen backdrops', () => {
    const win: MediaItem = { id: 'w', name: 'Scoreboard', type: 'screen', filePath: 'Scoreboard', fileUrl: '', capture: { sourceId: 'window:1:0', kind: 'window' } };
    expect(isBackdropCapable(web)).toBe(true);
    expect(isBackdropCapable(win)).toBe(true);
    const base = createCue({ id: 'c' }, 1);
    expect(assignMediaToCue(base, web).backdropMediaId).toBe('mag');
    expect(assignMediaToCue(base, win).backdropMediaId).toBe('w');
    expect(buildAdHocPayload(web, createInitialProgram(), 1)).toMatchObject({ backdrop: { id: 'mag', web: { url: web.fileUrl } }, foreground: null });
    expect(toStageMedia(win).capture).toEqual({ sourceId: 'window:1:0', kind: 'window' });
  });
});

describe('web addresses', () => {
  it('accepts what operators type and rejects what cannot be shown', () => {
    expect(normalizeWebUrl('fests.ggsipuedc.workers.dev/netted-bytes')).toBe('https://fests.ggsipuedc.workers.dev/netted-bytes');
    expect(normalizeWebUrl('  http://localhost:8080/mag ')).toBe('http://localhost:8080/mag');
    expect(normalizeWebUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeWebUrl('file:///C:/secret.txt')).toBeNull();
    expect(normalizeWebUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeWebUrl('two words')).toBeNull();
    expect(normalizeWebUrl('magazine')).toBeNull();
    expect(normalizeWebUrl('')).toBeNull();
  });

  it('names a page after its address', () => {
    expect(webPageName('https://fests.ggsipuedc.workers.dev/netted-bytes')).toBe('Netted Bytes');
    expect(webPageName('https://www.example.com/')).toBe('Example.com');
    expect(webPageName('https://example.com/files/annual_report.html')).toBe('Annual Report');
  });

  it('gives web pages and windows their own library identity', () => {
    expect(mediaIdentityKey(web, 'win32')).toBe('web:https://fests.example.dev/netted-bytes');
    expect(mediaIdentityKey({ filePath: 'Scoreboard', capture: { sourceId: 'window:9:0' } }, 'win32')).toBe('capture:window:9:0');
  });
});

describe('show files with web pages and windows', () => {
  it('saves and reopens them, and rejects unsafe addresses', () => {
    const win: MediaItem = { id: 'w', name: 'Scoreboard', type: 'screen', filePath: 'Scoreboard', fileUrl: '', capture: { sourceId: 'screen:0:0', kind: 'screen' } };
    const show = serializeShow({
      name: 'Annual Day',
      media: [web, win, page(1)],
      cues: [createCue({ id: 'c1', backdropMediaId: 'mag' }, 1), createCue({ id: 'c2', backdropMediaId: 'w' }, 2)],
      mix: DEFAULT_MIX
    });
    const reopened = parseShowFile(JSON.stringify(show));
    expect(reopened.media.find((m) => m.id === 'mag')).toEqual({
      id: 'mag',
      type: 'web',
      filePath: web.fileUrl,
      name: 'Netted Bytes',
      web: { url: web.fileUrl }
    });
    expect(reopened.media.find((m) => m.id === 'w')).toMatchObject({ type: 'screen', capture: { sourceId: 'screen:0:0', kind: 'screen' } });
    expect(reopened.cues.map((c) => c.backdropMediaId)).toEqual(['mag', 'w']);

    const unsafe = { ...show, media: [{ id: 'bad', type: 'web', name: 'x', filePath: 'file:///C:/x', web: { url: 'file:///C:/x' } }] };
    expect(() => parseShowFile(JSON.stringify(unsafe))).toThrow(/valid http\(s\) address/);
  });
});

describe('cues from a folder with PDFs', () => {
  it('makes one booklet cue per PDF when asked, otherwise one cue per page', () => {
    const items = [page(1), page(2), page(3), other];
    let n = 0;
    const perPage = buildCuesFromMedia(items, [], DEFAULT_BUILD_OPTIONS, () => `c${(n += 1)}`);
    expect(perPage).toHaveLength(4);
    const booklets = buildCuesFromMedia(items, [], { ...DEFAULT_BUILD_OPTIONS, pdfAsBooklet: true }, () => `c${(n += 1)}`);
    expect(booklets.map((c) => [c.label, c.backdropMediaId])).toEqual([
      ['Souvenir Booklet', 'p1'],
      ['Agenda', 'x1']
    ]);
    expect(booklets[0].notes).toMatch(/turn pages live/);
  });
});
