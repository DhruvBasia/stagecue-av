import { create } from 'zustand';
import {
  DEFAULT_STAGE_PERMISSIONS,
  type InternetConfig,
  type InternetMode,
  type RemoteInfo,
  type StageTeamPermissions
} from '../types';

function randomString(length: number, alphabet: string): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function newRoomId(): string {
  return randomString(12, 'abcdefghijkmnpqrstuvwxyz23456789');
}

export function newRoomSecret(): string {
  return randomString(40, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789');
}

/* Machine preferences (this laptop, not the show): clicker and crew remote.
 * Stored in localStorage; the app works the same if storage is unavailable.
 * Remote links (tokens) are kept so QR codes printed for the crew keep
 * working across restarts until the operator regenerates them. */

export const PREFS_KEY = 'stagecue-av:prefs:v2';
export const DEFAULT_REMOTE_PORT = 8787;

export interface Prefs {
  clickerEnabled: boolean;
  remoteEnabled: boolean;
  remotePort: number;
  operatorToken: string;
  stageToken: string;
  stagePermissions: StageTeamPermissions;
  stageLocked: boolean;
  internet: InternetConfig;
}

export const DEFAULT_PREFS: Prefs = {
  clickerEnabled: true,
  remoteEnabled: false,
  remotePort: DEFAULT_REMOTE_PORT,
  operatorToken: '',
  stageToken: '',
  stagePermissions: { ...DEFAULT_STAGE_PERMISSIONS },
  stageLocked: false,
  // Internet by default: phones work from any network or mobile data.
  internet: { mode: 'tunnel', relayUrl: '', roomId: '', roomSecret: '', relayHostKey: '' }
};

const TOKEN_PATTERN = /^[a-f0-9]{24,64}$/;

/** Fills in a room id / secret the first time, so relay links stay the same afterwards. */
export function completeInternet(raw: Partial<InternetConfig> | undefined): InternetConfig {
  const mode: InternetMode = raw?.mode === 'off' || raw?.mode === 'relay' || raw?.mode === 'tunnel' ? raw.mode : 'tunnel';
  const roomId = typeof raw?.roomId === 'string' && /^[a-z0-9]{8,32}$/.test(raw.roomId) ? raw.roomId : newRoomId();
  const roomSecret = typeof raw?.roomSecret === 'string' && raw.roomSecret.length >= 16 ? raw.roomSecret : newRoomSecret();
  return {
    mode,
    relayUrl: typeof raw?.relayUrl === 'string' ? raw.relayUrl.trim().slice(0, 300) : '',
    roomId,
    roomSecret,
    relayHostKey: typeof raw?.relayHostKey === 'string' ? raw.relayHostKey.trim().slice(0, 200) : ''
  };
}

export function parsePrefs(text: string | null): Prefs {
  if (!text) return { ...DEFAULT_PREFS, stagePermissions: { ...DEFAULT_STAGE_PERMISSIONS }, internet: completeInternet(undefined) };
  try {
    const raw = JSON.parse(text) as Partial<Prefs>;
    const port = typeof raw.remotePort === 'number' && Number.isInteger(raw.remotePort) ? raw.remotePort : DEFAULT_REMOTE_PORT;
    const perms = (raw.stagePermissions ?? {}) as Partial<StageTeamPermissions>;
    const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
    return {
      clickerEnabled: bool(raw.clickerEnabled, DEFAULT_PREFS.clickerEnabled),
      remoteEnabled: bool(raw.remoteEnabled, DEFAULT_PREFS.remoteEnabled),
      remotePort: port >= 1024 && port <= 65535 ? port : DEFAULT_REMOTE_PORT,
      operatorToken: typeof raw.operatorToken === 'string' && TOKEN_PATTERN.test(raw.operatorToken) ? raw.operatorToken : '',
      stageToken: typeof raw.stageToken === 'string' && TOKEN_PATTERN.test(raw.stageToken) ? raw.stageToken : '',
      stagePermissions: {
        takeCues: bool(perms.takeCues, DEFAULT_STAGE_PERMISSIONS.takeCues),
        mediaControls: bool(perms.mediaControls, DEFAULT_STAGE_PERMISSIONS.mediaControls),
        emergency: bool(perms.emergency, DEFAULT_STAGE_PERMISSIONS.emergency),
        autoFollow: bool(perms.autoFollow, DEFAULT_STAGE_PERMISSIONS.autoFollow)
      },
      stageLocked: bool(raw.stageLocked, false),
      internet: completeInternet(raw.internet)
    };
  } catch {
    return { ...DEFAULT_PREFS, stagePermissions: { ...DEFAULT_STAGE_PERMISSIONS }, internet: completeInternet(undefined) };
  }
}

function load(): Prefs {
  try {
    return parsePrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return parsePrefs(null);
  }
}

function save(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    return;
  }
}

