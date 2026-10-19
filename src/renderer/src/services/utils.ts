import type { MediaItem, MediaType } from '../types';

let fallbackCounter = 0;

export function createId(prefix: string): string {
  const cryptoApi: Crypto | undefined = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  fallbackCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** mm:ss or h:mm:ss */
export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const whole = Math.floor(totalSeconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

export function gainToDb(value: number): number {
  if (value <= 0.00001) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(value);
}

export function formatDb(value: number): string {
  const db = gainToDb(value);
  if (!Number.isFinite(db)) return '-∞ dB';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function mediaPathKey(filePath: string, platform: string): string {
  const normalized = filePath.replace(/[\\/]+/g, '/');
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

type PageRefLike = { sourcePath: string; page: number; originalPath?: string };

/** The file on disk the operator thinks of: the deck for slides, the PDF for pages, else the file. */
export function sourcePathOf(item: { filePath: string; pdf?: Omit<PageRefLike, 'page'> }): string {
  if (!item.pdf) return item.filePath;
  return item.pdf.originalPath ?? item.pdf.sourcePath;
}

/** Library identity: one entry per file, or per page/slide for PDFs and decks. */
export function mediaIdentityKey(item: { filePath: string; pdf?: PageRefLike }, platform: string): string {
  return item.pdf ? `${mediaPathKey(sourcePathOf(item), platform)}#${item.pdf.page}` : mediaPathKey(item.filePath, platform);
}

export function isPathInsideFolder(filePath: string, folderPath: string, platform: string): boolean {
  const file = mediaPathKey(filePath, platform);
  const folder = mediaPathKey(folderPath, platform).replace(/\/+$/, '');
  return file.startsWith(`${folder}/`);
}

export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.stagecue\.json$/i, '').replace(/\.[^.]+$/, '');
}

export const MEDIA_TYPE_LABEL: Record<MediaType, string> = {
  image: 'Backdrops & Posters',
  video: 'Videos (Kulgeet / Anthem)',
  audio: 'Background Tracks'
};

/** Strips UI-only fields (thumbnail data URLs) before media crosses IPC to the stage. */
export function toStageMedia(item: MediaItem): MediaItem {
  const result: MediaItem = {
    id: item.id,
    name: item.name,
    filePath: item.filePath,
    fileUrl: item.fileUrl,
    type: item.type
  };
  if (item.duration !== undefined) result.duration = item.duration;
  if (item.dimensions !== undefined) result.dimensions = { ...item.dimensions };
  return result;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
