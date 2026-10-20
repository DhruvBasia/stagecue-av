import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  CREW_MESSAGE_KINDS,
  DEFAULT_STAGE_PERMISSIONS,
  REMOTE_ACTIONS,
  type CrewMessage,
  type CrewMessageKind,
  type CrewMessageRequest,
  type InternetConfig,
  type InternetStatus,
  type RemoteAck,
  type RemoteActionEvent,
  type RemoteActionName,
  type RemoteClientInfo,
  type RemoteConfigRequest,
  type RemoteCue,
  type RemoteInfo,
  type RemoteLink,
  type RemoteRole,
  type RemoteStatus,
  type StageTeamPermissions
} from '../renderer/src/types';
import { QuickTunnel, RelayLink, wrapWebSocket, type PeerSocket } from './internetAccess';
import { REMOTE_PAGE_HTML } from './remotePage';

/* =========================================================================
 * Crew remote over WebSockets.
 *
 * The laptop runs a small HTTP + WebSocket server on the local network.
 * Phones/tablets open the page from a QR code and stay connected over a
 * WebSocket: status, cue list and crew messages are pushed instantly, and
 * every command gets an acknowledgement. Two roles, each with its own
 * secret link:
 *   operator – the AV room's own phone, full control
 *   stage    – the crew beside the stage, limited by the AV room's
 *              permissions and a one-click lock
 * The operator window stays the single source of truth: actions are
 * forwarded to it and it replies with the ack.
 * ========================================================================= */

export const DEFAULT_REMOTE_PORT = 8787;
const MAX_MESSAGE_BYTES = 16 * 1024;
const HEARTBEAT_MS = 5000;
const RATE_WINDOW_MS = 2000;
const RATE_MAX_MESSAGES = 30;
const ACK_TIMEOUT_MS = 4000;
const MAX_NAME = 32;
const MAX_TEXT = 200;

export interface RemoteServerOptions {
  onAction: (event: RemoteActionEvent) => void;
  onMessage: (message: CrewMessage) => void;
  onInfoChange?: (info: RemoteInfo) => void;
  host?: string;
  /** Tests only: replace cloudflared with another command. */
  tunnelCommand?: string | null;
  tunnelArgs?: (port: number) => string[];
}

export const OFF_INTERNET: InternetConfig = { mode: 'off', relayUrl: '', roomId: '', roomSecret: '', relayHostKey: '' };

export function normalizeInternet(value: unknown): InternetConfig {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<InternetConfig>;
  const mode = raw.mode === 'tunnel' || raw.mode === 'relay' ? raw.mode : 'off';
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const roomId = text(raw.roomId, 32).toLowerCase();
  return {
    mode,
    relayUrl: text(raw.relayUrl, 300),
    roomId: /^[a-z0-9]{8,32}$/.test(roomId) ? roomId : '',
    roomSecret: text(raw.roomSecret, 128),
    relayHostKey: text(raw.relayHostKey, 200)
  };
}

export interface LanAddress {
  address: string;
  interfaceName: string;
  hotspot: boolean;
}

/** LAN IPv4 addresses a phone can reach; laptop hotspots and private ranges first. */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LanAddress[] {
  const result: LanAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      // Windows Mobile Hotspot always hands out 192.168.137.0/24 from a "Local Area Connection* N" adapter.
      const hotspot = entry.address.startsWith('192.168.137.') || /local area connection\*/i.test(name);
      result.push({ address: entry.address, interfaceName: name, hotspot });
    }
  }
  const isPrivate = (ip: string): boolean =>
    ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const unique = result.filter((r, i) => result.findIndex((o) => o.address === r.address) === i);
  return unique.sort(
    (a, b) => Number(b.hotspot) - Number(a.hotspot) || Number(isPrivate(b.address)) - Number(isPrivate(a.address))
  );
}

