import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { DisplayStatus, PdfPageRef, ResolvedMediaFile } from '../types';
import {
  computeRenderScale,
  MIN_RENDER_TARGET,
  pdfPageName,
  renderKeyFor,
  renderTargetFor,
  slideName,
  type RenderTarget
} from './pdfLayout';
import { baseName } from './utils';

/* =========================================================================
 * PDF → backdrop pages (operator window).
 *
 * Every page is rasterised once at projector resolution with pdf.js and stored
 * as a PNG in the main-process render cache. The stage then shows a plain
 * image, so cuts, dissolves and the freeze capture behave exactly like any
 * other poster.
 * ========================================================================= */

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface RenderedPdfPage {
  file: ResolvedMediaFile;
  pdf: PdfPageRef;
  name: string;
}

export const MAX_IMPORTED_PAGES = 300;

let currentTarget: RenderTarget = { ...MIN_RENDER_TARGET };

/** Called whenever the display topology changes, so new PDFs render for the real projector. */
export function updateRenderTarget(status: DisplayStatus | null): void {
  currentTarget = renderTargetFor(status);
}

export function getRenderTarget(): RenderTarget {
  return { ...currentTarget };
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode the rendered page'));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(reject);
    }, 'image/png');
  });
}

export interface RenderPdfOptions {
  target: RenderTarget;
  /** Only these pages (1-based). Defaults to every page. */
  pages?: number[];
  onProgress?: (done: number, total: number) => void;
  /** Set when the PDF was converted from a slide deck: pages are named and tracked as slides. */
  originalPath?: string;
}

export async function renderPdfPages(source: ResolvedMediaFile, options: RenderPdfOptions): Promise<RenderedPdfPage[]> {
  const renderKey = renderKeyFor(options.target);
  const loadingTask = getDocument({ url: source.fileUrl, isEvalSupported: false, disableFontFace: false });
  const doc = await loadingTask.promise;
  try {
    const pageCount = Math.min(doc.numPages, MAX_IMPORTED_PAGES);
    const pages = (options.pages ?? Array.from({ length: pageCount }, (_, i) => i + 1)).filter(
      (p) => p >= 1 && p <= pageCount
    );
    const results: RenderedPdfPage[] = [];
    const fileName = baseName(source.filePath);
    options.onProgress?.(0, pages.length);

    for (const [index, pageNumber] of pages.entries()) {
      const request = { sourcePath: source.filePath, page: pageNumber, renderKey };
      let file = await window.api.invoke('media:pdf-cache-lookup', request);

      if (!file) {
        const page = await doc.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: computeRenderScale(base.width, base.height, options.target) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const data = await canvasToPng(canvas);
        // Release the bitmap immediately; 4K canvases are large.
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
        file = await window.api.invoke('media:pdf-cache-store', { ...request, data });
      }

      const pdf: PdfPageRef = { sourcePath: source.filePath, page: pageNumber, pageCount: doc.numPages };
      if (options.originalPath) pdf.originalPath = options.originalPath;
      results.push({
        file,
        pdf,
        name: options.originalPath
          ? slideName(baseName(options.originalPath), pageNumber)
          : pdfPageName(fileName, pageNumber, doc.numPages)
      });
      options.onProgress?.(index + 1, pages.length);
    }
    return results;
  } finally {
    await doc.destroy();
  }
}
