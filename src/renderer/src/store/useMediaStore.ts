import { create } from 'zustand';
import type { FolderScanResult, MediaItem, MediaType, PdfPageRef, ResolvedMediaFile } from '../types';
import { probeMedia } from '../services/mediaProbe';
import { getRenderTarget, renderPdfPages } from '../services/pdfRenderer';
import {
  baseName,
  createId,
  isPathInsideFolder,
  mediaIdentityKey,
  mediaPathKey,
  sourcePathOf
} from '../services/utils';
import { useShowStore } from './useShowStore';

/** A resolved file ready for the library; PDF pages carry their page reference. */
export type ImportCandidate = ResolvedMediaFile & { pdf?: PdfPageRef; displayName?: string };

export interface ImportOutcome {
  added: MediaItem[];
  duplicates: number;
  rejected: string[];
}

export interface FolderImportOutcome extends ImportOutcome {
  folderPath: string;
  /** Library items from this folder whose files are gone since the last scan. */
  missingCount: number;
  /** Previously-missing items whose files are back. */
  restoredCount: number;
  skipped: number;
  truncated: boolean;
}

export interface PdfJob {
  name: string;
  done: number;
  total: number;
}

export interface MediaStoreState {
  items: MediaItem[];
  /** Event folders linked to this show, re-scannable at any time. */
  folders: string[];
  probing: Record<string, boolean>;
  scanningFolders: Record<string, boolean>;
  /** PDFs currently being rendered into backdrop pages, keyed by source path. */
  pdfJobs: Record<string, PdfJob>;
  /** Items that just arrived (e.g. from Google Drive) and have not been used yet → "NEW" badge. */
  newIds: Record<string, number>;
  markNew: (ids: string[]) => void;
  clearNew: (id?: string) => void;
  importFiles: (files: ImportCandidate[]) => ImportOutcome;
  importResolved: (files: ResolvedMediaFile[]) => Promise<ImportOutcome>;
  importFromDialog: (types: MediaType[]) => Promise<ImportOutcome>;
  importFolderFromDialog: () => Promise<FolderImportOutcome | null>;
  /** quiet: no success banner (used by background Drive syncs, which report on their own). */
  rescanFolder: (folderPath: string, options?: { quiet?: boolean }) => Promise<FolderImportOutcome | null>;
  unlinkFolder: (folderPath: string) => void;
  importDroppedFiles: (files: File[]) => Promise<ImportOutcome>;
  renderPdf: (source: ResolvedMediaFile, pages?: number[], originalPath?: string) => Promise<ImportCandidate[]>;
  /** PowerPoint/Impress → PDF (cached) → one backdrop per slide. */
  renderPresentation: (deck: ResolvedMediaFile, pages?: number[]) => Promise<ImportCandidate[]>;
  replaceAll: (items: MediaItem[], folders?: string[]) => void;
  removeItem: (id: string) => void;
  markMissing: (ids: ReadonlySet<string>) => void;
  renameItem: (id: string, name: string) => void;
  getById: (id: string | undefined) => MediaItem | null;
  byType: (type: MediaType) => MediaItem[];
}

function platform(): string {
  return typeof window !== 'undefined' && window.api ? window.api.platform : 'linux';
}

