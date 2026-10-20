import type { CueItem, MediaItem, TransitionType } from '../types';
import { createCue, DEFAULT_TRANSITION_MS } from './cueManager';
import { baseName, isPathInsideFolder, mediaPathKey, sourcePathOf } from './utils';

/* =========================================================================
 * "Cues from folder": turns an event folder into a running order.
 *
 *   01 Welcome.png      → backdrop cue  "Welcome"
 *   02 Kulgeet.mp4      → video cue     "Kulgeet" (plays over the current backdrop)
 *   03 Brochure.pdf     → one backdrop cue per page "Brochure · p1", "· p2", …
 *                         (or one "Brochure" booklet cue whose pages are turned live)
 *   Walk-in.mp3         → music cue     "♪ Walk-in"
 *
 * Order follows the file names naturally (2 before 10), files before the
 * sub-folders next to them, PDF pages in page order.
 * ========================================================================= */

export interface BuildCuesOptions {
  includeImages: boolean;
  includeVideos: boolean;
  includeAudio: boolean;
  /** Skip media that is already used by an existing cue. */
  skipUsed: boolean;
  transition: TransitionType;
  transitionDurationMs: number;
  /** Auto-advance: posters after N seconds, videos when they end, music cues after 1 s. */
  slideshow: boolean;
  slideshowSeconds: number;
  /** The last cue jumps back to the first one (sponsor loops). */
  slideshowLoop: boolean;
  /** One cue per PDF / slide deck (its pages are turned live) instead of one cue per page. */
  pdfAsBooklet: boolean;
}

export const DEFAULT_BUILD_OPTIONS: BuildCuesOptions = {
  includeImages: true,
  includeVideos: true,
  includeAudio: true,
  skipUsed: true,
  transition: 'dissolve',
  transitionDurationMs: DEFAULT_TRANSITION_MS,
  slideshow: false,
  slideshowSeconds: 8,
  slideshowLoop: true,
  pdfAsBooklet: false
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function relativeSegments(filePath: string, folder: string, platform: string): string[] {
  const file = mediaPathKey(filePath, platform);
  const root = mediaPathKey(folder, platform).replace(/\/+$/, '');
  const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  return relative.split('/');
}

/** Natural running order inside one folder tree. */
export function compareForRunningOrder(folder: string, platform: string, a: MediaItem, b: MediaItem): number {
  const ra = relativeSegments(sourcePathOf(a), folder, platform);
  const rb = relativeSegments(sourcePathOf(b), folder, platform);
  const length = Math.min(ra.length, rb.length);
  for (let i = 0; i < length; i += 1) {
    const aIsLast = i === ra.length - 1;
    const bIsLast = i === rb.length - 1;
    if (aIsLast !== bIsLast) return aIsLast ? -1 : 1;
    const diff = collator.compare(ra[i], rb[i]);
    if (diff !== 0) return diff;
  }
  if (ra.length !== rb.length) return ra.length - rb.length;
  return (a.pdf ? a.pdf.page : 0) - (b.pdf ? b.pdf.page : 0);
}

/** "01_Stage Backdrop.png" → "Stage Backdrop"; "2. Welcome.jpg" → "Welcome". */
export function cleanCueLabel(name: string): string {
  const withoutExtension = name.replace(/\.(png|jpe?g|webp|gif|bmp|avif|svg|pdf|mp4|m4v|mov|mkv|webm|ogv|mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/i, '');
  const spaced = withoutExtension.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  // Up to 3 digits so years such as "2026 Convocation" are kept.
  const unnumbered = spaced.replace(/^\d{1,3}\s*[.)\-–:]?\s+/, '').replace(/^\d{1,3}[.)\-–:]\s*/, '');
  return (unnumbered.length > 0 ? unnumbered : spaced) || name;
}

export function mediaInFolder(items: readonly MediaItem[], folder: string, platform: string): MediaItem[] {
  return items
    .filter((item) => isPathInsideFolder(sourcePathOf(item), folder, platform))
    .sort((a, b) => compareForRunningOrder(folder, platform, a, b));
}

export function usedMediaIds(cues: readonly CueItem[]): Set<string> {
  const used = new Set<string>();
  for (const cue of cues) {
    if (cue.backdropMediaId) used.add(cue.backdropMediaId);
    if (cue.foregroundMediaId) used.add(cue.foregroundMediaId);
    if (cue.audioMediaId) used.add(cue.audioMediaId);
  }
  return used;
}

export function buildCuesFromMedia(
  items: readonly MediaItem[],
  existingCues: readonly CueItem[],
  options: BuildCuesOptions,
  makeId: () => string
): CueItem[] {
  const used = options.skipUsed ? usedMediaIds(existingCues) : new Set<string>();
  const cues: CueItem[] = [];
  const booklets = new Set<string>();
  for (const item of items) {
    if (item.missing || used.has(item.id)) continue;
    const base = {
      id: makeId(),
      transition: options.transition,
      transitionDurationMs: options.transitionDurationMs
    };
    const order = cues.length + 1;
    if (item.type === 'image' && options.includeImages && item.pdf && options.pdfAsBooklet) {
      // Items arrive in page order, so the first page seen opens the booklet.
      const document = sourcePathOf(item);
      if (booklets.has(document)) continue;
      booklets.add(document);
      cues.push(
        createCue(
          {
            ...base,
            label: cleanCueLabel(baseName(document)),
            backdropMediaId: item.id,
            notes: `${item.pdf.originalPath ? 'Slides' : 'Booklet'}: turn pages live with ◀ ▶, [ ], the clicker or the crew phones.`
          },
          order
        )
      );
    } else if (item.type === 'image' && options.includeImages) {
      cues.push(createCue({ ...base, label: cleanCueLabel(item.name), backdropMediaId: item.id }, order));
    } else if (item.type === 'video' && options.includeVideos) {
      cues.push(createCue({ ...base, label: cleanCueLabel(item.name), foregroundMediaId: item.id }, order));
    } else if (item.type === 'audio' && options.includeAudio) {
      cues.push(
        createCue({ ...base, label: `♪ ${cleanCueLabel(item.name)}`, audioMediaId: item.id, loopAudio: true }, order)
      );
    }
  }
  return options.slideshow ? applySlideshow(cues, options) : cues;
}

export function applySlideshow(cues: CueItem[], options: Pick<BuildCuesOptions, 'slideshowSeconds' | 'slideshowLoop'>): CueItem[] {
  const seconds = Math.max(1, Math.min(3600, Math.round(options.slideshowSeconds)));
  const chained = cues.map((cue): CueItem => {
    if (cue.foregroundMediaId) return { ...cue, followMode: 'on-end' };
    if (cue.backdropMediaId) return { ...cue, followMode: 'after-delay', followDelaySec: seconds };
    return { ...cue, followMode: 'after-delay', followDelaySec: 1 };
  });
  if (options.slideshowLoop && chained.length > 1) {
    const last = chained[chained.length - 1];
    chained[chained.length - 1] = { ...last, followTargetId: chained[0].id };
  } else if (chained.length > 0) {
    // Without a loop the sequence stops on the last slide.
    const last = chained[chained.length - 1];
    chained[chained.length - 1] = { ...last, followMode: 'off' };
  }
  return chained;
}
