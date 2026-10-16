'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

// First byte of a TLS handshake record is the ContentType "handshake" (22).
const TLS_HANDSHAKE = 0x16;

/**
 * Builds a plain-HTTP 301 to the same URL over HTTPS.
 *
 * This exists so that typing an address *without* the scheme still works:
 * browsers assume "http://" first, and a TLS-only port would just drop the
 * connection (that is what Chrome reports as ERR_EMPTY_RESPONSE).
 */
function redirectToHttps(req, res, fallbackPort) {
  const hostHeader = (req.headers.host || '').trim();
  const host = hostHeader || `localhost:${fallbackPort}`;
  const target = `https://${host}${req.url || '/'}`;
  const body =
    `<!doctype html><meta charset="utf-8"><title>Use HTTPS</title>` +
    `<p>This address must be opened over HTTPS.</p>` +
    `<p><a href="${target}">${target}</a></p>`;
  res.writeHead(301, {
    Location: target,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * One TCP port that serves HTTPS *and* plain HTTP.
 *
 * The first bytes on every connection decide:
 *   - TLS ClientHello  -> handed to `httpsServer` (real HTTPS)
 *   - anything else    -> handed to `httpServer`, which replies with a
 *                         redirect to the HTTPS URL
 *
 * Without this, a phone that opens "192.168.1.38:8443" fails with
 * ERR_EMPTY_RESPONSE because the browser tried http:// first.
 */
function createSniffingServer({ tlsOptions, httpsListener, httpListener, redirectPort }) {
  const httpsServer = https.createServer(tlsOptions, httpsListener);
  const httpServer = http.createServer(
    httpListener || ((req, res) => redirectToHttps(req, res, redirectPort))
  );

  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    // Idle connections that never send a byte (port scans, health checks).
    socket.setTimeout(30000, () => socket.destroy());

    socket.once('data', (chunk) => {
      socket.pause();
      const isTls = chunk.length > 0 && chunk[0] === TLS_HANDSHAKE;
      try {
        (isTls ? httpsServer : httpServer).emit('connection', socket);
      } catch {
        socket.destroy();
        return;
      }
      socket.unshift(chunk);
      socket.resume();
    });
  });

  // 'error' events stay on `server` (the listening socket) so the caller can
  // report a friendly message for EADDRINUSE instead of a stack trace.

  // Keep the wrapped servers usable for upgrade events / keep-alive tuning.
  httpsServer.keepAliveTimeout = 65000;
  httpsServer.httpServer = httpServer;

  function close() {
    const done = () => {};
    try { server.close(done); } catch { /* ignore */ }
    try { httpsServer.close(done); } catch { /* ignore */ }
    try { httpServer.close(done); } catch { /* ignore */ }
  }

  return { server, httpsServer, httpServer, close };
}

module.exports = { createSniffingServer, redirectToHttps, TLS_HANDSHAKE };
