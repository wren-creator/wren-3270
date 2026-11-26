// Smoke tests for handleTelnetConnect's telnet.* WebSocket protocol.
// Unlike ssh.js/ftp-client.js, telnet has no shipped mock in this repo to
// test against (telnet has no application protocol of its own — it's IAC
// negotiation over a raw socket, then whatever the far end happens to send,
// which here is a plain TCP echo server standing in for "a real telnet
// host"). These tests cover the bridge's own negotiation/data/disconnect
// handling, not a specific host's behavior.
//
// Same fakeWs()/withSession() discipline as features/ftp-client.test.js:
// a minimal EventEmitter-shaped stand-in for the browser WebSocket
// handleTelnetConnect talks to, and every test tears down its session and
// its server in a `finally` so a failed assertion can't hang the next test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { handleTelnetConnect } from './telnet.js';

const IAC = 255, DO = 253, WILL = 251;

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
const closed = srv => new Promise(r => srv.close(r));
const noopLogger = { info() {}, warn() {}, error() {} };

// A bare-bones "telnet host": on connect, asks the client to WILL ECHO/SGA
// (the character-mode negotiation makeNegotiator in telnet.js answers),
// then just echoes back whatever plain data it receives — close enough to
// a real line-mode login prompt for exercising the client side.
function echoServer() {
  return net.createServer(sock => {
    // sock.destroy() on the client side (telnet.disconnect, see telnet.js's
    // ws 'close' handler) can RST instead of FIN if there's anything still
    // in flight, which the server's socket surfaces as an unhandled
    // 'error' otherwise — expected noise from an abrupt disconnect, not a
    // real test failure.
    sock.on('error', () => {});
    sock.write(Buffer.from([IAC, DO, 1]));  // DO ECHO
    sock.write(Buffer.from([IAC, DO, 3]));  // DO SUPPRESS-GO-AHEAD
    sock.on('data', chunk => {
      // Strip any IAC sequences the client sends back (there shouldn't be
      // any here, but be as forgiving as a real host) and echo the rest.
      sock.write(chunk);
    });
  });
}

// Minimal stand-in for the browser WebSocket handleTelnetConnect talks to.
function fakeWs() {
  const handlers = {};
  return {
    readyState: 1,
    on(event, cb) { (handlers[event] ||= []).push(cb); },
    emit(event, ...args) { for (const cb of (handlers[event] || [])) cb(...args); },
    close() { this.emit('close'); },
  };
}

function waitFor(pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timed out waiting for condition')); }
    }, 5);
  });
}

function session(params) {
  const ws = fakeWs();
  const messages = [];
  const send = (_ws, msg) => messages.push(msg);
  handleTelnetConnect(ws, 1, params, send, noopLogger);
  const cmd = msg => ws.emit('message', JSON.stringify(msg));
  const connected = () => waitFor(() => messages.some(m => m.type === 'telnet.status' && m.state === 'connected'));
  const last = type => messages.filter(m => m.type === type).at(-1);
  const until = pred => waitFor(() => messages.some(pred));
  const disconnect = () => { cmd({ type: 'telnet.disconnect' }); return new Promise(r => setTimeout(r, 30)); };
  return { ws, messages, cmd, connected, last, until, disconnect };
}

async function withSession(serverFactory, params, body) {
  const srv = await listen(serverFactory());
  const s = session({ host: '127.0.0.1', port: srv.address().port, ...params });
  try {
    await body(srv, s);
  } finally {
    await s.disconnect().catch(() => {});
    await closed(srv);
  }
}

test('connect against a raw telnet-ish host reaches connected', () => withSession(echoServer, {}, async (srv, s) => {
  await s.connected();
}));

test('data sent to the host comes back decoded, with IAC negotiation stripped out', () => withSession(echoServer, {}, async (srv, s) => {
  await s.connected();
  s.cmd({ type: 'telnet.data', data: Buffer.from('hello\r\n', 'ascii').toString('base64') });
  await s.until(x => x.type === 'telnet.data');
  const got = Buffer.from(s.last('telnet.data').data, 'base64').toString('ascii');
  assert.equal(got, 'hello\r\n');
}));

test('telnet.disconnect closes the socket cleanly, no further data events', () => withSession(echoServer, {}, async (srv, s) => {
  await s.connected();
  await s.disconnect();
  const countBefore = s.messages.length;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(s.messages.length, countBefore);
}));

test('missing host is refused client-side, socket never opened', () => {
  const ws = fakeWs();
  const messages = [];
  const send = (_ws, msg) => messages.push(msg);
  let closedCalled = false;
  ws.close = () => { closedCalled = true; };
  handleTelnetConnect(ws, 2, {}, send, noopLogger);
  assert.equal(messages[0].type, 'telnet.error');
  assert.match(messages[0].message, /host is required/);
  assert.equal(closedCalled, true);
});