function countByType(items: MediaItem[]): string {
  const counts: Record<MediaType, number> = { image: 0, video: 0, audio: 0 };
  let pdfPages = 0;
  let slides = 0;
  for (const item of items) {
    if (item.pdf?.originalPath) slides += 1;
    else if (item.pdf) pdfPages += 1;
    else counts[item.type] += 1;
  }
  const parts: string[] = [];
  if (counts.image) parts.push(`${counts.image} backdrop${counts.image === 1 ? '' : 's'}`);
  if (slides) parts.push(`${slides} slide${slides === 1 ? '' : 's'}`);
  if (pdfPages) parts.push(`${pdfPages} PDF page${pdfPages === 1 ? '' : 's'}`);
  if (counts.video) parts.push(`${counts.video} video${counts.video === 1 ? '' : 's'}`);
  if (counts.audio) parts.push(`${counts.audio} track${counts.audio === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function reportRejected(rejected: string[]): void {
  if (rejected.length === 0) return;
  useShowStore
    .getState()
    .pushAlert(
      'warning',
      'Some files were not imported',
      `${rejected.length} file(s) are missing, unreadable or not a supported format: ${rejected.slice(0, 4).join(', ')}${
        rejected.length > 4 ? '…' : ''
      }`,
      false
    );
}

function reportImport(outcome: ImportOutcome): void {
  reportRejected(outcome.rejected);
  if (outcome.added.length > 0) {
    useShowStore.getState().pushAlert('success', 'Media imported', `${countByType(outcome.added)} added to the library.`, false);
  }
}

function reportFolder(outcome: FolderImportOutcome, rescan: boolean): void {
  const show = useShowStore.getState();
  const name = baseName(outcome.folderPath);
  const lines: string[] = [];
  if (outcome.added.length > 0) lines.push(`${countByType(outcome.added)} added`);
  else lines.push(rescan ? 'No new files' : 'No new media found');
  if (outcome.duplicates > 0 && !rescan) lines.push(`${outcome.duplicates} already in the library`);
  if (outcome.restoredCount > 0) lines.push(`${outcome.restoredCount} found again`);
  if (outcome.skipped > 0) lines.push(`${outcome.skipped} non-media file(s) ignored`);
  show.pushAlert(
    outcome.added.length > 0 || rescan ? 'success' : 'info',
    `${rescan ? 'Rescanned' : 'Imported'} “${name}”`,
    `${lines.join(' · ')}.`,
    false
  );
  reportRejected(outcome.rejected);
  if (outcome.missingCount > 0) {
    show.pushAlert(
      'warning',
      `${outcome.missingCount} file(s) missing from “${name}”`,
      'They were moved, renamed or deleted. Cues using them will be skipped until the files are back.'
    );
  }
  if (outcome.truncated) {
    show.pushAlert('warning', 'Folder is very large', 'Only the first 3000 media files were imported.');
  }
}

export const useMediaStore = create<MediaStoreState>((set, get) => {
  const probe = (item: MediaItem): void => {
    set((state) => ({ probing: { ...state.probing, [item.id]: true } }));
    probeMedia(item)
      .then((result) => {
        set((state) => {
          const { [item.id]: _done, ...probing } = state.probing;
          return {
            probing,
            items: state.items.map((existing) => {
              if (existing.id !== item.id) return existing;
              const patched: MediaItem = { ...existing };
              if (result.duration !== undefined) patched.duration = result.duration;
              if (result.dimensions !== undefined) patched.dimensions = result.dimensions;
              if (result.thumbnailUrl !== undefined) patched.thumbnailUrl = result.thumbnailUrl;
              patched.probeError = result.probeError;
              return patched;
            })
          };
        });
        if (result.probeError && !item.missing) {
          useShowStore
            .getState()
            .pushAlert('warning', `Check "${item.name}"`, `${result.probeError}. It may not play on stage.`, false);
        }
      })
      .catch((error: unknown) => {
        set((state) => {
          const { [item.id]: _failed, ...probing } = state.probing;
          return { probing };
        });
        useShowStore
          .getState()
          .pushAlert('warning', `Could not inspect "${item.name}"`, error instanceof Error ? error.message : String(error), false);
      });
  };

  /** Expands PDFs into rendered page candidates; other files pass through unchanged. */
  const prepareImports = async (
    files: ResolvedMediaFile[]
  ): Promise<{ candidates: ImportCandidate[]; failed: string[] }> => {
    const candidates: ImportCandidate[] = [];
    const failed: string[] = [];
    for (const file of files) {
      if ((!file.isPdf && !file.isPresentation) || !file.exists) {
        candidates.push(file);
        continue;
      }
      try {
        candidates.push(...(file.isPresentation ? await get().renderPresentation(file) : await get().renderPdf(file)));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unreadable file';
        failed.push(`${file.name} (${message})`);
        if (file.isPresentation) {
          useShowStore.getState().pushAlert('error', `Could not import “${file.name}”`, message);
        }
      }
    }
    return { candidates, failed };
  };

  const linkFolder = (folderPath: string): void => {
    const key = mediaPathKey(folderPath, platform());
    if (get().folders.some((f) => mediaPathKey(f, platform()) === key)) return;
    set((state) => ({ folders: [...state.folders, folderPath] }));
    useShowStore.getState().markDirty();
  };

  /** Imports a scan result, links the folder and reconciles missing / restored files. */
  const applyFolderScan = async (scan: FolderScanResult): Promise<FolderImportOutcome> => {
    const prepared = await prepareImports(scan.files);
    const base = get().importFiles(prepared.candidates);
    const presentSources = new Set(scan.files.map((f) => mediaPathKey(f.filePath, platform())));
    const freshByIdentity = new Map(prepared.candidates.map((c) => [mediaIdentityKey(c, platform()), c] as const));
    let missingCount = 0;
    let restoredCount = 0;
    const restored: MediaItem[] = [];

    set((state) => ({
      items: state.items.map((item) => {
        const source = sourcePathOf(item);
        if (!isPathInsideFolder(source, scan.folderPath, platform())) return item;
        const present = presentSources.has(mediaPathKey(source, platform()));
        if (!present && !item.missing) {
          missingCount += 1;
          return { ...item, missing: true };
        }
        const fresh = freshByIdentity.get(mediaIdentityKey(item, platform()));
        if (present && item.missing && fresh) {
          restoredCount += 1;
          const back: MediaItem = {
            ...item,
            missing: false,
            filePath: fresh.filePath,
            fileUrl: fresh.fileUrl,
            sizeBytes: fresh.sizeBytes
          };
          restored.push(back);
          return back;
        }
        return item;
      })
    }));
    restored.forEach(probe);
    linkFolder(scan.folderPath);

    return {
      ...base,
      rejected: [...base.rejected, ...prepared.failed],
      folderPath: scan.folderPath,
      missingCount,
      restoredCount,
      skipped: scan.skipped,
      truncated: scan.truncated
    };
  };

  const withScanning = async <T>(folderPath: string, task: () => Promise<T>): Promise<T> => {
    set((state) => ({ scanningFolders: { ...state.scanningFolders, [folderPath]: true } }));
    try {
      return await task();
    } finally {
      set((state) => {
        const { [folderPath]: _done, ...scanningFolders } = state.scanningFolders;
        return { scanningFolders };
      });
    }
  };

  return {
    items: [],
    folders: [],
    probing: {},
    scanningFolders: {},
    pdfJobs: {},
    newIds: {},

    markNew: (ids) => {
      if (ids.length === 0) return;
      const now = Date.now();
      set((state) => ({ newIds: { ...state.newIds, ...Object.fromEntries(ids.map((id) => [id, now])) } }));
    },

    clearNew: (id) => {
      if (id === undefined) {
        set({ newIds: {} });
        return;
      }
      if (!get().newIds[id]) return;
      set((state) => {
        const { [id]: _seen, ...rest } = state.newIds;
        return { newIds: rest };
      });
    },

    importFiles: (files) => {
      const existing = get().items;
      const known = new Set(existing.map((i) => mediaIdentityKey(i, platform())));
      const added: MediaItem[] = [];
      const rejected: string[] = [];
      let duplicates = 0;

      for (const file of files) {
        // An un-rendered PDF or deck must never reach the stage as an "image".
        if (!file.exists || !file.type || ((file.isPdf || file.isPresentation) && !file.pdf)) {
          rejected.push(file.name);
          continue;
        }
        const key = mediaIdentityKey(file, platform());
        if (known.has(key)) {
          duplicates += 1;
          continue;
        }
        known.add(key);
        const item: MediaItem = {
          id: createId('media'),
          name: file.displayName ?? file.name,
          filePath: file.filePath,
          fileUrl: file.fileUrl,
          type: file.type,
          sizeBytes: file.sizeBytes
        };
        if (file.pdf) item.pdf = { ...file.pdf };
        added.push(item);
      }

      if (added.length > 0) {
        set({ items: [...existing, ...added] });
        useShowStore.getState().markDirty();
        added.forEach(probe);
      }
      return { added, duplicates, rejected };
    },

    importResolved: async (files) => {
      const prepared = await prepareImports(files);
      const outcome = get().importFiles(prepared.candidates);
      return { ...outcome, rejected: [...outcome.rejected, ...prepared.failed] };
    },

    renderPresentation: async (deck, pages) => {
      const key = deck.filePath;
      const name = baseName(deck.filePath);
      set((state) => ({ pdfJobs: { ...state.pdfJobs, [key]: { name: `${name} (converting slides…)`, done: 0, total: 0 } } }));
      let pdf: ResolvedMediaFile;
      try {
        pdf = await window.api.invoke('media:convert-presentation', deck.filePath);
      } finally {
        set((state) => {
          const { [key]: _converted, ...pdfJobs } = state.pdfJobs;
          return { pdfJobs };
        });
      }
      return get().renderPdf(pdf, pages, deck.filePath);
    },

    renderPdf: async (source, pages, originalPath) => {
      const key = originalPath ?? source.filePath;
      const name = baseName(key);
      set((state) => ({ pdfJobs: { ...state.pdfJobs, [key]: { name, done: 0, total: pages?.length ?? 0 } } }));
      try {
        const rendered = await renderPdfPages(source, {
          target: getRenderTarget(),
          pages,
          originalPath,
          onProgress: (done, total) =>
            set((state) => ({ pdfJobs: { ...state.pdfJobs, [key]: { name, done, total } } }))
        });
        return rendered.map((page) => ({ ...page.file, pdf: page.pdf, displayName: page.name }));
      } finally {
        set((state) => {
          const { [key]: _finished, ...pdfJobs } = state.pdfJobs;
          return { pdfJobs };
        });
      }
    },

    importFromDialog: async (types) => {
      const files = await window.api.invoke('media:open-file-dialog', { types, multiSelections: true });
      const outcome = await get().importResolved(files);
      reportImport(outcome);
      return outcome;
    },

    importFolderFromDialog: async () => {
      try {
        const scan = await window.api.invoke('media:open-folder-dialog');
        if (!scan) return null;
        const outcome = await withScanning(scan.folderPath, () => applyFolderScan(scan));
        reportFolder(outcome, false);
        return outcome;
      } catch (error) {
        useShowStore
          .getState()
          .pushAlert('error', 'Folder import failed', error instanceof Error ? error.message : String(error));
        return null;
      }
    },

    rescanFolder: async (folderPath, options = {}) =>
      withScanning(folderPath, async () => {
        try {
          const scan = await window.api.invoke('media:scan-folder', folderPath);
          if (!scan.exists) {
            useShowStore
              .getState()
              .pushAlert('error', `Folder not found: “${baseName(folderPath)}”`, `${folderPath} is not reachable. Is the drive connected?`);
            return null;
          }
          const outcome = await applyFolderScan(scan);
          if (options.quiet) reportRejected(outcome.rejected);
          else reportFolder(outcome, true);
          return outcome;
        } catch (error) {
          useShowStore
            .getState()
            .pushAlert('error', 'Rescan failed', error instanceof Error ? error.message : String(error));
          return null;
        }
      }),

    unlinkFolder: (folderPath) => {
      set((state) => ({ folders: state.folders.filter((f) => f !== folderPath) }));
      useShowStore.getState().markDirty();
    },

    importDroppedFiles: async (files) => {
      const paths = files
        .map((file) => {
          try {
            return window.api.getPathForFile(file);
          } catch {
            return '';
          }
        })
        .filter((p) => p.length > 0);
      if (paths.length === 0) {
        const outcome: ImportOutcome = { added: [], duplicates: 0, rejected: files.map((f) => f.name) };
        reportImport(outcome);
        return outcome;
      }

      const expanded = await window.api.invoke('media:expand-paths', paths);
      const folderOutcomes: FolderImportOutcome[] = [];
      for (const scan of expanded.folders.filter((f) => f.exists)) {
        const outcome = await withScanning(scan.folderPath, () => applyFolderScan(scan));
        reportFolder(outcome, false);
        folderOutcomes.push(outcome);
      }

      const folderFileKeys = new Set(
        expanded.folders.flatMap((f) => f.files.map((file) => mediaPathKey(file.filePath, platform())))
      );
      const looseFiles = expanded.files.filter((f) => !folderFileKeys.has(mediaPathKey(f.filePath, platform())));
      const looseOutcome = await get().importResolved(looseFiles);
      if (looseFiles.length > 0) reportImport(looseOutcome);

      return {
        added: [...folderOutcomes.flatMap((o) => o.added), ...looseOutcome.added],
        duplicates: folderOutcomes.reduce((n, o) => n + o.duplicates, looseOutcome.duplicates),
        rejected: [...folderOutcomes.flatMap((o) => o.rejected), ...looseOutcome.rejected]
      };
    },

    replaceAll: (items, folders = []) => {
      set({ items, folders, probing: {}, scanningFolders: {}, newIds: {} });
      items.filter((i) => !i.missing).forEach(probe);
    },

    removeItem: (id) => {
      set((state) => ({ items: state.items.filter((i) => i.id !== id) }));
      useShowStore.getState().markDirty();
    },

    markMissing: (ids) => {
      if (ids.size === 0) return;
      set((state) => ({
        items: state.items.map((i) => (ids.has(i.id) && !i.missing ? { ...i, missing: true } : i))
      }));
    },

    renameItem: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set((state) => ({ items: state.items.map((i) => (i.id === id ? { ...i, name: trimmed } : i)) }));
      useShowStore.getState().markDirty();
    },

    getById: (id) => {
      if (!id) return null;
      return get().items.find((i) => i.id === id) ?? null;
    },

    byType: (type) => get().items.filter((i) => i.type === type)
  };
});
