'use strict';
// Velixir xray node: Node.js front door on $PORT, xray behind it.
//   GET /health            -> 200 once xray is up (Velixir health-probe target), else 503
//   GET /                 -> 200 plain-text banner
//   ANY request to WS_PATH -> proxied to xray. A plain GET gets xray's 400,
//                            which is the liveness signal: 400 = xray alive.
//   WebSocket upgrade on WS_PATH -> raw TCP forward to xray.
// TLS is terminated by the Velixir edge; xray itself runs plain VLESS+WS.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ensureXray } = require('./fetch-xray');

const PORT = parseInt(process.env.PORT || '8080', 10);
const XRAY_PORT = parseInt(process.env.XRAY_PORT || '10000', 10);
const WS_PATH = process.env.WS_PATH || '/xray-ws';

let UUID = process.env.UUID || '';
if (!UUID) {
  UUID = crypto.randomUUID();
  console.log('[server] WARNING: UUID env not set, generated random UUID (use this for the client): ' + UUID);
} else {
  console.log('[server] UUID loaded from environment');
}
console.log('[server] WS_PATH=' + WS_PATH);

const CONFIG_PATH = path.join(__dirname, 'config.json');
let xrayReady = false;
let xrayProc = null;

function writeConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      port: XRAY_PORT,
      listen: '127.0.0.1',
      protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: { network: 'ws', wsSettings: { path: WS_PATH } },
    }],
    outbounds: [{ protocol: 'freedom' }],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

function waitXray(timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(XRAY_PORT, '127.0.0.1');
      s.once('connect', () => { s.end(); resolve(); });
      s.once('error', () => {
        if (Date.now() - start > timeoutMs) {
          return reject(new Error('xray did not start listening in time'));
        }
        setTimeout(tick, 500);
      });
    };
    tick();
  });
}

function safePathname(rawUrl) {
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

async function main() {
  await ensureXray();
  writeConfig();
  console.log(`[server] starting xray (vless+ws, path=${WS_PATH}, internal port=${XRAY_PORT})`);
  xrayProc = spawn(path.join(__dirname, 'xray'), ['run', '-c', CONFIG_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  xrayProc.stdout.on('data', (d) => process.stdout.write('[xray] ' + d));
  xrayProc.stderr.on('data', (d) => process.stderr.write('[xray] ' + d));
  xrayProc.on('exit', (code, sig) => {
    console.error(`[server] xray exited code=${code} sig=${sig}; shutting down`);
    xrayReady = false;
    process.exit(1);
  });

  try {
    await waitXray();
    xrayReady = true;
    console.log('[server] xray is listening, ready');
  } catch (e) {
    console.error('[server] ' + e.message);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const pathname = safePathname(req.url);
    if (pathname === '/health') {
      res.writeHead(xrayReady ? 200 : 503, { 'Content-Type': 'text/plain' });
      return res.end(xrayReady ? 'ok\n' : 'starting\n');
    }
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('xray node running\n');
    }
    if (pathname === WS_PATH) {
      if (!xrayReady) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('xray not ready\n');
      }
      // Proxy plain HTTP to xray (e.g. GET -> xray answers 400 = alive).
      const proxy = http.request(
        {
          host: '127.0.0.1',
          port: XRAY_PORT,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: `127.0.0.1:${XRAY_PORT}` },
        },
        (upRes) => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.pipe(res);
        },
      );
      proxy.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('bad gateway\n');
      });
      req.pipe(proxy);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = safePathname(req.url);
    if (pathname !== WS_PATH || !xrayReady) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const onErr = () => {
      try { socket.destroy(); } catch { /* ignore */ }
      try { upstream.destroy(); } catch { /* ignore */ }
    };
    upstream.on('error', onErr);
    socket.on('error', onErr);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on 0.0.0.0:${PORT} (health: /health, ws: ${WS_PATH})`);
  });
}

process.on('SIGTERM', () => {
  if (xrayProc) xrayProc.kill('SIGTERM');
  process.exit(0);
});

main().catch((e) => {
  console.error('[server] fatal: ' + (e && e.message));
  process.exit(1);
});
