import { create } from 'zustand';
import type { WebFrame } from '../types';
import { useMediaStore } from './useMediaStore';

/* Live picture and state of the web page on stage (sent by the main process
 * about 8 times a second while a web-page cue is live). */

const THUMB_WIDTH = 240;
const THUMB_HEIGHT = 135;
/** Flipbooks often show a dark loading screen first: take the thumbnail once the page has settled. */
const THUMB_SETTLE_MS = 3000;

export interface WebStoreState {
  frame: WebFrame | null;
  /** Latest picture (frames without a new picture keep this one). */
  image: string | null;
  handleFrame: (frame: WebFrame) => void;
  clear: () => void;
}

/** Library items whose card already shows a real picture of the page. */
const snapshotted = new Set<string>();
/** When each page was first seen loaded on stage. */
const loadedSince = new Map<string, number>();

/** Turns the first live picture of a web page into its library thumbnail (used by the cue list and phones). */
function adoptThumbnail(mediaId: string, image: string): void {
  if (snapshotted.has(mediaId)) return;
  snapshotted.add(mediaId);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx || img.naturalWidth === 0) return;
    const scale = Math.min(THUMB_WIDTH / img.naturalWidth, THUMB_HEIGHT / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    ctx.drawImage(img, (THUMB_WIDTH - w) / 2, (THUMB_HEIGHT - h) / 2, w, h);
    useMediaStore.getState().setThumbnail(mediaId, canvas.toDataURL('image/jpeg', 0.72));
  };
  img.src = image;
}

export const useWebStore = create<WebStoreState>((set, get) => ({
  frame: null,
  image: null,

  handleFrame: (frame) => {
    const previous = get().frame;
    const sameMedia = previous !== null && previous.mediaId === frame.mediaId;
    const image = frame.image ?? (sameMedia ? get().image : null);
    set({ frame, image });
    // Wait until the page has finished loading and settled so the thumbnail is not a blank loading screen.
    if (frame.loading) {
      loadedSince.delete(frame.mediaId);
      return;
    }
    const since = loadedSince.get(frame.mediaId) ?? frame.at;
    loadedSince.set(frame.mediaId, since);
    if (image && frame.at - since >= THUMB_SETTLE_MS) adoptThumbnail(frame.mediaId, image);
  },

  clear: () => set({ frame: null, image: null })
}));

/** Marks items that came with a real snapshot (added through the web-page dialog). */
export function markSnapshotted(mediaId: string): void {
  snapshotted.add(mediaId);
}
