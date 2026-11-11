// End-to-end tests: handleFtpConnect's ftp.* WebSocket protocol against the
// real mock-as400-ftp.js mock, same "test the actual wire conversation"
// discipline features/ftp-audit.test.js uses. (This repo ships no z/OS-side
// FTP mock — mock-lpar.js here is TN3270-only — so every test below runs
// against the one real FTP mock this repo has, rather than against a stub.)
//
// handleFtpConnect talks to a browser WebSocket, not a plain async
// function, so these tests drive it through a minimal fake `ws` (an
// EventEmitter-shaped stand-in with on/close) and capture everything
// `send(ws, msg)` would have sent back, the same shape the real public/js
// client speaks.
//
// Every test closes its session and its mock server in a `finally` —
// net.Server#close()'s callback waits for every open connection to end, so
// a session left open by an assertion throwing partway through would hang
// the *next* test (or the whole file, on process exit) instead of just
// failing the one test that threw.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleFtpConnect } from './ftp-client.js';
import as400Ftp from '../mock-lpar/mock-as400-ftp.js';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
const closed = srv => new Promise(r => srv.close(r));
const noopLogger = { info() {}, warn() {}, error() {} };

async function as400Mock() {
  const ctx = as400Ftp.makeContext({
    sysname: 'AS400MOCK',
    usrprfs: [{ name: 'QSECOFR', status: '*ENABLED', pwdNone: false, text: 'Security officer', specialAuth: [], pwdChg: '07/02/26' }],
    credentials: { QSECOFR: 'QSECOFR' },
    log: () => {},
    env: {},
  });
  const srv = await listen(as400Ftp.plainServer(ctx));
  return { ctx, port: srv.address().port, stop: () => closed(srv) };
}

// Minimal stand-in for the browser WebSocket handleFtpConnect talks to.
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
  handleFtpConnect(ws, 1, params, send, noopLogger, '127.0.0.1');
  const cmd = msg => ws.emit('message', JSON.stringify(msg));
  const connected = () => waitFor(() => messages.some(m => m.type === 'ftp.status' && m.state === 'connected'));
  const last = type => messages.filter(m => m.type === type).at(-1);
  const until = pred => waitFor(() => messages.some(pred));
  const disconnect = () => { cmd({ type: 'ftp.disconnect' }); return new Promise(r => setTimeout(r, 30)); };
  return { ws, messages, cmd, connected, last, until, disconnect };
}

// Runs body(mock, session), then always disconnects the session and stops
// the mock, whether body passed, failed, or never reached its own cleanup.
async function withSession(mockFactory, params, body) {
  const m = await mockFactory();
  const s = session({ host: '127.0.0.1', port: m.port, ...params });
  try {
    await body(m, s);
  } finally {
    await s.disconnect().catch(() => {});
    await m.stop();
  }
}

test('connect + login + PWD against the mock FTP server', () => withSession(as400Mock, { username: 'QSECOFR', password: 'QSECOFR', secure: 'none' }, async (m, s) => {
  await s.connected();
  s.cmd({ type: 'ftp.pwd' });
  await s.until(x => x.type === 'ftp.pwd');
  assert.ok(s.last('ftp.pwd').text.length > 0);
}));

test('wrong password: login refused, never reaches connected', () => withSession(as400Mock, { username: 'QSECOFR', password: 'WRONG', secure: 'none' }, async (m, s) => {
  await s.until(x => x.type === 'ftp.error');
  assert.match(s.last('ftp.error').message, /login refused/);
  assert.equal(s.messages.some(x => x.type === 'ftp.status' && x.state === 'connected'), false);
}));

test('real directory listing comes back parsed', () => withSession(as400Mock, { username: 'QSECOFR', password: 'QSECOFR', secure: 'none' }, async (m, s) => {
  await s.connected();
  s.cmd({ type: 'ftp.list' });
  await s.until(x => x.type === 'ftp.listing');
  const listing = s.last('ftp.listing');
  assert.equal(listing.ok, true);
  assert.ok(listing.entries.length > 0);
}));

test('STOR is refused server-side without crashing (no scope.json: write allowed by default)', () => withSession(as400Mock, { username: 'QSECOFR', password: 'QSECOFR', secure: 'none' }, async (m, s) => {
  await s.connected();
  s.cmd({ type: 'ftp.stor', name: 'whatever', dataBase64: Buffer.from('x').toString('base64') });
  await s.until(x => x.type === 'ftp.transfer' && x.op === 'stor');
  assert.equal(s.last('ftp.transfer').ok, false);
}));

test('RCMD is refused client-side and never reaches the wire', () => withSession(as400Mock, { username: 'QSECOFR', password: 'QSECOFR', secure: 'none' }, async (m, s) => {
  await s.connected();
  s.cmd({ type: 'ftp.cmd', line: 'RCMD WRKACTJOB' });
  await s.until(x => x.type === 'ftp.error' && /RCMD/.test(x.message));
}));

test('an unsupported verb on the target (DELE on this mock) fails cleanly, no crash', () => withSession(as400Mock, { username: 'QSECOFR', password: 'QSECOFR', secure: 'none' }, async (m, s) => {
  await s.connected();
  s.cmd({ type: 'ftp.dele', path: 'NOPE' });
  await s.until(x => x.type === 'ftp.opResult');
  assert.equal(s.last('ftp.opResult').ok, false);
}));

let scopeDir;
beforeEach(() => {
  scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftp-client-scope-'));
  process.env.BRIDGE_SCOPE_FILE = path.join(scopeDir, 'scope.json');
  process.env.BRIDGE_SCOPE_AUDIT = path.join(scopeDir, 'audit.log');
});
afterEach(() => {
  delete process.env.BRIDGE_SCOPE_FILE; delete process.env.BRIDGE_SCOPE_AUDIT;
  fs.rmSync(scopeDir, { recursive: true, force: true });
});

test('RoE scope guard: ftp-write not in scope.activities blocks a write but not browsing', () => withSession(as400Mock, { username: 'QSECOFR', password: 'QSECOFR', secure: 'none' }, async (m, s) => {
  fs.writeFileSync(process.env.BRIDGE_SCOPE_FILE, JSON.stringify({ hosts: ['127.0.0.1'], activities: [] }));
  await s.connected();
  s.cmd({ type: 'ftp.pwd' });
  await s.until(x => x.type === 'ftp.pwd');
  s.cmd({ type: 'ftp.stor', name: 'MEMBER1', dataBase64: Buffer.from('x').toString('base64') });
  await s.until(x => x.type === 'ftp.error' && /RoE scope guard/.test(x.message));
}));

test('RoE scope guard: ftp-write explicitly in scope.activities lets the call through to the target', () => withSession(as400Mock, { username: 'QSECOFR', password: 'QSECOFR', secure: 'none' }, async (m, s) => {
  fs.writeFileSync(process.env.BRIDGE_SCOPE_FILE, JSON.stringify({ hosts: ['127.0.0.1'], activities: ['ftp-write'] }));
  await s.connected();
  s.cmd({ type: 'ftp.stor', name: 'MEMBER1', dataBase64: Buffer.from('x').toString('base64') });
  await s.until(x => x.type === 'ftp.transfer' && x.op === 'stor');
  // Not gated by scope this time — same 500 from the mock (it doesn't
  // support STOR at all) proves the scope guard let the call reach the
  // wire, rather than proving the write itself succeeded.
  assert.equal(s.last('ftp.transfer').ok, false);
  assert.equal(s.messages.some(x => x.type === 'ftp.error' && /RoE scope guard/.test(x.message)), false);
}));
