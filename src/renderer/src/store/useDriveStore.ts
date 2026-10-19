import { create } from 'zustand';
import type { DriveSource, DriveSyncProgress, DriveSyncResult, MediaItem } from '../types';
import { baseName, mediaPathKey } from '../services/utils';
import { useMediaStore } from './useMediaStore';
import { useShowStore } from './useShowStore';

/* =========================================================================
 * Google Drive performer-track folders.
 * Sources belong to the show; the API key and auto-sync settings belong to
 * this laptop (localStorage). Each sync downloads into a local folder that is
 * linked to the library, so tracks play offline.
 * ========================================================================= */

export const DRIVE_PREFS_KEY = 'stagecue-av:drive:v1';
export const SYNC_INTERVALS = [30, 60, 120, 300] as const;

export interface DriveStatus {
  syncing: boolean;
  progress: DriveSyncProgress | null;
  lastResult: DriveSyncResult | null;
  lastSyncAt: number | null;
  error: string | null;
}

interface DrivePrefs {
  apiKey: string;
  autoSync: boolean;
  intervalSec: number;
}

const DEFAULT_PREFS: DrivePrefs = { apiKey: '', autoSync: true, intervalSec: 60 };

export function parseDrivePrefs(text: string | null): DrivePrefs {
  if (!text) return { ...DEFAULT_PREFS };
  try {
    const raw = JSON.parse(text) as Partial<DrivePrefs>;
    return {
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, 200) : '',
      autoSync: typeof raw.autoSync === 'boolean' ? raw.autoSync : DEFAULT_PREFS.autoSync,
      intervalSec: (SYNC_INTERVALS as readonly number[]).includes(Number(raw.intervalSec)) ? Number(raw.intervalSec) : DEFAULT_PREFS.intervalSec
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function loadPrefs(): DrivePrefs {
  try {
    return parseDrivePrefs(window.localStorage.getItem(DRIVE_PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const emptyStatus = (): DriveStatus => ({ syncing: false, progress: null, lastResult: null, lastSyncAt: null, error: null });

export interface DriveStoreState extends DrivePrefs {
  sources: DriveSource[];
  status: Record<string, DriveStatus>;
  adding: boolean;
  addSource: (url: string, localDir: string | null) => Promise<DriveSource | null>;
  removeSource: (id: string) => void;
  syncSource: (id: string, reason?: 'manual' | 'auto' | 'open') => Promise<DriveSyncResult | null>;
  syncAll: (reason: 'manual' | 'auto' | 'open') => Promise<void>;
  loadSources: (sources: DriveSource[]) => void;
  setProgress: (progress: DriveSyncProgress) => void;
  setApiKey: (key: string) => void;
  setAutoSync: (enabled: boolean) => void;
  setIntervalSec: (seconds: number) => void;
  /** Sources whose auto-sync interval has elapsed. */
  dueSources: (now: number) => DriveSource[];
}

export const useDriveStore = create<DriveStoreState>((set, get) => {
  const initial = typeof window !== 'undefined' ? loadPrefs() : { ...DEFAULT_PREFS };
  const persist = (): void => {
    const { apiKey, autoSync, intervalSec } = get();
    try {
      window.localStorage.setItem(DRIVE_PREFS_KEY, JSON.stringify({ apiKey, autoSync, intervalSec }));
    } catch {
      return;
    }
  };
  const patchStatus = (id: string, patch: Partial<DriveStatus>): void =>
    set((state) => ({ status: { ...state.status, [id]: { ...(state.status[id] ?? emptyStatus()), ...patch } } }));
  /** Errors from background syncs are announced once, not every minute. */
  const announcedErrors = new Map<string, string>();

  return {
    ...initial,
    sources: [],
    status: {},
    adding: false,

    addSource: async (url, localDir) => {
      set({ adding: true });
      try {
        const source = await window.api.invoke('drive:inspect', { url, localDir, apiKey: get().apiKey || null });
        const existing = get().sources.find((s) => s.folderId === source.folderId);
        if (existing) {
          useShowStore.getState().pushAlert('info', 'Already added', `“${existing.name}” is already synced.`, false);
          void get().syncSource(existing.id, 'manual');
          return existing;
        }
        set((state) => ({ sources: [...state.sources, source], status: { ...state.status, [source.id]: emptyStatus() } }));
        useShowStore.getState().markDirty();
        void get().syncSource(source.id, 'manual');
        return source;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '');
        useShowStore.getState().pushAlert('error', 'Could not add the Drive folder', message);
        return null;
      } finally {
        set({ adding: false });
      }
    },

    removeSource: (id) => {
      set((state) => {
        const { [id]: _removed, ...status } = state.status;
        return { sources: state.sources.filter((s) => s.id !== id), status };
      });
      useShowStore.getState().markDirty();
    },

    syncSource: async (id, reason = 'manual') => {
      const source = get().sources.find((s) => s.id === id);
      if (!source || get().status[id]?.syncing) return null;
      patchStatus(id, { syncing: true, error: null, progress: null });
      const show = useShowStore.getState();
      try {
        const result = await window.api.invoke('drive:sync', { source, apiKey: get().apiKey || null });
        patchStatus(id, { syncing: false, lastResult: result, lastSyncAt: result.at, error: result.error, progress: null });

        if (!result.ok) {
          if (reason !== 'auto' || announcedErrors.get(id) !== result.error) {
            show.pushAlert('error', `Drive sync failed: “${source.name}”`, `${result.error ?? 'Unknown error'}. Tracks already downloaded still play.`);
            announcedErrors.set(id, result.error ?? '');
          }
          return result;
        }
        announcedErrors.delete(id);

        const media = useMediaStore.getState();
        const linked = media.folders.some((f) => mediaPathKey(f, window.api.platform) === mediaPathKey(source.localPath, window.api.platform));
        const changed = result.downloaded.length + result.updated.length > 0;
        if (changed || !linked) {
          const outcome = await media.rescanFolder(source.localPath, { quiet: true });
          const keys = new Set([...result.downloaded, ...result.updated].map((p) => mediaPathKey(p, window.api.platform)));
          const fresh = useMediaStore
            .getState()
            .items.filter((i: MediaItem) => keys.has(mediaPathKey(i.pdf?.originalPath ?? i.filePath, window.api.platform)) || outcome?.added.some((a) => a.id === i.id));
          useMediaStore.getState().markNew(fresh.map((i) => i.id));
          if (fresh.length > 0) {
            const names = [...result.downloaded, ...result.updated].map((p) => baseName(p));
            show.pushAlert(
              'success',
              `${names.length} new from “${source.name}”`,
              `${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}. Marked NEW in the library.`,
              false
            );
          }
        } else if (reason === 'manual') {
          show.pushAlert('info', `“${source.name}” is up to date`, `${result.unchanged} file(s) already on this laptop.`, false);
        }
        if (result.failed.length > 0) {
          show.pushAlert(
            'warning',
            `${result.failed.length} file(s) could not be downloaded`,
            result.failed
              .slice(0, 3)
              .map((f) => `${f.name}: ${f.error}`)
              .join(' · ')
          );
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        patchStatus(id, { syncing: false, error: message, progress: null, lastSyncAt: Date.now() });
        if (reason !== 'auto') show.pushAlert('error', `Drive sync failed: “${source.name}”`, message);
        return null;
      }
    },

    syncAll: async (reason) => {
      for (const source of get().sources) await get().syncSource(source.id, reason);
    },

    loadSources: (sources) => {
      set({
        sources: sources.map((s) => ({ ...s })),
        status: Object.fromEntries(sources.map((s) => [s.id, emptyStatus()]))
      });
    },

    setProgress: (progress) => patchStatus(progress.sourceId, { progress }),

    setApiKey: (key) => {
      set({ apiKey: key.trim().slice(0, 200) });
      persist();
    },

    setAutoSync: (enabled) => {
      set({ autoSync: enabled });
      persist();
    },

    setIntervalSec: (seconds) => {
      if (!(SYNC_INTERVALS as readonly number[]).includes(seconds)) return;
      set({ intervalSec: seconds });
      persist();
    },

    dueSources: (now) => {
      const { autoSync, intervalSec, sources, status } = get();
      if (!autoSync) return [];
      return sources.filter((s) => {
        const st = status[s.id];
        if (st?.syncing) return false;
        return !st?.lastSyncAt || now - st.lastSyncAt >= intervalSec * 1000;
      });
    }
  };
});
