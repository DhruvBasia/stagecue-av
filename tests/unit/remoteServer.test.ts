import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkPermission,
  isRemoteAction,
  lanAddresses,
  normalizePermissions,
  OFF_INTERNET,
  permissionFor,
  RemoteServer,
  sanitizeText,
  tokensMatch
} from '../../src/main/remoteServer';
import {
  DEFAULT_STAGE_PERMISSIONS,
  type CrewMessage,
  type RemoteActionEvent,
  type RemoteConfigRequest,
  type RemoteInfo,
  type RemoteStatus
} from '../../src/renderer/src/types';

const OPERATOR = 'a'.repeat(32);
const STAGE = 'b'.repeat(32);
const servers: RemoteServer[] = [];
const sockets: WebSocket[] = [];

interface Harness {
  server: RemoteServer;
  base: string;
  port: number;
  actions: RemoteActionEvent[];
  messages: CrewMessage[];
  infos: RemoteInfo[];
  config: (patch?: Partial<RemoteConfigRequest>) => Promise<RemoteInfo>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function start(): Promise<Harness> {
  const actions: RemoteActionEvent[] = [];
  const messages: CrewMessage[] = [];
  const infos: RemoteInfo[] = [];
  const server = new RemoteServer({
    host: '127.0.0.1',
    onAction: (event) => actions.push(event),
    onMessage: (message) => messages.push(message),
    onInfoChange: (info) => infos.push(info)
  });
  servers.push(server);
  const port = await freePort();
  const config = (patch: Partial<RemoteConfigRequest> = {}): Promise<RemoteInfo> =>
    server.configure({
      enabled: true,
      port,
      operatorToken: OPERATOR,
      stageToken: STAGE,
      stagePermissions: DEFAULT_STAGE_PERMISSIONS,
      stageLocked: false,
      internet: OFF_INTERNET,
      ...patch
    });
  const info = await config();
  expect(info.enabled).toBe(true);
  return { server, base: `http://127.0.0.1:${port}`, port, actions, messages, infos, config };
}

interface Client {
  ws: WebSocket;
  next: (type: string) => Promise<Record<string, unknown>>;
  send: (message: unknown) => void;
  closed: Promise<number>;
}

/** WebSocket client that queues messages so tests can await them by type. */
function connect(port: number, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${token}`);
    sockets.push(ws);
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const index = waiters.findIndex((w) => w.type === message.type);
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else queue.push(message);
    });
    const closed = new Promise<number>((done) => ws.addEventListener('close', (event) => done(event.code)));
    ws.addEventListener('open', () =>
      resolve({
        ws,
        send: (message) => ws.send(JSON.stringify(message)),
        closed,
        next: (type) =>
          new Promise((done, fail) => {
            const index = queue.findIndex((m) => m.type === type);
            if (index >= 0) {
              done(queue.splice(index, 1)[0]);
              return;
            }
            const timer = setTimeout(() => fail(new Error(`timed out waiting for "${type}"`)), 3000);
            waiters.push({
              type,
              resolve: (m) => {
                clearTimeout(timer);
                done(m);
              }
            });
          })
      })
    );
    ws.addEventListener('error', () => reject(new Error('websocket rejected')));
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const status: RemoteStatus = {
  showName: 'Annual Day',
  liveCue: 'Welcome',
  liveCueId: 'c1',
  nextCue: 'Kulgeet',
  nextCueId: 'c2',
  nextCueNumber: 2,
  isFrozen: false,
  isBlackout: false,
  videoPlaying: false,
  videoRemaining: null,
  musicName: 'Walk-in.mp3',
  musicPlaying: true,
  autoFollowEnabled: true,
  followCountdown: null,
  projector: 'projector',
  paging: { kind: 'pdf', page: 3, pageCount: 34 },
  timer: { running: true, remainingMs: 95_000, durationMs: 300_000, warnMs: 60_000, speaker: 'Dr. Kamal Pathak', message: null }
};

afterEach(async () => {
  sockets.splice(0).forEach((ws) => ws.close());
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe('remote helpers', () => {
  it('maps actions to stage-team permissions and enforces the lock', () => {
    expect(permissionFor('take-cue')).toBe('takeCues');
    expect(permissionFor('music-toggle')).toBe('mediaControls');
    expect(permissionFor('blackout')).toBe('emergency');
    expect(permissionFor('toggle-follow')).toBe('autoFollow');
    expect(checkPermission('stage', DEFAULT_STAGE_PERMISSIONS, false, 'take')).toEqual({ ok: true });
    expect(checkPermission('stage', DEFAULT_STAGE_PERMISSIONS, false, 'freeze')).toMatchObject({ ok: false });
    expect(checkPermission('stage', DEFAULT_STAGE_PERMISSIONS, true, 'take')).toMatchObject({ ok: false, reason: expect.stringMatching(/locked/) });
    expect(checkPermission('operator', DEFAULT_STAGE_PERMISSIONS, true, 'freeze')).toEqual({ ok: true });
  });

  it('cleans untrusted input', () => {
    expect(tokensMatch(OPERATOR, OPERATOR)).toBe(true);
    expect(tokensMatch(OPERATOR, STAGE)).toBe(false);
    expect(isRemoteAction('take-cue')).toBe(true);
    expect(isRemoteAction('rm -rf')).toBe(false);
    expect(sanitizeText('  Stage\nLeft\u0007  Rahul ', 32)).toBe('Stage Left Rahul');
    expect(sanitizeText(42, 10)).toBe('');
    expect(normalizePermissions({ emergency: true, takeCues: 'yes' })).toEqual({ ...DEFAULT_STAGE_PERMISSIONS, emergency: true });
  });

  it('lists the laptop hotspot first, then private networks', () => {
    const entry = (address: string) => ({ address, family: 'IPv4' as const, internal: false, netmask: '', mac: '', cidr: null });
    expect(
      lanAddresses({
        Ethernet: [entry('10.0.0.5')],
        'Wi-Fi': [entry('192.168.1.20')],
        'Local Area Connection* 10': [entry('192.168.137.1')],
        Tailscale: [entry('100.64.0.5')],
        Loopback: [{ ...entry('127.0.0.1'), internal: true }],
        APIPA: [entry('169.254.3.4')]
      }).map((a) => `${a.interfaceName}=${a.address}${a.hotspot ? ' (hotspot)' : ''}`)
    ).toEqual(['Local Area Connection* 10=192.168.137.1 (hotspot)', 'Ethernet=10.0.0.5', 'Wi-Fi=192.168.1.20', 'Tailscale=100.64.0.5']);
  });
});

describe('WebSocket crew remote', () => {
  it('serves the page only for valid links and refuses bad WebSocket tokens', async () => {
    const h = await start();
    expect((await fetch(`${h.base}/?t=wrong`)).status).toBe(401);
    const page = await fetch(`${h.base}/?t=${STAGE}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('StageCue Crew');
    expect(page.headers.get('content-security-policy')).toContain('connect-src');
    await expect(connect(h.port, 'c'.repeat(32))).rejects.toThrow();
    const info = h.server.getInfo();
    expect(info.links.map((l) => l.role).sort()).toEqual(['operator', 'stage']);
    expect(info.links.find((l) => l.role === 'stage')?.url).toContain(STAGE);
  });

  it('greets a stage device with its role, permissions, status, cues and message history', async () => {
    const h = await start();
    h.server.updateStatus(status);
    h.server.updateCues([{ id: 'c1', order: 1, label: 'Welcome', kind: 'backdrop', thumb: null, detail: 'Poster', notes: null, follow: null }]);
    const stage = await connect(h.port, STAGE);
    expect(await stage.next('hello')).toMatchObject({ role: 'stage', permissions: DEFAULT_STAGE_PERMISSIONS, locked: false });
    expect(((await stage.next('status')).status as RemoteStatus).liveCue).toBe('Welcome');
    expect(((await stage.next('cues')).cues as unknown[]).length).toBe(1);
    expect(await stage.next('history')).toMatchObject({ messages: [] });

    stage.send({ type: 'hello', name: 'Stage Left – Rahul' });
    await waitFor(() => h.server.getInfo().clients.some((c) => c.name === 'Stage Left – Rahul' && c.role === 'stage'));

    stage.send({ type: 'ping', t: 12345 });
    expect(await stage.next('pong')).toMatchObject({ t: 12345 });

    h.server.updateStatus({ ...status, liveCue: 'Kulgeet' });
    expect(((await stage.next('status')).status as RemoteStatus).liveCue).toBe('Kulgeet');
  });

  it('forwards permitted commands to the operator and returns the acknowledgement', async () => {
    const h = await start();
    const stage = await connect(h.port, STAGE);
    await stage.next('hello');
    stage.send({ type: 'action', action: 'take-cue', cueId: 'c7', requestId: 'r1' });
    await waitFor(() => h.actions.length === 1);
    expect(h.actions[0]).toMatchObject({ action: 'take-cue', cueId: 'c7', requestId: 'r1', role: 'stage' });
    h.server.resolveAck({ requestId: 'r1', ok: true, message: 'Cue 7 is live' });
    expect(await stage.next('ack')).toEqual({ type: 'ack', requestId: 'r1', ok: true, message: 'Cue 7 is live' });
  });

  it('refuses stage-team commands that are not allowed, and everything while locked', async () => {
    const h = await start();
    const stage = await connect(h.port, STAGE);
    await stage.next('hello');
    stage.send({ type: 'action', action: 'blackout', requestId: 'r2' });
    expect(await stage.next('ack')).toMatchObject({ requestId: 'r2', ok: false, message: 'Not allowed for the stage team' });

    await h.config({ stageLocked: true });
    expect(await stage.next('access')).toMatchObject({ locked: true });
    stage.send({ type: 'action', action: 'take', requestId: 'r3' });
    expect(await stage.next('ack')).toMatchObject({ requestId: 'r3', ok: false, message: 'Controls are locked by the AV room' });

    // The AV room's own phone is never locked.
    const operator = await connect(h.port, OPERATOR);
    expect(await operator.next('hello')).toMatchObject({ role: 'operator', locked: false });
    operator.send({ type: 'action', action: 'blackout', requestId: 'r4' });
    await waitFor(() => h.actions.some((a) => a.requestId === 'r4'));
    expect(h.actions.map((a) => a.requestId)).toEqual(['r4']);
  });

  it('relays crew messages both ways, including private replies', async () => {
    const h = await start();
    const left = await connect(h.port, STAGE);
    const right = await connect(h.port, STAGE);
    const leftHello = await left.next('hello');
    await right.next('hello');

    left.send({ type: 'message', kind: 'guest-arrived', text: 'Chief guest has arrived <script>' });
    await waitFor(() => h.messages.length === 1);
    expect(h.messages[0]).toMatchObject({ kind: 'guest-arrived', role: 'stage', text: 'Chief guest has arrived <script>' });
    expect((await right.next('message')).message).toMatchObject({ kind: 'guest-arrived' });
    await left.next('message');

    h.server.sendCrewMessage({ kind: 'reply', text: 'Copy, rolling the anthem', to: String(leftHello.clientId) });
    expect((await left.next('message')).message).toMatchObject({ from: 'AV Room', role: 'av-room', text: 'Copy, rolling the anthem' });
    await expect(right.next('message')).rejects.toThrow(/timed out/);

    const late = await connect(h.port, STAGE);
    const history = (await late.next('history')).messages as CrewMessage[];
    expect(history.map((m) => m.text)).toEqual(['Chief guest has arrived <script>']);
  });

  it('drops phones holding a revoked link', async () => {
    const h = await start();
    const stage = await connect(h.port, STAGE);
    await stage.next('hello');
    const info = await h.config({ regenerate: true });
    expect(await stage.closed).toBe(4001);
    expect(info.stageToken).not.toBe(STAGE);
    await expect(connect(h.port, STAGE)).rejects.toThrow();
    const fresh = await connect(h.port, info.stageToken);
    expect(await fresh.next('hello')).toMatchObject({ role: 'stage' });
  });

  it('reports a busy port instead of crashing and stops cleanly', async () => {
    const h = await start();
    const second = new RemoteServer({ host: '127.0.0.1', onAction: () => undefined, onMessage: () => undefined });
    servers.push(second);
    const info = await second.configure({
      enabled: true,
      port: h.port,
      stagePermissions: DEFAULT_STAGE_PERMISSIONS,
      stageLocked: false,
      internet: OFF_INTERNET
    });
    expect(info.enabled).toBe(false);
    expect(info.error).toMatch(/already in use/);
    const off = await h.config({ enabled: false });
    expect(off.enabled).toBe(false);
    await expect(fetch(`${h.base}/?t=${STAGE}`)).rejects.toThrow();
  });
});
