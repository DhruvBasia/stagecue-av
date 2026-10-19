import { create } from 'zustand';
import type { PreshowReport } from '../services/preshowCheck';
import type { AlertLevel, OperatorAlert } from '../types';
import { createId } from '../services/utils';

/* Show metadata (name, file, dirty flag) and operator-only alert banners. */

const ALERT_LIMIT = 6;

export type OperatorPanel = 'none' | 'preshow' | 'settings' | 'crew';

export interface ShowStoreState {
  /** Which full-screen dialog is open (pre-show check, settings). */
  panel: OperatorPanel;
  preshowReport: PreshowReport | null;
  setPanel: (panel: OperatorPanel) => void;
  setPreshowReport: (report: PreshowReport | null) => void;
  showName: string;
  showFilePath: string | null;
  isDirty: boolean;
  lastSavedAt: string | null;
  alerts: OperatorAlert[];
  markDirty: () => void;
  markSaved: (filePath: string, savedAt: string, name: string) => void;
  resetShow: (name?: string) => void;
  loadedShow: (name: string, filePath: string | null, dirty: boolean) => void;
  pushAlert: (level: AlertLevel, title: string, message: string, sticky?: boolean) => string;
  dismissAlert: (id: string) => void;
  clearAlerts: () => void;
}

export const useShowStore = create<ShowStoreState>((set, get) => ({
  panel: 'none',
  preshowReport: null,
  setPanel: (panel) => set({ panel }),
  setPreshowReport: (report) => set({ preshowReport: report }),
  showName: 'Untitled Show',
  showFilePath: null,
  isDirty: false,
  lastSavedAt: null,
  alerts: [],

  markDirty: () => {
    if (!get().isDirty) set({ isDirty: true });
  },

  markSaved: (filePath, savedAt, name) => set({ showFilePath: filePath, lastSavedAt: savedAt, isDirty: false, showName: name }),

  resetShow: (name = 'Untitled Show') => set({ showName: name, showFilePath: null, isDirty: false, lastSavedAt: null }),

  loadedShow: (name, filePath, dirty) => set({ showName: name, showFilePath: filePath, isDirty: dirty, lastSavedAt: null }),

  pushAlert: (level, title, message, sticky = level === 'error') => {
    const id = createId('alert');
    const alert: OperatorAlert = { id, level, title, message, at: Date.now(), sticky };
    set((state) => {
      // Collapse identical alerts that repeat in a burst (e.g. a codec error on every retry).
      const withoutDuplicate = state.alerts.filter((a) => !(a.title === title && a.message === message));
      return { alerts: [...withoutDuplicate, alert].slice(-ALERT_LIMIT) };
    });
    return id;
  },

  dismissAlert: (id) => set((state) => ({ alerts: state.alerts.filter((a) => a.id !== id) })),

  clearAlerts: () => set({ alerts: [] })
}));
