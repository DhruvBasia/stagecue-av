import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WebSocket, type RawData } from 'ws';
import type { InternetState, InternetStatus } from '../renderer/src/types';

/* =========================================================================
 * Internet access for the crew remote, so phones work from ANY network
 * (another Wi-Fi, mobile data) and the laptop may be on mobile data too.
 *
 *  QuickTunnel – runs Cloudflare's `cloudflared` to give the laptop's local
 *                remote server a public https/wss address. No account.
 *  RelayLink   – connects OUT to a StageCue relay server (relay/server.js);
 *                phones connect to the same relay. Permanent URL.
 *
 * Both only carry traffic; the secret link tokens are still checked here
 * on the laptop by RemoteServer.
 * ========================================================================= */

/** What RemoteServer needs from a phone connection, whatever the transport. */
export interface PeerSocket {
  isOpen(): boolean;
  send(text: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  ping(): void;
  onMessage(listener: (text: string) => void): void;
  onPong(listener: () => void): void;
  onClose(listener: () => void): void;
}

export function wrapWebSocket(ws: WebSocket): PeerSocket {
  return {
    isOpen: () => ws.readyState === WebSocket.OPEN,
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
    ping: () => ws.ping(),
    onMessage: (listener) => ws.on('message', (data: RawData) => listener(data.toString())),
    onPong: (listener) => ws.on('pong', listener),
    onClose: (listener) => {
      ws.on('close', listener);
      ws.on('error', () => ws.terminate());
    }
  };
}

export type StatusListener = (status: InternetStatus) => void;

/* ------------------------------ Cloudflare -------------------------------- */

export const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseTunnelUrl(output: string): string | null {
  return TUNNEL_URL_PATTERN.exec(output)?.[0] ?? null;
}

/** cloudflared locations used by its installers (winget, MSI, Homebrew, packages) plus PATH. */
export function cloudflaredCandidates(platform: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const list: string[] = [];
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) list.push(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
      if (base) list.push(path.win32.join(base, 'cloudflared', exe));
    }
  } else {
    list.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared');
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) list.push(path.join(dir, exe));
  return [...new Set(list)];
}

export function findCloudflared(platform: string = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  return cloudflaredCandidates(platform).find((p) => exists(p)) ?? null;
}

export interface QuickTunnelOptions {
  onStatus: StatusListener;
  /** Overrides for tests: the command and its arguments for a local port. */
  command?: string | null;
  args?: (port: number) => string[];
  restartDelayMs?: number;
}

export class QuickTunnel {
  private child: ChildProcess | null = null;
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private status: InternetStatus = { mode: 'tunnel', state: 'off', publicBase: null, error: null };

  constructor(private readonly options: QuickTunnelOptions) {}

  getStatus(): InternetStatus {
    return this.status;
  }

  private setStatus(state: InternetState, publicBase: string | null, error: string | null): void {
    this.status = { mode: 'tunnel', state, publicBase, error };
    this.options.onStatus(this.status);
  }

  start(port: number): void {
    this.stopped = false;
    const command = this.options.command === undefined ? findCloudflared() : this.options.command;
    if (!command) {
      this.setStatus('not-installed', null, 'cloudflared is not installed on this laptop');
      return;
    }
    const args = this.options.args ? this.options.args(port) : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    this.setStatus(this.restarts > 0 ? 'reconnecting' : 'starting', null, null);
    let child: ChildProcess;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.setStatus('error', null, error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    let buffer = '';
    const onOutput = (chunk: Buffer): void => {
      buffer = (buffer + chunk.toString()).slice(-8000);
      const url = parseTunnelUrl(buffer);
      if (url && this.status.publicBase !== url) {
        this.restarts = 0;
        this.setStatus('online', url, null);
      }
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
    child.on('error', (error) => {
      if (this.child === child) this.setStatus('error', null, error.message);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      // A quick tunnel gets a NEW address when it restarts; phones must rescan the QR code.
      this.setStatus('reconnecting', null, `cloudflared stopped (code ${code ?? 'unknown'}); restarting…`);
      this.restarts += 1;
      const delay = Math.min((this.options.restartDelayMs ?? 3000) * this.restarts, 30_000);
      this.restartTimer = setTimeout(() => this.start(port), delay);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.restarts = 0;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
    this.setStatus('off', null, null);
  }
}

/* --------------------------------- Relay ---------------------------------- */

export function relayWsUrl(relayUrl: string, roomId: string): string {
  const base = relayUrl.trim().replace(/\/+$/, '');
  const wsBase = base.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
  return `${wsBase}/host?room=${encodeURIComponent(roomId)}`;
}

export function relayPublicBase(relayUrl: string, roomId: string): string {
  const base = relayUrl.trim().replace(/\/+$/, '').replace(/^ws(s?):\/\//i, (_m, s: string) => `http${s}://`);
  return `${base}/r/${roomId}`;
}

export function isValidRelayUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol) && url.hostname.length > 0;
  } catch {
    return false;
  }
}

class RelayPeer implements PeerSocket {
  private closed = false;
  private readonly messageListeners: Array<(text: string) => void> = [];
  private readonly pongListeners: Array<() => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  constructor(
    readonly cid: number,
    private readonly link: RelayLink
  ) {}

  isOpen(): boolean {
    return !this.closed && this.link.isOnline();
  }

  send(text: string): void {
    if (this.isOpen()) this.link.sendFrame({ type: 'data', cid: this.cid, data: text });
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.link.sendFrame({ type: 'close', cid: this.cid, code, reason });
    this.remoteClosed();
  }

  terminate(): void {
    this.close(4002, 'terminated');
  }

  /** The relay itself heartbeats phones; while the laptop's link is up, the phone counts as alive. */
  ping(): void {
    if (this.isOpen()) for (const l of this.pongListeners) l();
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListeners.push(listener);
  }

  onPong(listener: () => void): void {
    this.pongListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  deliver(text: string): void {
    if (!this.closed) for (const l of this.messageListeners) l(text);
  }

  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closeListeners) l();
  }
}

export interface RelayLinkOptions {
  relayUrl: string;
  roomId: string;
  roomSecret: string;
  hostKey: string;
  pageHtml: string;
  /** Hands a phone to RemoteServer; returns false when its link token is not valid. */
  accept: (token: string, peer: PeerSocket, address: string) => boolean;
  onStatus: StatusListener;
}

export class RelayLink {
  private ws: WebSocket | null = null;
  private stopped = true;
  private online = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly peers = new Map<number, RelayPeer>();
  private status: InternetStatus = { mode: 'relay', state: 'off', publicBase: null, error: null };

