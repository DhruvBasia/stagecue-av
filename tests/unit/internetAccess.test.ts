import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { createRelayServer, type RelayServer } from '../../relay/server';
import {
  cloudflaredCandidates,
  findCloudflared,
  isValidRelayUrl,
  parseTunnelUrl,
  relayPublicBase,
  relayWsUrl
} from '../../src/main/internetAccess';
import { OFF_INTERNET, RemoteServer } from '../../src/main/remoteServer';
import {
  DEFAULT_STAGE_PERMISSIONS,
  type InternetConfig,
  type RemoteActionEvent,
  type RemoteConfigRequest,
  type RemoteInfo
} from '../../src/renderer/src/types';

const OPERATOR = 'a'.repeat(32);
const STAGE = 'b'.repeat(32);
const ROOM = 'annualday2026';
const SECRET = 'S'.repeat(40);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

async function startRelay(options: { hostKey?: string } = {}, port?: number): Promise<{ relay: RelayServer; url: string; port: number }> {
  const relay = createRelayServer(options);
  const listenPort = port ?? (await freePort());
  await new Promise<void>((resolve) => relay.listen(listenPort, '127.0.0.1', () => resolve()));
  cleanups.push(() => relay.closeRelay());
  return { relay, url: `http://127.0.0.1:${listenPort}`, port: listenPort };
}

async function waitFor<T>(read: () => T, check: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startLaptop(internet: InternetConfig, extra: Partial<ConstructorParameters<typeof RemoteServer>[0]> = {}) {
  const actions: RemoteActionEvent[] = [];
  let info: RemoteInfo | null = null;
  const server = new RemoteServer({
    host: '127.0.0.1',
    onAction: (event) => actions.push(event),
    onMessage: () => undefined,
    onInfoChange: (i) => {
      info = i;
    },
    ...extra
  });
  cleanups.push(() => server.stop());
  const port = await freePort();
  const request: RemoteConfigRequest = {
    enabled: true,
    port,
    operatorToken: OPERATOR,
    stageToken: STAGE,
    stagePermissions: DEFAULT_STAGE_PERMISSIONS,
    stageLocked: false,
    internet
  };
  info = await server.configure(request);
  return { server, actions, info: () => info as RemoteInfo, port };
}

interface Phone {
  ws: WebSocket;
  next: (type: string) => Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

function phone(url: string): Promise<Phone> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = [];
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data)) as Record<string, unknown>;
      const i = waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else queue.push(m);
    });
    const closed = new Promise<number>((done) => ws.addEventListener('close', (e) => done(e.code)));
    ws.addEventListener('error', () => reject(new Error('rejected')));
    ws.addEventListener('open', () =>
      resolve({
        ws,
        closed,
        next: (type) =>
          new Promise((done, fail) => {
            const i = queue.findIndex((m) => m.type === type);
            if (i >= 0) return done(queue.splice(i, 1)[0]);
            const timer = setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), 4000);
            waiters.push({ type, resolve: (m) => (clearTimeout(timer), done(m)) });
          })
      })
    );
    cleanups.push(() => ws.close());
  });
}

const relayConfig = (url: string, extra: Partial<InternetConfig> = {}): InternetConfig => ({
  mode: 'relay',
  relayUrl: url,
  roomId: ROOM,
  roomSecret: SECRET,
  relayHostKey: '',
  ...extra
});

