// server/index.js
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { WebSocketServer } from 'ws';
import { Logger } from './logger.js';
import { RoomManager } from './rooms.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3000;

const logger = new Logger({ capacity: 2000 });
const rooms = new RoomManager(logger);

const server = http.createServer((req, res) => {
  const { url: reqUrl } = req;

  // SSE: /admin/logs/stream
  if (reqUrl === '/admin/logs/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const unsubscribe = logger.sseSubscribe(res);
    req.on('close', () => unsubscribe());
    return;
  }

  // 静的配信: client/ と server/public/
  const serveStatic = (filePath) => {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404); res.end('Not found');
      } else {
        const ext = path.extname(filePath).toLowerCase();
        const ct = ext === '.html' ? 'text/html; charset=utf-8'
          : ext === '.js' ? 'text/javascript; charset=utf-8'
          : ext === '.css' ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
      }
    });
  };

  let filePath = null;
  if (reqUrl === '/' || reqUrl.startsWith('/client')) {
    filePath = reqUrl === '/' ? path.join(ROOT, 'client', 'index.html')
                              : path.join(ROOT, reqUrl);
  } else if (reqUrl.startsWith('/admin')) {
    // /admin/logs -> server/public/admin/logs.html
    let rel = reqUrl === '/admin/logs' ? 'logs.html' : reqUrl.replace(/^\/admin\//, '');
    const filePath = path.join(ROOT, 'server', 'public', 'admin', rel);
    return serveStatic(filePath);
  } else {
    const filePath = path.join(ROOT, 'client', reqUrl);
    return serveStatic(filePath);
  }
  serveStatic(filePath);
});

// WebSocket シグナリング
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  logger.info({ event: 'ws-open' });

  ws.on('message', (buf) => {
    let msg = {};
    try { msg = JSON.parse(buf.toString()); } catch (_) { return; }

    if (msg.type === 'join') {
      const { roomId } = msg;
      const peerId = rooms.join(ws, roomId);
      if (peerId) logger.info({ roomId, peerId, event: 'join' });
      return;
    }

    // 中継対象: offer/answer/ice, nack, slider, dc-status など
    if (['signal', 'nack', 'slider', 'dc-status'].includes(msg.type)) {
      const roomId = ws._roomId; const peerId = ws._peerId;
      logger.info({ roomId, peerId, event: `relay:${msg.type}`, detail: { kind: msg?.data?.kind } });
      rooms.relay(ws, msg);
      return;
    }
  });

  ws.on('close', () => logger.info({ event: 'ws-close' }));
});

server.listen(PORT, () => {
  logger.info({ event: 'server-start', detail: { port: PORT } });
  console.log(`\nBit Messenger server running: http://localhost:${PORT}\n`);
});
