import { create } from 'zustand';
import type { UpdateStatus } from '../types';

/* App self-update status (pushed by the main process). */

export interface UpdateStoreState {
  status: UpdateStatus | null;
  setStatus: (status: UpdateStatus) => void;
  checkNow: () => Promise<void>;
  /** Asks first: the projector goes dark while StageCue restarts. */
  installNow: () => Promise<void>;
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  status: null,

  setStatus: (status) => set({ status }),

  checkNow: async () => {
    try {
      set({ status: await window.api.invoke('app:update-check') });
    } catch (error) {
      const current = get().status;
      if (current) set({ status: { ...current, state: 'error', error: error instanceof Error ? error.message : String(error) } });
    }
  },

  installNow: async () => {
    const version = get().status?.version ?? 'the new version';
    const ok = window.confirm(
      `Install StageCue ${version} now?\n\nStageCue closes, updates and opens again (about 20 seconds). The projector shows the desktop meanwhile, so do this after the show.\n\nSave the show first.`
    );
    if (!ok) return;
    await window.api.invoke('app:update-install');
  }
}));