describe('internet helpers', () => {
  it('builds relay addresses and recognises tunnel URLs', () => {
    expect(relayWsUrl('https://relay.example.com/', ROOM)).toBe(`wss://relay.example.com/host?room=${ROOM}`);
    expect(relayWsUrl('http://127.0.0.1:9000', ROOM)).toBe(`ws://127.0.0.1:9000/host?room=${ROOM}`);
    expect(relayPublicBase('wss://relay.example.com', ROOM)).toBe(`https://relay.example.com/r/${ROOM}`);
    expect(isValidRelayUrl('https://stagecue-relay.onrender.com')).toBe(true);
    expect(isValidRelayUrl('not a url')).toBe(false);
    expect(parseTunnelUrl('INF |  https://ripe-bold-otter-kinds.trycloudflare.com  |')).toBe('https://ripe-bold-otter-kinds.trycloudflare.com');
    expect(parseTunnelUrl('connecting…')).toBeNull();
  });

  it('looks for cloudflared where its installers put it', () => {
    const list = cloudflaredCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local', PATH: 'D:\\bin' });
    expect(list[0]).toBe('C:\\Users\\op\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe');
    expect(list).toContain('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
    expect(findCloudflared('linux', (p) => p === '/usr/local/bin/cloudflared')).toBe('/usr/local/bin/cloudflared');
  });
});

describe('relay mode: phones and laptop on different networks', () => {
  it('connects a phone to the laptop through the relay and carries commands both ways', async () => {
    const { url } = await startRelay();
    const laptop = await startLaptop(relayConfig(url));
    const info = await waitFor(laptop.info, (i) => i.internet.state === 'online');
    expect(info.internet.publicBase).toBe(`${url}/r/${ROOM}`);
    const stageLink = info.links.find((l) => l.role === 'stage' && l.scope === 'internet');
    expect(stageLink?.url).toBe(`${url}/r/${ROOM}/?t=${STAGE}`);
    expect(info.links[0].scope).toBe('internet');

    // The crew page is served by the relay (supplied by the laptop).
    const page = await fetch(`${url}/r/${ROOM}/?t=${STAGE}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('StageCue Crew');

    const crew = await phone(`ws://127.0.0.1:${new URL(url).port}/r/${ROOM}/ws?t=${STAGE}`);
    expect(await crew.next('hello')).toMatchObject({ role: 'stage' });
    crew.ws.send(JSON.stringify({ type: 'action', action: 'take-cue', cueId: 'c9', requestId: 'r1' }));
    await waitFor(() => laptop.actions.length, (n) => n === 1);
    expect(laptop.actions[0]).toMatchObject({ action: 'take-cue', cueId: 'c9', role: 'stage' });
    laptop.server.resolveAck({ requestId: 'r1', ok: true, message: 'Cue 9 is live' });
    expect(await crew.next('ack')).toMatchObject({ requestId: 'r1', ok: true });
    await waitFor(laptop.info, (i) => i.clients.some((c) => c.via === 'internet'));
  });

  it('refuses phones with a wrong link, without the relay knowing the codes', async () => {
    const { url } = await startRelay();
    const laptop = await startLaptop(relayConfig(url));
    await waitFor(laptop.info, (i) => i.internet.state === 'online');
    const intruder = await phone(`ws://127.0.0.1:${new URL(url).port}/r/${ROOM}/ws?t=${'c'.repeat(32)}`);
    expect(await intruder.closed).toBe(4001);
    expect(laptop.actions).toHaveLength(0);
  });

  it('tells phones when the laptop is offline and reconnects by itself when the relay comes back', async () => {
    const first = await startRelay();
    const laptop = await startLaptop(relayConfig(first.url));
    await waitFor(laptop.info, (i) => i.internet.state === 'online');
    const crew = await phone(`ws://127.0.0.1:${first.port}/r/${ROOM}/ws?t=${STAGE}`);
    await crew.next('hello');

    await first.relay.closeRelay();
    await waitFor(laptop.info, (i) => i.internet.state === 'reconnecting');
    expect(await crew.closed).not.toBe(4001);

    await startRelay({}, first.port);
    await waitFor(laptop.info, (i) => i.internet.state === 'online', 10_000);
    const again = await phone(`ws://127.0.0.1:${first.port}/r/${ROOM}/ws?t=${STAGE}`);
    expect(await again.next('hello')).toMatchObject({ role: 'stage' });
  }, 20_000);

  it('serves an offline page while no laptop is connected, and protects rooms and relays', async () => {
    const { url } = await startRelay({ hostKey: 'only-our-team' });
    const offline = await fetch(`${url}/r/${ROOM}/`);
    expect(offline.status).toBe(503);
    expect(await offline.text()).toContain('AV laptop is not connected');

    const noKey = await startLaptop(relayConfig(url));
    await waitFor(noKey.info, (i) => i.internet.state === 'error');
    expect(noKey.info().internet.error).toMatch(/refused/);

    const owner = await startLaptop(relayConfig(url, { relayHostKey: 'only-our-team' }));
    await waitFor(owner.info, (i) => i.internet.state === 'online');
    const thief = await startLaptop(relayConfig(url, { relayHostKey: 'only-our-team', roomSecret: 'T'.repeat(40) }));
    await waitFor(thief.info, (i) => i.internet.state === 'error');
    expect(owner.info().internet.state).toBe('online');
  }, 15_000);
});

describe('tunnel mode', () => {
  it('reports when cloudflared is missing', async () => {
    const laptop = await startLaptop({ ...OFF_INTERNET, mode: 'tunnel' }, { tunnelCommand: null });
    expect(laptop.info().internet).toMatchObject({ mode: 'tunnel', state: 'not-installed' });
  });

  it('publishes the trycloudflare address and marks tunnel visitors as internet', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stagecue-tunnel-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const fake = path.join(dir, 'fake-cloudflared.js');
    writeFileSync(
      fake,
      "setTimeout(() => process.stderr.write('INF | https://brave-quick-otter.trycloudflare.com |\\n'), 100); setInterval(() => {}, 1000);"
    );
    const laptop = await startLaptop({ ...OFF_INTERNET, mode: 'tunnel' }, { tunnelCommand: process.execPath, tunnelArgs: () => [fake] });
    const info = await waitFor(laptop.info, (i) => i.internet.state === 'online');
    expect(info.internet.publicBase).toBe('https://brave-quick-otter.trycloudflare.com');
    expect(info.links.find((l) => l.role === 'stage' && l.scope === 'internet')?.url).toBe(
      `https://brave-quick-otter.trycloudflare.com/?t=${STAGE}`
    );

    // cloudflared forwards visitors to the local server with their real address in cf-connecting-ip.
    const ws = new WsClient(`ws://127.0.0.1:${laptop.port}/ws?t=${STAGE}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
    cleanups.push(() => ws.close());
    await new Promise((resolve) => ws.once('open', resolve));
    const client = await waitFor(laptop.info, (i) => i.clients.length === 1);
    expect(client.clients[0]).toMatchObject({ via: 'internet', address: '203.0.113.9 (internet)' });

    await laptop.server.configure({
      enabled: false,
      port: laptop.port,
      stagePermissions: DEFAULT_STAGE_PERMISSIONS,
      stageLocked: false,
      internet: OFF_INTERNET
    });
    expect(laptop.info().internet.state).toBe('off');
  });
});