export function tokensMatch(expected: string, provided: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isRemoteAction(value: unknown): value is RemoteActionName {
  return typeof value === 'string' && (REMOTE_ACTIONS as readonly string[]).includes(value);
}

export function isValidToken(token: unknown): token is string {
  return typeof token === 'string' && /^[a-f0-9]{24,64}$/.test(token);
}

export function newToken(): string {
  return randomBytes(16).toString('hex');
}

/** Which stage-team permission an action needs. */
export function permissionFor(action: RemoteActionName): keyof StageTeamPermissions {
  switch (action) {
    case 'take':
    case 'take-cue':
    case 'next-cue':
    case 'prev-cue':
    // Turning pages of the live booklet / flipbook is part of running the cue.
    case 'page-next':
    case 'page-prev':
      return 'takeCues';
    case 'toggle-video':
    case 'music-toggle':
    case 'fade-audio':
      return 'mediaControls';
    case 'freeze':
    case 'blackout':
    case 'instant-backdrop':
      return 'emergency';
    case 'toggle-follow':
      return 'autoFollow';
    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown action ${String(exhaustive)}`);
    }
  }
}

export function checkPermission(
  role: RemoteRole,
  permissions: StageTeamPermissions,
  locked: boolean,
  action: RemoteActionName
): { ok: true } | { ok: false; reason: string } {
  if (role === 'operator') return { ok: true };
  if (locked) return { ok: false, reason: 'Controls are locked by the AV room' };
  if (!permissions[permissionFor(action)]) return { ok: false, reason: 'Not allowed for the stage team' };
  return { ok: true };
}

export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizePermissions(value: unknown): StageTeamPermissions {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<StageTeamPermissions>;
  return {
    takeCues: typeof raw.takeCues === 'boolean' ? raw.takeCues : DEFAULT_STAGE_PERMISSIONS.takeCues,
    mediaControls: typeof raw.mediaControls === 'boolean' ? raw.mediaControls : DEFAULT_STAGE_PERMISSIONS.mediaControls,
    emergency: typeof raw.emergency === 'boolean' ? raw.emergency : DEFAULT_STAGE_PERMISSIONS.emergency,
    autoFollow: typeof raw.autoFollow === 'boolean' ? raw.autoFollow : DEFAULT_STAGE_PERMISSIONS.autoFollow
  };
}

interface ClientState {
  id: string;
  role: RemoteRole;
  name: string;
  address: string;
  connectedAt: number;
  lastSeen: number;
  latencyMs: number | null;
  alive: boolean;
  recent: number[];
  via: 'lan' | 'internet';
}

type ClientMessage =
  | { type: 'hello'; name?: unknown }
  | { type: 'ping'; t?: unknown }
  | { type: 'latency'; ms?: unknown }
  | { type: 'action'; action?: unknown; cueId?: unknown; requestId?: unknown }
  | { type: 'message'; kind?: unknown; text?: unknown };

const MAX_HISTORY = 30;

export class RemoteServer {
  private server: http.Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Map<PeerSocket, ClientState>();
  private readonly pendingAcks = new Map<string, { socket: PeerSocket; timer: ReturnType<typeof setTimeout> }>();
  private internetConfig: InternetConfig = { ...OFF_INTERNET };
  private internetKey = '';
  private tunnel: QuickTunnel | null = null;
  private relay: RelayLink | null = null;
  private internetStatus: InternetStatus = { mode: 'off', state: 'off', publicBase: null, error: null };
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private port = DEFAULT_REMOTE_PORT;
  private error: string | null = null;
  private status: RemoteStatus | null = null;
  private cues: RemoteCue[] = [];
  private history: CrewMessage[] = [];
  private operatorToken = newToken();
  private stageToken = newToken();
  private permissions: StageTeamPermissions = { ...DEFAULT_STAGE_PERMISSIONS };
  private locked = false;

  constructor(private readonly options: RemoteServerOptions) {}

  /* ------------------------------- Lifecycle ----------------------------- */

  getInfo(): RemoteInfo {
    const running = this.server !== null && this.server.listening;
    const host = this.options.host;
    const addresses: LanAddress[] =
      host && host !== '0.0.0.0' ? [{ address: host, interfaceName: 'loopback', hotspot: false }] : lanAddresses();
    const tokenFor = (role: RemoteRole): string => (role === 'operator' ? this.operatorToken : this.stageToken);
    const publicBase = running && this.internetStatus.state === 'online' ? this.internetStatus.publicBase : null;
    const internetLinks: RemoteLink[] = publicBase
      ? (['stage', 'operator'] as const).map((role) => ({
          role,
          url: `${publicBase}/?t=${tokenFor(role)}`,
          scope: 'internet',
          address: new URL(publicBase).host,
          interfaceName: this.internetStatus.mode === 'tunnel' ? 'Internet (Cloudflare tunnel)' : 'Internet (relay)',
          hotspot: false
        }))
      : [];
    const lanLinks: RemoteLink[] = running
      ? addresses.flatMap((a) =>
          (['stage', 'operator'] as const).map((role) => ({
            role,
            url: `http://${a.address}:${this.port}/?t=${tokenFor(role)}`,
            scope: 'lan' as const,
            address: a.address,
            interfaceName: a.interfaceName,
            hotspot: a.hotspot
          }))
        )
      : [];
    return {
      enabled: running,
      port: this.port,
      operatorToken: this.operatorToken,
      stageToken: this.stageToken,
      links: [...internetLinks, ...lanLinks],
      clients: [...this.clients.values()].map((c) => this.describe(c)),
      stagePermissions: { ...this.permissions },
      stageLocked: this.locked,
      internet: { ...this.internetStatus },
      error: this.error
    };
  }

  /* ------------------------------- Internet ------------------------------ */

  /** Starts, restarts or stops the tunnel / relay so phones on other networks can connect. */
  private applyInternet(config: InternetConfig): void {
    const key = JSON.stringify({ ...config, port: this.port, running: Boolean(this.server?.listening) });
    if (key === this.internetKey) return;
    this.internetKey = key;
    this.internetConfig = { ...config };
    this.tunnel?.stop();
    this.relay?.stop();
    this.tunnel = null;
    this.relay = null;
    const onStatus = (status: InternetStatus): void => {
      this.internetStatus = status;
      this.notify();
    };
    if (!this.server?.listening || config.mode === 'off') {
      this.internetStatus = { mode: config.mode, state: 'off', publicBase: null, error: null };
      return;
    }
    if (config.mode === 'tunnel') {
      this.tunnel = new QuickTunnel({ onStatus, command: this.options.tunnelCommand, args: this.options.tunnelArgs });
      this.tunnel.start(this.port);
      return;
    }
    this.relay = new RelayLink({
      relayUrl: config.relayUrl,
      roomId: config.roomId,
      roomSecret: config.roomSecret,
      hostKey: config.relayHostKey,
      pageHtml: REMOTE_PAGE_HTML,
      accept: (token, peer, address) => this.acceptPeer(token, peer, address, 'internet'),
      onStatus
    });
    this.relay.start();
  }

  /** Hands a phone connection (from any transport) to the session logic after checking its link token. */
  acceptPeer(token: string | null, peer: PeerSocket, address: string, via: 'lan' | 'internet'): boolean {
    const role = this.roleFor(token);
    if (!role) return false;
    this.onConnection(peer, role, address, via);
    return true;
  }

  private describe(c: ClientState): RemoteClientInfo {
    return {
      id: c.id,
      name: c.name,
      role: c.role,
      via: c.via,
      address: c.address,
      connectedAt: c.connectedAt,
      lastSeen: c.lastSeen,
      latencyMs: c.latencyMs
    };
  }

  private notify(): void {
    this.options.onInfoChange?.(this.getInfo());
  }

  async configure(request: RemoteConfigRequest): Promise<RemoteInfo> {
    const port =
      typeof request.port === 'number' && Number.isInteger(request.port) && request.port >= 1024 && request.port <= 65535
        ? request.port
        : DEFAULT_REMOTE_PORT;

    const previousOperator = this.operatorToken;
    const previousStage = this.stageToken;
    if (request.regenerate) {
      this.operatorToken = newToken();
      this.stageToken = newToken();
    } else {
      if (isValidToken(request.operatorToken)) this.operatorToken = request.operatorToken;
      if (isValidToken(request.stageToken)) this.stageToken = request.stageToken;
    }
    // Phones holding a revoked link are disconnected immediately.
    for (const [socket, client] of this.clients) {
      const revoked =
        (client.role === 'operator' && this.operatorToken !== previousOperator) ||
        (client.role === 'stage' && this.stageToken !== previousStage);
      if (revoked) socket.close(4001, 'Link revoked');
    }

    const permissionsChanged = JSON.stringify(normalizePermissions(request.stagePermissions)) !== JSON.stringify(this.permissions);
    const lockChanged = Boolean(request.stageLocked) !== this.locked;
    this.permissions = normalizePermissions(request.stagePermissions);
    this.locked = Boolean(request.stageLocked);
    if (permissionsChanged || lockChanged) this.broadcastAccess();

    const internet = normalizeInternet(request.internet);
    if (!request.enabled) {
      await this.stop();
      this.error = null;
      this.notify();
      return this.getInfo();
    }
    if (this.server && this.server.listening && this.port === port) {
      this.applyInternet(internet);
      this.notify();
      return this.getInfo();
    }
    await this.stop();
    this.port = port;
    try {
      await this.start(port);
      this.error = null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      this.error =
        code === 'EADDRINUSE'
          ? `Port ${port} is already in use. Pick another port.`
          : code === 'EACCES'
            ? `Not allowed to open port ${port}.`
            : error instanceof Error
              ? error.message
              : String(error);
      this.server = null;
    }
    this.applyInternet(internet);
    this.notify();
    return this.getInfo();
  }

  private start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleHttp(req, res));
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        server.on('error', (error) => {
          this.error = error.message;
          this.notify();
        });
        this.server = server;
        this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.options.host ?? '0.0.0.0');
    });
  }

  async stop(): Promise<void> {
    this.tunnel?.stop();
    this.relay?.stop();
    this.tunnel = null;
    this.relay = null;
    this.internetKey = '';
    this.internetStatus = { mode: this.internetConfig.mode, state: 'off', publicBase: null, error: null };
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const socket of this.clients.keys()) socket.terminate();
    this.clients.clear();
    for (const pending of this.pendingAcks.values()) clearTimeout(pending.timer);
    this.pendingAcks.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private beat(): void {
    for (const [socket, client] of this.clients) {
      if (!client.alive) {
        socket.terminate();
        continue;
      }
      client.alive = false;
      socket.ping();
    }
  }

  /* -------------------------------- HTTP --------------------------------- */

  private roleFor(token: string | null): RemoteRole | null {
    if (tokensMatch(this.operatorToken, token)) return 'operator';
    if (tokensMatch(this.stageToken, token)) return 'stage';
    return null;
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://remote.local');
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    };
    if (url.pathname === '/' && req.method === 'GET') {
      if (!this.roleFor(url.searchParams.get('t'))) {
        res.writeHead(401, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>StageCue remote</h1><p>This link is not valid any more. Scan the QR code in StageCue AV again.</p>');
        return;
      }
      res.writeHead(200, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src data:; base-uri 'none'; form-action 'none'"
      });
      res.end(REMOTE_PAGE_HTML);
      return;
    }
    res.writeHead(404, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://remote.local');
    const role = url.pathname === '/ws' ? this.roleFor(url.searchParams.get('t')) : null;
    if (!role) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Requests that came through the Cloudflare tunnel arrive from cloudflared on this machine.
    const forwarded = String(req.headers['cf-connecting-ip'] ?? '').trim();
    const via: 'lan' | 'internet' = forwarded ? 'internet' : 'lan';
    const address = forwarded ? `${forwarded} (internet)` : req.socket.remoteAddress ?? '';
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(wrapWebSocket(ws), role, address, via));
  }

  /* ------------------------------ WebSocket ------------------------------ */

  private send(socket: PeerSocket, message: unknown): void {
    if (socket.isOpen()) socket.send(JSON.stringify(message));
  }

  private broadcast(message: unknown, filter: (client: ClientState) => boolean = () => true): void {
    const payload = JSON.stringify(message);
    for (const [socket, client] of this.clients) {
      if (filter(client) && socket.isOpen()) socket.send(payload);
    }
  }

  private accessFor(role: RemoteRole): { permissions: StageTeamPermissions; locked: boolean } {
    return role === 'operator'
      ? { permissions: { takeCues: true, mediaControls: true, emergency: true, autoFollow: true }, locked: false }
      : { permissions: { ...this.permissions }, locked: this.locked };
  }

  private broadcastAccess(): void {
    for (const [socket, client] of this.clients) {
      if (client.role === 'stage') this.send(socket, { type: 'access', ...this.accessFor('stage') });
    }
  }

  private onConnection(socket: PeerSocket, role: RemoteRole, address: string, via: 'lan' | 'internet'): void {
    const now = Date.now();
    const client: ClientState = {
      id: randomUUID(),
      role,
      name: role === 'operator' ? 'AV phone' : 'Stage crew',
      address: address.replace(/^::ffff:/, ''),
      connectedAt: now,
      lastSeen: now,
      latencyMs: null,
      alive: true,
      recent: [],
      via
    };
    this.clients.set(socket, client);
    this.send(socket, { type: 'hello', clientId: client.id, role, ...this.accessFor(role) });
    if (this.status) this.send(socket, { type: 'status', status: this.status });
    this.send(socket, { type: 'cues', cues: this.cues });
    this.send(socket, { type: 'history', messages: this.history.filter((m) => m.to === null || m.to === client.id) });

    socket.onPong(() => {
      client.alive = true;
      client.lastSeen = Date.now();
    });
    socket.onMessage((text) => this.onMessage(socket, client, text));
    socket.onClose(() => {
      if (!this.clients.delete(socket)) return;
      this.notify();
    });
    this.notify();
  }

  private rateLimited(client: ClientState, now: number): boolean {
    client.recent = client.recent.filter((t) => now - t < RATE_WINDOW_MS);
    client.recent.push(now);
    return client.recent.length > RATE_MAX_MESSAGES;
  }

  private onMessage(socket: PeerSocket, client: ClientState, data: string): void {
    const now = Date.now();
    client.lastSeen = now;
    client.alive = true;
    if (this.rateLimited(client, now)) return;
    let message: ClientMessage;
    try {
      message = JSON.parse(data) as ClientMessage;
    } catch {
      return;
    }
    if (typeof message !== 'object' || message === null) return;

    switch (message.type) {
      case 'hello': {
        const name = sanitizeText(message.name, MAX_NAME);
        if (name) client.name = name;
        this.notify();
        return;
      }
      case 'ping':
        this.send(socket, { type: 'pong', t: typeof message.t === 'number' ? message.t : 0 });
        return;
      case 'latency': {
        const ms = typeof message.ms === 'number' && Number.isFinite(message.ms) ? Math.max(0, Math.round(message.ms)) : null;
        const changed = ms !== client.latencyMs;
        client.latencyMs = ms;
        if (changed) this.notify();
        return;
      }
      case 'action': {
        const requestId = sanitizeText(message.requestId, 64) || randomUUID();
        if (!isRemoteAction(message.action)) {
          this.send(socket, { type: 'ack', requestId, ok: false, message: 'Unknown command' });
          return;
        }
        const cueId = message.action === 'take-cue' ? sanitizeText(message.cueId, 100) : undefined;
        if (message.action === 'take-cue' && !cueId) {
          this.send(socket, { type: 'ack', requestId, ok: false, message: 'No cue selected' });
          return;
        }
        const allowed = checkPermission(client.role, this.permissions, this.locked, message.action);
        if (!allowed.ok) {
          this.send(socket, { type: 'ack', requestId, ok: false, message: allowed.reason });
          return;
        }
        const timer = setTimeout(() => {
          this.pendingAcks.delete(requestId);
          this.send(socket, { type: 'ack', requestId, ok: false, message: 'StageCue did not respond' });
        }, ACK_TIMEOUT_MS);
        this.pendingAcks.set(requestId, { socket, timer });
        this.options.onAction({
          requestId,
          action: message.action,
          cueId,
          clientId: client.id,
          clientName: client.name,
          role: client.role
        });
        return;
      }
      case 'message': {
        const kind: CrewMessageKind = (CREW_MESSAGE_KINDS as readonly string[]).includes(String(message.kind))
          ? (message.kind as CrewMessageKind)
          : 'custom';
        const text = sanitizeText(message.text, MAX_TEXT);
        if (!text) return;
        const crew: CrewMessage = {
          id: randomUUID(),
          kind,
          text,
          from: client.name,
          role: client.role,
          clientId: client.id,
          to: null,
          at: now
        };
        this.remember(crew);
        this.broadcast({ type: 'message', message: crew });
        this.options.onMessage(crew);
        return;
      }
      default:
        return;
    }
  }

  private remember(message: CrewMessage): void {
    this.history = [...this.history, message].slice(-MAX_HISTORY);
  }

  /* ---------------------------- From operator ---------------------------- */

  resolveAck(ack: RemoteAck): void {
    const pending = this.pendingAcks.get(ack.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(ack.requestId);
    this.send(pending.socket, { type: 'ack', requestId: ack.requestId, ok: ack.ok, message: sanitizeText(ack.message, MAX_TEXT) });
  }

  updateStatus(status: RemoteStatus): void {
    this.status = status;
    this.broadcast({ type: 'status', status });
  }

  updateCues(cues: RemoteCue[]): void {
    this.cues = cues;
    this.broadcast({ type: 'cues', cues });
  }

  /** A message typed in the AV room. Returns the stored message (null when empty). */
  sendCrewMessage(request: CrewMessageRequest): CrewMessage | null {
    const text = sanitizeText(request.text, MAX_TEXT);
    if (!text) return null;
    const kind: CrewMessageKind = (CREW_MESSAGE_KINDS as readonly string[]).includes(request.kind) ? request.kind : 'reply';
    const message: CrewMessage = {
      id: randomUUID(),
      kind,
      text,
      from: 'AV Room',
      role: 'av-room',
      clientId: null,
      to: typeof request.to === 'string' && request.to ? request.to : null,
      at: Date.now()
    };
    this.remember(message);
    this.broadcast({ type: 'message', message }, (client) => message.to === null || client.id === message.to);
    return message;
  }
}
