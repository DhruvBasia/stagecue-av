import type { LivePaging, MediaItem } from '../types';
import { mediaPathKey, sourcePathOf } from './utils';

/* =========================================================================
 * Page turning for a live booklet: a PDF (or PowerPoint deck, which is
 * imported as PDF pages) or a web page such as an online flipbook.
 * Pure helpers, unit tested.
 * ========================================================================= */

/** Pages of the same document as `item` that are in the library (and on disk), in page order. */
export function documentPages(items: readonly MediaItem[], item: MediaItem, platform: string): MediaItem[] {
  if (!item.pdf) return [];
  const key = mediaPathKey(sourcePathOf(item), platform);
  return items
    .filter((i) => i.pdf && !i.missing && mediaPathKey(sourcePathOf(i), platform) === key)
    .sort((a, b) => (a.pdf?.page ?? 0) - (b.pdf?.page ?? 0));
}

/**
 * The next page in `direction` from `current`. Pages removed from the library
 * are skipped. Null at the first/last page.
 */
export function adjacentPage(
  items: readonly MediaItem[],
  current: MediaItem,
  direction: 1 | -1,
  platform: string
): MediaItem | null {
  if (!current.pdf) return null;
  const page = current.pdf.page;
  const pages = documentPages(items, current, platform);
  const candidates = direction === 1 ? pages.filter((p) => (p.pdf?.page ?? 0) > page) : pages.filter((p) => (p.pdf?.page ?? 0) < page).reverse();
  return candidates[0] ?? null;
}

/** A specific page number of the same document (nearest available page if that one was removed). */
export function pageNumbered(items: readonly MediaItem[], current: MediaItem, page: number, platform: string): MediaItem | null {
  const pages = documentPages(items, current, platform);
  if (pages.length === 0) return null;
  let best = pages[0];
  for (const candidate of pages) {
    const distance = Math.abs((candidate.pdf?.page ?? 0) - page);
    if (distance < Math.abs((best.pdf?.page ?? 0) - page)) best = candidate;
  }
  return best;
}

/** Page number shown in a web address: ?page=4, #page=4, #p4, /page/4. */
export function pageFromUrl(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const fromQuery = parsed.searchParams.get('page') ?? parsed.searchParams.get('p');
  const candidates = [
    fromQuery,
    /^#(?:page=|p)?(\d{1,4})$/i.exec(parsed.hash)?.[1] ?? null,
    /\/page\/(\d{1,4})\/?$/i.exec(parsed.pathname)?.[1] ?? null
  ];
  for (const value of candidates) {
    if (value !== null && /^\d{1,4}$/.test(value)) {
      const n = Number(value);
      if (n >= 1) return n;
    }
  }
  return null;
}

/** What can be paged right now, given the live backdrop (full library item) and the web page's address. */
export function livePaging(backdrop: MediaItem | null, webUrl: string | null): LivePaging | null {
  if (!backdrop || backdrop.missing) return null;
  if (backdrop.pdf) return { kind: 'pdf', page: backdrop.pdf.page, pageCount: backdrop.pdf.pageCount };
  if (backdrop.type === 'web') return { kind: 'web', page: webUrl ? pageFromUrl(webUrl) : null, pageCount: null };
  return null;
}

/** "Page 3 / 34", "Slide 2 / 10", "Page 2", or "" when unknown. */
export function describePaging(paging: LivePaging | null, slides = false): string {
  if (!paging || paging.page === null) return '';
  const word = slides ? 'Slide' : 'Page';
  return paging.pageCount ? `${word} ${paging.page} / ${paging.pageCount}` : `${word} ${paging.page}`;
}
