import type { MediaItem } from '../types';

/* =========================================================================
 * Off-DOM media probing (operator window): duration, dimensions and a small
 * JPEG thumbnail so the library never decodes full 4K posters repeatedly.
 * Probes run through a tiny queue to avoid spinning up many decoders at once.
 * ========================================================================= */

export interface ProbeResult {
  duration?: number;
  dimensions?: { width: number; height: number };
  thumbnailUrl?: string;
  probeError?: string;
}

const THUMB_WIDTH = 240;
const THUMB_HEIGHT = 135;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT = 2;

let active = 0;
const queue: Array<() => void> = [];

function runQueued<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      active += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) start();
    else queue.push(start);
  });
}

function drawThumbnail(source: CanvasImageSource, width: number, height: number): string | undefined {
  if (width <= 0 || height <= 0) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  const scale = Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height);
  const w = width * scale;
  const h = height * scale;
  try {
    ctx.drawImage(source, (THUMB_WIDTH - w) / 2, (THUMB_HEIGHT - h) / 2, w, h);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), PROBE_TIMEOUT_MS);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(onTimeout());
      });
  });
}

function probeImage(url: string): Promise<ProbeResult> {
  const img = new Image();
  img.decoding = 'async';
  img.crossOrigin = 'anonymous';
  const work = new Promise<ProbeResult>((resolve) => {
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      const effectiveWidth = width > 0 ? width : THUMB_WIDTH;
      const effectiveHeight = height > 0 ? height : THUMB_HEIGHT;
      resolve({
        dimensions: width > 0 && height > 0 ? { width, height } : undefined,
        thumbnailUrl: drawThumbnail(img, effectiveWidth, effectiveHeight)
      });
    };
    img.onerror = () => resolve({ probeError: 'Image could not be decoded' });
  });
  img.src = url;
  return withTimeout(work, () => ({ probeError: 'Timed out reading image' })).finally(() => {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
  });
}

function releaseMedia(el: HTMLMediaElement): void {
  el.onloadedmetadata = null;
  el.onseeked = null;
  el.onerror = null;
  el.pause();
  el.removeAttribute('src');
  el.load();
}

function probeVideo(url: string): Promise<ProbeResult> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'metadata';
  video.playsInline = true;
  const work = new Promise<ProbeResult>((resolve) => {
    let duration: number | undefined;
    let dimensions: { width: number; height: number } | undefined;
    video.onloadedmetadata = () => {
      duration = Number.isFinite(video.duration) ? video.duration : undefined;
      dimensions =
        video.videoWidth > 0 && video.videoHeight > 0
          ? { width: video.videoWidth, height: video.videoHeight }
          : undefined;
      const seekTo = duration ? Math.min(1, duration * 0.1) : 0;
      video.currentTime = seekTo;
    };
    video.onseeked = () => {
      resolve({
        duration,
        dimensions,
        thumbnailUrl: dimensions ? drawThumbnail(video, dimensions.width, dimensions.height) : undefined
      });
    };
    video.onerror = () => {
      const code = video.error?.code ?? 0;
      resolve({
        duration,
        dimensions,
        probeError: code === 3 || code === 4 ? 'Codec/format not supported by the player' : 'Video could not be read'
      });
    };
  });
  video.src = url;
  return withTimeout(work, () => ({ probeError: 'Timed out reading video' })).finally(() => releaseMedia(video));
}

function probeAudio(url: string): Promise<ProbeResult> {
  const audio = document.createElement('audio');
  audio.crossOrigin = 'anonymous';
  audio.preload = 'metadata';
  const work = new Promise<ProbeResult>((resolve) => {
    audio.onloadedmetadata = () => {
      resolve({ duration: Number.isFinite(audio.duration) ? audio.duration : undefined });
    };
    audio.onerror = () => {
      const code = audio.error?.code ?? 0;
      resolve({ probeError: code === 3 || code === 4 ? 'Codec/format not supported by the player' : 'Audio could not be read' });
    };
  });
  audio.src = url;
  return withTimeout(work, () => ({ probeError: 'Timed out reading audio' })).finally(() => releaseMedia(audio));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A labelled card for web pages and window captures until a real picture is available. */
export function placeholderThumbnail(item: Pick<MediaItem, 'type' | 'name' | 'fileUrl'>): string | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const gradient = ctx.createLinearGradient(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  gradient.addColorStop(0, item.type === 'web' ? '#0c4a6e' : '#3b0764');
  gradient.addColorStop(1, '#0d1117');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.fillText(item.type === 'web' ? 'WEB PAGE' : 'LIVE WINDOW', 12, 22);
  ctx.font = 'bold 17px system-ui, sans-serif';
  const title = item.name.length > 24 ? `${item.name.slice(0, 23)}…` : item.name;
  ctx.fillText(title, 12, THUMB_HEIGHT / 2 + 6);
  if (item.type === 'web') {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(hostOf(item.fileUrl).slice(0, 36), 12, THUMB_HEIGHT - 14);
  }
  return canvas.toDataURL('image/jpeg', 0.8);
}

export function probeMedia(item: MediaItem): Promise<ProbeResult> {
  if (item.type === 'web' || item.type === 'screen') {
    // Nothing to decode; keep a real snapshot if there is one.
    return Promise.resolve(item.thumbnailUrl ? {} : { thumbnailUrl: placeholderThumbnail(item) });
  }
  if (item.missing) return Promise.resolve({ probeError: 'File not found on disk' });
  const kind = item.type;
  return runQueued(() => {
    switch (kind) {
      case 'image':
        return probeImage(item.fileUrl);
      case 'video':
        return probeVideo(item.fileUrl);
      case 'audio':
        return probeAudio(item.fileUrl);
      default: {
        const exhaustive: never = kind;
        return Promise.resolve({ probeError: `Unknown media type ${String(exhaustive)}` });
      }
    }
  });
}
