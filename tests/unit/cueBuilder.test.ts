import { describe, expect, it } from 'vitest';
import {
  buildCuesFromMedia,
  cleanCueLabel,
  DEFAULT_BUILD_OPTIONS,
  mediaInFolder,
  usedMediaIds
} from '../../src/renderer/src/services/cueBuilder';
import { computeRenderScale, pdfPageName, renderKeyFor, renderTargetFor } from '../../src/renderer/src/services/pdfLayout';
import { createCue } from '../../src/renderer/src/services/cueManager';
import type { DisplayStatus, MediaItem } from '../../src/renderer/src/types';

const FOLDER = 'C:\\Events\\Annual Day';

function item(id: string, relative: string, type: MediaItem['type'], extra: Partial<MediaItem> = {}): MediaItem {
  const filePath = `${FOLDER}\\${relative}`;
  return {
    id,
    name: relative.split('\\').pop() ?? relative,
    filePath,
    fileUrl: `local-media://media/${id}`,
    type,
    ...extra
  };
}

function pdfPage(id: string, page: number, pageCount: number): MediaItem {
  return item(id, `render-cache\\page-${page}.png`, 'image', {
    name: `03 Brochure · p${page}`,
    filePath: `C:\\Users\\op\\AppData\\render-cache\\page-${page}.png`,
    pdf: { sourcePath: `${FOLDER}\\03 Brochure.pdf`, page, pageCount }
  });
}

const library: MediaItem[] = [
  item('walkin', 'Music\\Walk-in.mp3', 'audio'),
  item('closing', '10 Closing.png', 'image'),
  pdfPage('brochure-2', 2, 2),
  item('kulgeet', '02 Kulgeet.mp4', 'video'),
  item('welcome', '01_Welcome Poster.png', 'image'),
  pdfPage('brochure-1', 1, 2),
  item('missing', '04 Gone.png', 'image', { missing: true }),
  { ...item('elsewhere', 'x.png', 'image'), filePath: 'D:\\Other\\x.png' }
];

describe('cues from folder', () => {
  it('orders folder media naturally, PDF pages in page order, sub-folders last', () => {
    const ordered = mediaInFolder(library, FOLDER, 'win32').map((m) => m.id);
    expect(ordered).toEqual(['welcome', 'kulgeet', 'brochure-1', 'brochure-2', 'missing', 'closing', 'walkin']);
  });

  it('builds backdrop, video and music cues with clean labels', () => {
    let n = 0;
    const cues = buildCuesFromMedia(mediaInFolder(library, FOLDER, 'win32'), [], DEFAULT_BUILD_OPTIONS, () => `c${(n += 1)}`);
    expect(cues.map((c) => c.label)).toEqual([
      'Welcome Poster',
      'Kulgeet',
      'Brochure · p1',
      'Brochure · p2',
      'Closing',
      '♪ Walk-in'
    ]);
    expect(cues.map((c) => c.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cues[0]).toMatchObject({ backdropMediaId: 'welcome', foregroundMediaId: undefined, transition: 'dissolve' });
    expect(cues[1]).toMatchObject({ foregroundMediaId: 'kulgeet', backdropMediaId: undefined });
    expect(cues[5]).toMatchObject({ audioMediaId: 'walkin', loopAudio: true });
  });

  it('respects type filters, transition choice and already-used media', () => {
    const existing = [createCue({ id: 'x', backdropMediaId: 'welcome' }, 1)];
    expect(usedMediaIds(existing).has('welcome')).toBe(true);
    let n = 0;
    const cues = buildCuesFromMedia(
      mediaInFolder(library, FOLDER, 'win32'),
      existing,
      { ...DEFAULT_BUILD_OPTIONS, includeAudio: false, includeVideos: false, transition: 'cut' },
      () => `c${(n += 1)}`
    );
    expect(cues.map((c) => c.backdropMediaId)).toEqual(['brochure-1', 'brochure-2', 'closing']);
    expect(cues.every((c) => c.transition === 'cut' && c.transitionDurationMs === 0)).toBe(true);
  });

  it('cleans numbered file names but keeps years and plain names', () => {
    expect(cleanCueLabel('01 Stage Backdrop.png')).toBe('Stage Backdrop');
    expect(cleanCueLabel('02_Kulgeet_Final.mp4')).toBe('Kulgeet Final');
    expect(cleanCueLabel('3. Welcome.jpg')).toBe('Welcome');
    expect(cleanCueLabel('07-Anthem.mov')).toBe('Anthem');
    expect(cleanCueLabel('2026 Convocation.png')).toBe('2026 Convocation');
    expect(cleanCueLabel('Sponsors.png')).toBe('Sponsors');
    expect(cleanCueLabel('05.png')).toBe('05');
  });
});

describe('PDF render sizing', () => {
  const status = (displays: Array<[number, number, number]>): DisplayStatus => ({
    mode: 'projector',
    displays: displays.map(([width, height, scaleFactor], id) => ({
      id,
      bounds: { x: 0, y: 0, width, height },
      workArea: { x: 0, y: 0, width, height },
      scaleFactor,
      isPrimary: id === 0,
      isExternal: id !== 0,
      name: `D${id}`
    })),
    stageDisplayId: 1,
    operatorDisplayId: 0,
    preferredStageDisplayId: null,
    reason: 'startup',
    changedAt: 0
  });

  it('renders at least 1080p and at most 4K, following the biggest display', () => {
    expect(renderTargetFor(null)).toEqual({ width: 1920, height: 1080 });
    expect(renderTargetFor(status([[1366, 768, 1], [1024, 768, 1]]))).toEqual({ width: 1920, height: 1080 });
    expect(renderTargetFor(status([[1920, 1080, 1.25], [2560, 1440, 1]]))).toEqual({ width: 2560, height: 1440 });
    expect(renderTargetFor(status([[3840, 2160, 2]]))).toEqual({ width: 3840, height: 2160 });
    expect(renderKeyFor({ width: 2560, height: 1440 })).toBe('2560x1440');
  });

  it('fits portrait and landscape pages inside the target', () => {
    const target = { width: 1920, height: 1080 };
    expect(computeRenderScale(960, 540, target)).toBe(2); // 16:9 slide
    expect(computeRenderScale(595, 842, target)).toBeCloseTo(1080 / 842); // A4 portrait poster
    expect(computeRenderScale(0, 100, target)).toBe(1);
  });

  it('names pages', () => {
    expect(pdfPageName('Brochure.pdf', 2, 5)).toBe('Brochure · p2');
    expect(pdfPageName('Poster.PDF', 1, 1)).toBe('Poster');
  });
});
