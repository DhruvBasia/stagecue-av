import { create } from 'zustand';
import type { CrewMessage, CrewMessageKind } from '../types';

/* Messages between the AV room and the stage crew (phones/tablets). */

const MAX_MESSAGES = 100;

export const QUICK_REPLIES: ReadonlyArray<{ kind: CrewMessageKind; text: string }> = [
  { kind: 'reply', text: 'Copy that' },
  { kind: 'standby', text: 'Stand by' },
  { kind: 'reply', text: 'GO' },
  { kind: 'hold', text: 'Hold — wait for my cue' }
];

export interface CrewStoreState {
  messages: CrewMessage[];
  unread: number;
  addMessage: (message: CrewMessage) => void;
  markRead: () => void;
  send: (text: string, to: string | null, kind?: CrewMessageKind) => void;
}

export const useCrewStore = create<CrewStoreState>((set, get) => ({
  messages: [],
  unread: 0,

  addMessage: (message) => {
    if (get().messages.some((m) => m.id === message.id)) return;
    set((state) => ({
      messages: [...state.messages, message].slice(-MAX_MESSAGES),
      unread: message.role === 'av-room' ? state.unread : state.unread + 1
    }));
  },

  markRead: () => set({ unread: 0 }),

  send: (text, to, kind = 'reply') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    window.api.send('remote:send-message', { kind, text: trimmed.slice(0, 200), to });
  }
}));
