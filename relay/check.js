'use strict';

/* =========================================================================
 * Checks a deployed StageCue relay end to end, from wherever you run it.
 *
 *   node relay/check.js https://your-relay.onrender.com
 *
 * Without a host key it checks health, the offline page and that strangers
 * are refused. To also run a full laptop ⇄ relay ⇄ phone round trip, put the
 * relay's host key in an environment variable (it is never printed):
 *
 *   PowerShell:  $env:STAGECUE_RELAY_HOST_KEY = "<key>"; node relay/check.js <url>
 *   bash:        STAGECUE_RELAY_HOST_KEY=<key> node relay/check.js <url>
 *
 * Exits 0 when every check passes, 1 otherwise. A free Render instance that
 * is asleep can take ~60 s to answer the first request.
 * ========================================================================= */

const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const input = process.argv[2] || process.env.STAGECUE_RELAY_URL || '';
const hostKey = process.env.STAGECUE_RELAY_HOST_KEY || '';
let failures = 0;

function report(ok, label, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
}

function upgradeOutcome(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 90_000 });
    ws.on('unexpected-response', (_req, res) => {
      ws.terminate(); // a refused upgrade is not closed for us; behind a proxy it would linger
      resolve({ status: res.statusCode });
    });
    ws.on('open', () => {
      ws.close();
      resolve({ status: 101 });
    });
    ws.on('error', (error) => resolve({ status: 0, error: error.message }));
  });
}

function nextMessage(ws, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        message = raw.toString();
      }
      if (predicate(message)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      }
    };
    ws.on('message', onMessage);
  });
}

function opened(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => {
      ws.terminate();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.once('error', reject);
  });
}

async function main() {
  let base;
  try {
    base = new URL(input);
  } catch {
    console.error('Usage: node relay/check.js https://your-relay.example.com');
    process.exit(2);
  }
  const http = base.origin;
  const ws = http.replace(/^http/, 'ws');
  const room = `check${crypto.randomBytes(5).toString('hex')}`;
  const secret = crypto.randomBytes(24).toString('hex');
  console.log(`Checking ${http}${hostKey ? ' with host key' : ''}…`);

  const started = Date.now();
  const health = await fetch(`${http}/healthz`, { signal: AbortSignal.timeout(120_000) }).catch((e) => ({ status: 0, text: async () => e.message }));
  report(health.status === 200 && (await health.text()) === 'ok', 'relay is up (/healthz)', `${health.status}, ${Date.now() - started} ms`);
  if (health.status !== 200) return;

  const offline = await fetch(`${http}/r/${room}/`);
  report(offline.status === 503 && (await offline.text()).includes('AV laptop is not connected'), 'crew page explains when no laptop is connected', String(offline.status));

  const phoneEarly = await upgradeOutcome(`${ws}/r/${room}/ws?t=${'b'.repeat(32)}`, {});
  report(phoneEarly.status === 503, 'phones are turned away while the laptop is offline', String(phoneEarly.status));

  const noKey = await upgradeOutcome(`${ws}/host?room=${room}x`, { 'x-stagecue-secret': secret });
  if (noKey.status === 403) report(true, 'laptops without the host key are refused');
  else console.log(`WARN  relay accepts any laptop (${noKey.status}); set RELAY_HOST_KEY on the server so strangers cannot use it`);

  if (!hostKey) {
    console.log('SKIP  full round trip: set STAGECUE_RELAY_HOST_KEY to run it');
    return;
  }

  // Act as the AV laptop.
  const laptop = new WebSocket(`${ws}/host?room=${room}`, { headers: { 'x-stagecue-secret': secret, 'x-stagecue-host-key': hostKey } });
  try {
    await opened(laptop);
  } catch (error) {
    report(false, 'laptop connects with the host key', error.message);
    return;
  }
  laptop.send(JSON.stringify({ type: 'page', html: '<!doctype html><title>StageCue Crew</title><p>relay check</p>' }));
  const ready = await nextMessage(laptop, (m) => m && m.type === 'ready').catch(() => null);
  report(Boolean(ready), 'laptop connects with the host key and opens a room');

  const page = await fetch(`${http}/r/${room}/`);
  report(page.status === 200 && (await page.text()).includes('relay check'), 'crew page is served through the relay', String(page.status));

  const thief = await upgradeOutcome(`${ws}/host?room=${room}`, { 'x-stagecue-secret': 'z'.repeat(48), 'x-stagecue-host-key': hostKey });
  report(thief.status === 403, 'another laptop cannot take over the room', String(thief.status));

  // A phone joins; the laptop sees it, accepts it and they talk both ways.
  const token = crypto.randomBytes(16).toString('hex');
  const openEvent = nextMessage(laptop, (m) => m && m.type === 'open');
  const phone = new WebSocket(`${ws}/r/${room}/ws?t=${token}`);
  await opened(phone);
  const joined = await openEvent;
  report(joined.token === token, 'phone reaches the laptop with its link token');

  const hello = nextMessage(phone, (m) => m && m.type === 'hello');
  laptop.send(JSON.stringify({ type: 'data', cid: joined.cid, data: JSON.stringify({ type: 'hello', role: 'stage' }) }));
  report(Boolean(await hello.catch(() => null)), 'laptop → phone message delivered');

  const sentAt = Date.now();
  const action = nextMessage(laptop, (m) => m && m.type === 'data' && m.cid === joined.cid);
  phone.send(JSON.stringify({ type: 'action', action: 'take', requestId: 'check' }));
  const got = await action.catch(() => null);
  report(Boolean(got) && JSON.parse(got.data).requestId === 'check', 'phone → laptop command delivered', `${Date.now() - sentAt} ms`);

  // The laptop refuses a wrong link; the relay must pass that on.
  const intruderOpen = nextMessage(laptop, (m) => m && m.type === 'open' && m.cid !== joined.cid);
  const intruder = new WebSocket(`${ws}/r/${room}/ws?t=${'0'.repeat(32)}`);
  await opened(intruder);
  const intruderEvent = await intruderOpen;
  const refused = new Promise((resolve) => intruder.once('close', (code) => resolve(code)));
  laptop.send(JSON.stringify({ type: 'close', cid: intruderEvent.cid, code: 4001, reason: 'Invalid link' }));
  report((await refused) === 4001, 'a wrong link is refused by the laptop through the relay');

  // Laptop drops: phones are told it is offline.
  const dropped = new Promise((resolve) => phone.once('close', (code) => resolve(code)));
  laptop.close();
  report((await dropped) === 1013, 'phones are told when the laptop goes offline');
}

main()
  .catch((error) => report(false, 'unexpected error', error.message))
  .finally(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    // Let Node exit on its own once sockets close; process.exit() can abort on Windows with fetch handles open.
    process.exitCode = failures === 0 ? 0 : 1;
  });
