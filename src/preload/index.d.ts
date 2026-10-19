import type { StageCueApi } from '../renderer/src/types';

declare global {
  interface Window {
    api: StageCueApi;
  }
}

export {};
