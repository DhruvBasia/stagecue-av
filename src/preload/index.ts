import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  INVOKE_CHANNELS,
  MAIN_TO_RENDERER_CHANNELS,
  OPERATOR_TO_STAGE_CHANNELS,
  STAGE_INVOKE_CHANNELS,
  STAGE_TO_OPERATOR_CHANNELS,
  type InvokeContracts,
  type ReceivePayloads,
  type SendPayloads,
  type StageCueApi,
  type WindowRole
} from '../renderer/src/types';

/**
 * Context-isolated bridge. Each window only gets the channels that make sense
 * for its role: the operator can command the stage, the stage can report
 * telemetry back. Nothing else from Node/Electron leaks into the page.
 */

function readArgument(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

const role: WindowRole = readArgument('stagecue-role') === 'stage' ? 'stage' : 'operator';
const isE2E = process.argv.includes('--stagecue-e2e');

const sendable = new Set<string>(
  role === 'operator'
    ? [
        ...OPERATOR_TO_STAGE_CHANNELS,
        'app:set-dirty',
        'remote:status',
        'remote:cues',
        'remote:ack',
        'remote:send-message',
        'web:input'
      ]
    : [...STAGE_TO_OPERATOR_CHANNELS, 'stage:ready', 'stage:web-live']
);

const receivable = new Set<string>(
  role === 'operator'
    ? [...STAGE_TO_OPERATOR_CHANNELS, ...MAIN_TO_RENDERER_CHANNELS]
    : [...OPERATOR_TO_STAGE_CHANNELS, 'display:changed']
);

const invokable = new Set<string>(role === 'operator' ? INVOKE_CHANNELS : STAGE_INVOKE_CHANNELS);

const api: StageCueApi = {
  role,
  platform: process.platform,
  isE2E,

  send<C extends keyof SendPayloads>(channel: C, payload: SendPayloads[C]): void {
    if (!sendable.has(channel)) {
      throw new Error(`[StageCue] Channel "${channel}" is not allowed for the ${role} window`);
    }
    ipcRenderer.send(channel, payload);
  },

  on<C extends keyof ReceivePayloads>(channel: C, listener: (payload: ReceivePayloads[C]) => void): () => void {
    if (!receivable.has(channel)) {
      throw new Error(`[StageCue] Cannot subscribe to "${channel}" from the ${role} window`);
    }
    const wrapped = (_event: IpcRendererEvent, payload: ReceivePayloads[C]): void => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },

  invoke<C extends keyof InvokeContracts>(
    channel: C,
    ...args: InvokeContracts[C]['args']
  ): Promise<InvokeContracts[C]['result']> {
    if (!invokable.has(channel)) {
      return Promise.reject(new Error(`[StageCue] Cannot invoke "${channel}" from the ${role} window`));
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<InvokeContracts[C]['result']>;
  },

  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  }
};

contextBridge.exposeInMainWorld('api', api);
