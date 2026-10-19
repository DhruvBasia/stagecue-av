import type { DisplayStatus } from '../types';
import { clamp } from './utils';

/* Pure sizing/naming rules for PDF page renders (no pdf.js, no DOM). */

export interface RenderTarget {
  width: number;
  height: number;
}

export const MIN_RENDER_TARGET: RenderTarget = { width: 1920, height: 1080 };
export const MAX_RENDER_TARGET: RenderTarget = { width: 3840, height: 2160 };

/** Largest connected display (physical pixels), clamped between 1080p and 4K. */
export function renderTargetFor(status: DisplayStatus | null): RenderTarget {
  let width = MIN_RENDER_TARGET.width;
  let height = MIN_RENDER_TARGET.height;
  for (const display of status?.displays ?? []) {
    width = Math.max(width, Math.round(display.bounds.width * display.scaleFactor));
    height = Math.max(height, Math.round(display.bounds.height * display.scaleFactor));
  }
  return {
    width: clamp(width, MIN_RENDER_TARGET.width, MAX_RENDER_TARGET.width),
    height: clamp(height, MIN_RENDER_TARGET.height, MAX_RENDER_TARGET.height)
  };
}

export function renderKeyFor(target: RenderTarget): string {
  return `${target.width}x${target.height}`;
}

/** pdf.js scale so the page fits inside the target box (pdf units are 1/72 inch). */
export function computeRenderScale(pageWidth: number, pageHeight: number, target: RenderTarget): number {
  if (pageWidth <= 0 || pageHeight <= 0) return 1;
  return Math.min(target.width / pageWidth, target.height / pageHeight);
}

export function pdfPageName(fileName: string, page: number, pageCount: number): string {
  const stem = fileName.replace(/\.pdf$/i, '');
  return pageCount > 1 ? `${stem} · p${page}` : stem;
}

/** "Annual Report.pptx", slide 3 → "Annual Report · slide 3". */
export function slideName(fileName: string, slide: number): string {
  const stem = fileName.replace(/\.(pptx?|pptm|ppsx?|odp)$/i, '');
  return `${stem} · slide ${slide}`;
}