export interface PrefsStoreState extends Prefs {
  remoteInfo: RemoteInfo | null;
  remoteBusy: boolean;
  setClickerEnabled: (enabled: boolean) => void;
  configureRemote: (enabled: boolean, port?: number) => Promise<RemoteInfo | null>;
  regenerateLinks: () => Promise<RemoteInfo | null>;
  setStagePermission: (key: keyof StageTeamPermissions, value: boolean) => Promise<void>;
  setStageLocked: (locked: boolean) => Promise<void>;
  setInternet: (patch: Partial<InternetConfig>) => Promise<void>;
  setRemoteInfo: (info: RemoteInfo) => void;
}

export const usePrefsStore = create<PrefsStoreState>((set, get) => {
  const initial = typeof window !== 'undefined' ? load() : parsePrefs(null);
  const persist = (): void => {
    const { clickerEnabled, remoteEnabled, remotePort, operatorToken, stageToken, stagePermissions, stageLocked, internet } = get();
    save({ clickerEnabled, remoteEnabled, remotePort, operatorToken, stageToken, stagePermissions, stageLocked, internet });
  };

  const apply = async (enabled: boolean, port: number, regenerate: boolean): Promise<RemoteInfo | null> => {
    set({ remoteBusy: true, remoteEnabled: enabled, remotePort: port });
    persist();
    try {
      const { operatorToken, stageToken, stagePermissions, stageLocked, internet } = get();
      const info = await window.api.invoke('remote:configure', {
        enabled,
        port,
        operatorToken: operatorToken || undefined,
        stageToken: stageToken || undefined,
        regenerate,
        stagePermissions,
        stageLocked,
        internet
      });
      set({
        remoteInfo: info,
        remoteEnabled: enabled && info.enabled,
        operatorToken: info.operatorToken,
        stageToken: info.stageToken
      });
      persist();
      return info;
    } catch (error) {
      set((state) => ({
        remoteEnabled: false,
        remoteInfo: {
          enabled: false,
          port,
          operatorToken: state.operatorToken,
          stageToken: state.stageToken,
          links: [],
          clients: [],
          stagePermissions: state.stagePermissions,
          stageLocked: state.stageLocked,
          internet: { mode: state.internet.mode, state: 'off', publicBase: null, error: null },
          error: error instanceof Error ? error.message : String(error)
        }
      }));
      persist();
      return null;
    } finally {
      set({ remoteBusy: false });
    }
  };

  return {
    ...initial,
    remoteInfo: null,
    remoteBusy: false,

    setClickerEnabled: (enabled) => {
      set({ clickerEnabled: enabled });
      persist();
    },

    configureRemote: (enabled, port = get().remotePort) => apply(enabled, port, false),

    regenerateLinks: () => apply(get().remoteEnabled, get().remotePort, true),

    setStagePermission: async (key, value) => {
      set((state) => ({ stagePermissions: { ...state.stagePermissions, [key]: value } }));
      persist();
      await apply(get().remoteEnabled, get().remotePort, false);
    },

    setStageLocked: async (locked) => {
      set({ stageLocked: locked });
      persist();
      await apply(get().remoteEnabled, get().remotePort, false);
    },

    setInternet: async (patch) => {
      set((state) => ({ internet: completeInternet({ ...state.internet, ...patch }) }));
      persist();
      if (get().remoteEnabled) await apply(true, get().remotePort, false);
    },

    setRemoteInfo: (info) => set({ remoteInfo: info })
  };
});