  constructor(private readonly options: RelayLinkOptions) {}

  getStatus(): InternetStatus {
    return this.status;
  }

  isOnline(): boolean {
    return this.online;
  }

  private setStatus(state: InternetState, error: string | null): void {
    this.status = {
      mode: 'relay',
      state,
      publicBase: state === 'online' ? relayPublicBase(this.options.relayUrl, this.options.roomId) : null,
      error
    };
    this.options.onStatus(this.status);
  }

  start(): void {
    this.stopped = false;
    if (!isValidRelayUrl(this.options.relayUrl)) {
      this.setStatus('error', 'Enter your relay server address, e.g. https://stagecue-relay.onrender.com');
      return;
    }
    this.connect();
  }

  private connect(): void {
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'starting', this.status.error);
    const headers: Record<string, string> = { 'x-stagecue-secret': this.options.roomSecret };
    if (this.options.hostKey) headers['x-stagecue-host-key'] = this.options.hostKey;
    const ws = new WebSocket(relayWsUrl(this.options.relayUrl, this.options.roomId), { headers, handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ type: 'page', html: this.options.pageHtml }));
    });
    ws.on('unexpected-response', (_req, res) => {
      const reason =
        res.statusCode === 403
          ? 'The relay refused this laptop (wrong host key, or the room belongs to another laptop)'
          : `Relay answered HTTP ${res.statusCode}`;
      this.setStatus('error', reason);
      ws.terminate();
    });
    ws.on('message', (raw: RawData) => this.onFrame(raw.toString()));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.dropLink();
      if (this.stopped) return;
      this.attempts += 1;
      const delay = Math.min(1000 * 2 ** Math.min(this.attempts - 1, 5), 30_000);
      if (this.status.state !== 'error') this.setStatus('reconnecting', 'Lost the relay connection; retrying…');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    ws.on('error', (error) => {
      if (this.ws === ws && this.status.state !== 'error') this.setStatus('reconnecting', error.message);
    });
    ws.on('pong', () => undefined);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20_000);
  }

  private onFrame(text: string): void {
    let frame: { type?: string; cid?: unknown; token?: unknown; address?: unknown; data?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'ready':
        this.online = true;
        this.attempts = 0;
        this.setStatus('online', null);
        return;
      case 'open': {
        if (typeof frame.cid !== 'number') return;
        const peer = new RelayPeer(frame.cid, this);
        this.peers.set(frame.cid, peer);
        peer.onClose(() => this.peers.delete(peer.cid));
        const accepted = this.options.accept(String(frame.token ?? ''), peer, `${String(frame.address ?? '')} (internet)`);
        if (!accepted) peer.close(4001, 'Link not valid');
        return;
      }
      case 'data':
        if (typeof frame.cid === 'number' && typeof frame.data === 'string') this.peers.get(frame.cid)?.deliver(frame.data);
        return;
      case 'close':
        if (typeof frame.cid === 'number') this.peers.get(frame.cid)?.remoteClosed();
        return;
      default:
        return;
    }
  }

  sendFrame(frame: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private dropLink(): void {
    this.online = false;
    this.ws = null;
    for (const peer of [...this.peers.values()]) peer.remoteClosed();
    this.peers.clear();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.reconnectTimer = null;
    this.heartbeat = null;
    const ws = this.ws;
    this.dropLink();
    ws?.close(1000, 'stopped');
    this.attempts = 0;
    this.setStatus('off', null);
  }
}
