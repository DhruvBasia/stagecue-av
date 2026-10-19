import type { Server } from 'node:http';

export interface RelayOptions {
  /** When set, laptops must send this in the x-stagecue-host-key header. */
  hostKey?: string;
}

export interface RelayServer extends Server {
  closeRelay(): Promise<void>;
}

export function createRelayServer(options?: RelayOptions): RelayServer;
