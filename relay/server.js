'use strict';

/* =========================================================================
 * StageCue relay: lets crew phones reach the AV laptop from ANY network
 * (venue Wi-Fi, a different Wi-Fi, mobile data) over WebSockets.
 *
 *   laptop  ──wss──▶  relay  ◀──wss──  phones
 *
 * Both sides connect OUT to the relay, so it works even when the laptop is
 * on mobile data behind carrier NAT. The relay is a dumb pipe: it never
 * decides who may control the show. Every phone's secret link token is
 * forwarded to the laptop, which accepts or refuses it.
 *
 * Endpoints
 *   GET  /healthz                     → "ok"
 *   GET  /r/<room>/                   → crew page (supplied by the laptop)
 *   WS   /host?room=<room>            → the laptop (header x-stagecue-secret)
 *   WS   /r/<room>/ws?t=<token>       → a phone
 *
 * Environment
 *   PORT             listening port (default 8080)
 *   RELAY_HOST_KEY   optional: laptops must also send x-stagecue-host-key,
 *                    so strangers cannot use your relay for their own rooms
 * ========================================================================= */

const crypto = require('node:crypto');
const http = require('node:http');
const { WebSocket, WebSocketServer } = require('ws');

const ROOM_PATTERN = /^[a-z0-9]{8,32}$/;
const MAX_ROOMS = 200;
const MAX_PHONES_PER_ROOM = 60;
const MAX_PAYLOAD = 64 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const OFFLINE_PAGE =
  '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5">' +
  '<body style="background:#0d1117;color:#e6edf3;font-family:system-ui;padding:24px"><h2>StageCue</h2>' +
  '<p>The AV laptop is not connected right now. This page retries every few seconds.</p></body>';

function createRelayServer(options = {}) {
  const hostKey = options.hostKey ?? process.env.RELAY_HOST_KEY ?? '';
  /** @type {Map<string, {secretHash: string, host: WebSocket | null, page: string | null, phones: Map<number, WebSocket>, nextId: number, lastSeen: number}>} */
  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  const send = (ws, message) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://relay');
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (url.pathname === '/healthz') {
      res.writeHead(200, { ...base, 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    const match = /^\/r\/([a-z0-9]+)\/?$/.exec(url.pathname);
    if (match && req.method === 'GET') {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { ...base, Location: `${url.pathname}/${url.search}` });
        res.end();
        return;
      }
      const room = rooms.get(match[1]);
      if (!room || !room.host || !room.page) {
        res.writeHead(503, { ...base, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(OFFLINE_PAGE);
        return;
      }
      res.writeHead(200, {
        ...base,
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; img-src data:; base-uri 'none'; form-action 'none'"
      });
      res.end(room.page);
      return;
    }
    res.writeHead(404, { ...base, 'Content-Type': 'text/plain' });
    res.end('StageCue relay');
  });

  const reject = (socket, status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://relay');

    // --- the AV laptop ---------------------------------------------------
    if (url.pathname === '/host') {
      const roomId = url.searchParams.get('room') || '';
      const secret = String(req.headers['x-stagecue-secret'] || '');
      if (!ROOM_PATTERN.test(roomId) || secret.length < 16) return reject(socket, 400, 'Bad Request');
      if (hostKey && !safeEqual(req.headers['x-stagecue-host-key'] || '', hostKey)) return reject(socket, 403, 'Forbidden');
      let room = rooms.get(roomId);
      if (room && room.secretHash !== sha256(secret)) return reject(socket, 403, 'Forbidden');
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return reject(socket, 503, 'Service Unavailable');
        room = { secretHash: sha256(secret), host: null, page: null, phones: new Map(), nextId: 1, lastSeen: Date.now() };
        rooms.set(roomId, room);
      }
      wss.handleUpgrade(req, socket, head, (ws) => attachHost(roomId, room, ws));
      return;
    }

    // --- a phone ----------------------------------------------------------
    const phone = /^\/r\/([a-z0-9]+)\/ws$/.exec(url.pathname);
    if (phone) {
      const room = rooms.get(phone[1]);
      const token = url.searchParams.get('t') || '';
      if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) return reject(socket, 503, 'Service Unavailable');
      if (!/^[a-f0-9]{24,64}$/.test(token)) return reject(socket, 401, 'Unauthorized');
      if (room.phones.size >= MAX_PHONES_PER_ROOM) return reject(socket, 503, 'Service Unavailable');
      wss.handleUpgrade(req, socket, head, (ws) => attachPhone(room, ws, token, clientAddress(req)));
      return;
    }
    reject(socket, 404, 'Not Found');
  });

  function attachHost(roomId, room, ws) {
    if (room.host && room.host !== ws) room.host.close(4000, 'Replaced by a new connection');
    for (const phoneWs of room.phones.values()) phoneWs.close(1012, 'AV laptop reconnected');
    room.phones.clear();
    room.host = ws;
    room.lastSeen = Date.now();
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      room.lastSeen = Date.now();
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'page' && typeof message.html === 'string' && message.html.length <= MAX_PAGE_BYTES) {
        room.page = message.html;
        send(ws, { type: 'ready', room: roomId });
      } else if (message.type === 'data' && typeof message.data === 'string') {
        const target = room.phones.get(message.cid);
        if (target && target.readyState === WebSocket.OPEN) target.send(message.data);
      } else if (message.type === 'close') {
        const target = room.phones.get(message.cid);
        if (target) {
          room.phones.delete(message.cid);
          const code = Number.isInteger(message.code) && message.code >= 4000 && message.code < 5000 ? message.code : 1000;
          target.close(code, String(message.reason || '').slice(0, 100));
        }
      }
    });
    ws.on('close', () => {
      if (room.host !== ws) return;
      room.host = null;
      for (const phoneWs of room.phones.values()) phoneWs.close(1013, 'AV laptop offline');
      room.phones.clear();
    });
    ws.on('error', () => ws.terminate());
  }

  function attachPhone(room, ws, token, address) {
    const cid = room.nextId++;
    room.phones.set(cid, ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    send(room.host, { type: 'open', cid, token, address });
    ws.on('message', (raw) => {
      ws.isAlive = true;
      const data = raw.toString();
      if (data.length <= MAX_PAYLOAD) send(room.host, { type: 'data', cid, data });
    });
    ws.on('close', () => {
      if (room.phones.get(cid) === ws) {
        room.phones.delete(cid);
        send(room.host, { type: 'close', cid });
      }
    });
    ws.on('error', () => ws.terminate());
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    // Forget rooms whose laptop has been gone for a day.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, room] of rooms) if (!room.host && room.lastSeen < cutoff) rooms.delete(id);
  }, HEARTBEAT_MS);
  server.on('close', () => clearInterval(heartbeat));
  server.closeRelay = () =>
    new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return server;
}

module.exports = { createRelayServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createRelayServer().listen(port, () => {
    console.log(`StageCue relay listening on :${port} (host key ${process.env.RELAY_HOST_KEY ? 'required' : 'not set'})`);
  });
}
