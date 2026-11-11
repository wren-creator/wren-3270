// Interactive FTP client — the general-purpose cousin of features/ftp.js's
// two narrow siblings. features/ftp-audit.js is read-only recon (its
// ALLOWED_VERBS set makes STOR/DELE/etc. physically unreachable);
// features/ftp-jcl-submit.js is a single-purpose STOR-to-JES tool with no
// browsing at all. This file is the one that actually does what a real FTP
// client does: connect, browse (z/OS datasets, z/OS USS paths, IBM i
// IFS/libraries — whatever the target answers LIST/CWD with), upload and
// download files, rename/delete/mkdir, and a raw command line for anything
// shop-specific (SITE RECFM=.../LRECL=..., SITE NAMEFMT 1, etc.) that no
// fixed set of buttons could cover across three different FTP dialects.
//
// Kept deliberately NOT allowlist-restricted like ftp-audit.js — STOR,
// DELE, RNFR/RNTO, MKD/RMD are the whole point of a write-capable client.
// What keeps this safe to ship:
//   - the WebSocket connect itself is gated on the target host by the RoE
//     Scope Guard before this file is ever called (handlers/ws.js, same as
//     ssh.connect).
//   - every verb that actually changes something on the target (STOR,
//     STOU, APPE, DELE, RNFR, RNTO, MKD/XMKD, RMD/XRMD — WRITE_VERBS below)
//     is re-checked against the "ftp-write" activity on every single call,
//     not once at connect time, so browsing never needs the write activity
//     to be in scope and a scope.json edited mid-session takes effect
//     immediately.
//   - RCMD (IBM i: run an arbitrary CL command from an FTP session) is
//     flatly refused, never put on the wire, the same posture
//     ftp-audit.js already takes with it ("only ever noticed in HELP text,
//     never run"). This client does not become a shell.
import net from 'net';
import tls from 'tls';
import { checkScope, auditAction } from './scope.js';

const TIMEOUT_MS = 15000;
const MAX_REPLY = 16 * 1024;
const MAX_LIST = 256 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const WRITE_VERBS = new Set(['STOR', 'STOU', 'APPE', 'DELE', 'RNFR', 'RNTO', 'MKD', 'XMKD', 'RMD', 'XRMD']);
const BLOCKED_VERBS = new Set(['RCMD']);

const clean = (s, n = 400) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, n);

// Pulls one complete reply (single-line "code text" or multi-line
// "code-...\ncode text") off the front of buf. Returns null if not all of
// it has arrived yet.
function parseReply(buf) {
  const lines = buf.split('\n');
  if (lines.length < 2) return null;
  const first = lines[0].replace(/\r$/, '');
  const m = /^(\d{3})([ -])/.exec(first);
  if (!m) return { reply: { code: 0, text: clean(first) }, used: lines[0].length + 1 };
  if (m[2] === ' ') return { reply: { code: +m[1], text: clean(first.slice(4)) }, used: lines[0].length + 1 };
  const done = new RegExp(`^${m[1]} `);
  let used = 0; const got = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i].replace(/\r$/, '');
    used += lines[i].length + 1; got.push(l);
    if (i > 0 && done.test(l)) {
      return { reply: { code: +m[1], text: clean(got.map(x => x.slice(4)).join(' ')) }, used };
    }
  }
  return null;
}

// Wraps the control socket. attach() lets the same logical connection swap
// its underlying socket in place (plaintext → TLS on AUTH TLS) without the
// caller needing to know.
function makeControl(sock) {
  const c = { sock, buf: '', waiter: null, dead: null, onClose: null };
  const wake = () => {
    if (!c.waiter) return;
    const p = parseReply(c.buf);
    if (p) {
      const w = c.waiter; c.waiter = null; clearTimeout(w.t);
      c.buf = c.buf.slice(p.used); w.resolve(p.reply);
    } else if (c.dead) {
      const w = c.waiter; c.waiter = null; clearTimeout(w.t);
      w.resolve({ code: 0, text: '', error: c.dead });
    }
  };
  c.attach = s => {
    c.sock = s;
    s.on('data', chunk => {
      c.buf += chunk.toString('latin1');
      if (c.buf.length > MAX_REPLY) { c.dead = 'reply too large'; s.destroy(); }
      wake();
    });
    s.on('error', e => { c.dead = c.dead || e.message; wake(); });
    s.on('close', () => { c.dead = c.dead || 'connection closed'; wake(); if (c.onClose) c.onClose(); });
  };
  c.read = () => new Promise(resolve => {
    const t = setTimeout(() => { c.waiter = null; resolve({ code: 0, text: '', error: 'timed out' }); }, TIMEOUT_MS);
    c.waiter = { resolve, t };
    wake();
  });
  c.send = line => { c.sock.write(line + '\r\n'); return c.read(); };
  c.close = () => { try { c.sock.write('QUIT\r\n'); } catch {} try { c.sock.destroy(); } catch {} };
  c.attach(sock);
  return c;
}

function dialPlain(host, port) {
  return new Promise(resolve => {
    const s = net.connect({ host, port, timeout: TIMEOUT_MS });
    s.once('connect', () => { s.setTimeout(0); resolve({ ok: true, s }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, message: 'connect timed out' }); });
    s.once('error', e => resolve({ ok: false, message: e.message }));
  });
}

function dialImplicitTls(host, port) {
  return new Promise(resolve => {
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: TIMEOUT_MS });
    s.once('secureConnect', () => { s.setTimeout(0); resolve({ ok: true, s }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, message: 'TLS connect timed out' }); });
    s.once('error', e => resolve({ ok: false, message: e.message }));
  });
}

// AUTH TLS then the handshake, swapped onto the same control object.
async function upgradeControlTls(c, host) {
  const r = await c.send('AUTH TLS');
  if (r.code !== 234) return { ok: false, reply: r };
  const raw = c.sock;
  raw.removeAllListeners('data'); raw.removeAllListeners('close'); raw.removeAllListeners('error');
  raw.on('error', () => {});
  const t = await new Promise(resolve => {
    const s = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const timer = setTimeout(() => { s.destroy(); resolve({ ok: false, message: 'TLS handshake timed out' }); }, TIMEOUT_MS);
    s.once('secureConnect', () => { clearTimeout(timer); resolve({ ok: true, s }); });
    s.once('error', e => { clearTimeout(timer); resolve({ ok: false, message: e.message }); });
  });
  if (!t.ok) return { ok: false, message: t.message, reply: r };
  c.buf = ''; c.dead = null; c.attach(t.s);
  return { ok: true, reply: r };
}

// Data connection for one transfer/listing. secure=true wraps it in TLS on
// top of the already-open TCP socket, the PROT P half of the deal — the
// control host is always what's dialed, the address in the PASV reply is
// ignored, same deliberate choice features/ftp-audit.js and
// features/ftp-jcl-submit.js both make.
async function dialData(host, port, secure) {
  const plain = await dialPlain(host, port);
  if (!plain.ok || !secure) return plain;
  return new Promise(resolve => {
    const s = tls.connect({ socket: plain.s, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const timer = setTimeout(() => { s.destroy(); resolve({ ok: false, message: 'TLS data handshake timed out' }); }, TIMEOUT_MS);
    s.once('secureConnect', () => { clearTimeout(timer); resolve({ ok: true, s }); });
    s.once('error', e => { clearTimeout(timer); resolve({ ok: false, message: e.message }); });
  });
}

async function openDataChannel(c, host, secureData) {
  const pasv = await c.send('PASV');
  const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv.text);
  if (pasv.code !== 227 || !m) return { ok: false, message: `PASV failed (${pasv.code} ${pasv.text})` };
  const dataPort = (+m[5]) * 256 + (+m[6]);
  const d = await dialData(host, dataPort, secureData);
  if (!d.ok) return { ok: false, message: `data connection failed: ${d.message}` };
  return { ok: true, s: d.s };
}

async function doList(c, host, secureData, path) {
  const open = await openDataChannel(c, host, secureData);
  if (!open.ok) return { ok: false, message: open.message };
  const d = open.s;
  let data = '';
  d.on('data', ch => { if (data.length < MAX_LIST) data += ch.toString('latin1'); else d.destroy(); });
  const closed = new Promise(r => { d.on('close', r); d.on('error', r); setTimeout(r, TIMEOUT_MS).unref(); });
  const cmd = path ? `LIST ${path}` : 'LIST';
  const start = await c.send(cmd);
  if (start.code !== 150 && start.code !== 125) { d.destroy(); return { ok: false, message: `${cmd} -> ${start.code} ${start.text}` }; }
  await closed;
  await c.read();
  d.destroy();
  return { ok: true, entries: data.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length) };
}

async function transferStor(c, host, secureData, name, bytes) {
  const open = await openDataChannel(c, host, secureData);
  if (!open.ok) return { ok: false, message: open.message };
  const first = await c.send(`STOR ${name}`);
  if (first.code !== 150 && first.code !== 125) { open.s.destroy(); return { ok: false, message: `STOR refused: ${first.code} ${first.text}` }; }
  open.s.end(bytes);
  const final = await c.read();
  return { ok: final.code === 226 || final.code === 250, code: final.code, message: final.text };
}

async function transferRetr(c, host, secureData, name) {
  const open = await openDataChannel(c, host, secureData);
  if (!open.ok) return { ok: false, message: open.message };
  const d = open.s;
  const chunks = []; let total = 0, tooBig = false;
  d.on('data', ch => {
    total += ch.length;
    if (total > MAX_FILE_BYTES) { tooBig = true; d.destroy(); return; }
    chunks.push(ch);
  });
  const closed = new Promise(r => { d.on('close', r); d.on('error', r); setTimeout(r, TIMEOUT_MS).unref(); });
  const start = await c.send(`RETR ${name}`);
  if (start.code !== 150 && start.code !== 125) { d.destroy(); return { ok: false, message: `RETR refused: ${start.code} ${start.text}` }; }
  await closed;
  const final = await c.read();
  if (tooBig) return { ok: false, message: `File exceeds the ${MAX_FILE_BYTES}-byte transfer cap` };
  if (final.code !== 226 && final.code !== 250) return { ok: false, code: final.code, message: final.text };
  return { ok: true, code: final.code, message: final.text, data: Buffer.concat(chunks) };
}

// handleFtpConnect — wires an already scope-checked WebSocket (host-level
// check happens in handlers/ws.js before this is called, same as
// handleSshConnect) to a live FTP control connection, then dispatches
// ftp.* messages for the life of the session.
export function handleFtpConnect(ws, wsId, params, send, logger, origin) {
  const { host, username } = params;
  const password = params.password || '';
  const port = parseInt(params.port, 10) || 21;
  const secure = ['explicit', 'implicit'].includes(params.secure) ? params.secure : 'none';

  if (!host || !username) {
    send(ws, { type: 'ftp.error', message: 'host and username are required' });
    ws.close(); return;
  }

  logger.info(`[ws:${wsId}] FTP → ${username}@${host}:${port} (secure=${secure})`);
  send(ws, { type: 'ftp.status', state: 'connecting' });

  let clientInitiated = false;
  let secureData = false;

  (async () => {
    const dial = secure === 'implicit' ? await dialImplicitTls(host, port) : await dialPlain(host, port);
    if (!dial.ok) { send(ws, { type: 'ftp.error', message: `connect failed: ${dial.message}` }); ws.close(); return; }

    const c = makeControl(dial.s);
    c.onClose = () => {
      if (clientInitiated) return;
      send(ws, { type: 'ftp.status', state: 'disconnected', reason: 'remote close' });
      try { ws.close(); } catch {}
    };

    const banner = await c.read();
    send(ws, { type: 'ftp.reply', line: `${banner.code} ${banner.text}` });
    if (banner.code !== 220) { send(ws, { type: 'ftp.error', message: 'no 220 banner from host' }); c.close(); ws.close(); return; }

    if (secure === 'explicit') {
      const up = await upgradeControlTls(c, host);
      if (!up.ok) {
        send(ws, { type: 'ftp.error', message: `AUTH TLS failed: ${up.message || `${up.reply?.code} ${up.reply?.text}`}` });
        c.close(); ws.close(); return;
      }
      send(ws, { type: 'ftp.reply', line: `${up.reply.code} ${up.reply.text}` });
    }

    send(ws, { type: 'ftp.reply', line: `USER ${username}` });
    let r = await c.send(`USER ${username}`);
    send(ws, { type: 'ftp.reply', line: `${r.code} ${r.text}` });
    if (r.code === 331) {
      send(ws, { type: 'ftp.reply', line: 'PASS ****' });
      r = await c.send(`PASS ${password}`);
      send(ws, { type: 'ftp.reply', line: `${r.code} ${r.text}` });
    } else if (r.code === 332 && params.account) {
      r = await c.send(`ACCT ${params.account}`);
      send(ws, { type: 'ftp.reply', line: `${r.code} ${r.text}` });
    }
    if (r.code !== 230) {
      send(ws, { type: 'ftp.error', message: `login refused: ${r.text || r.error || r.code}` });
      c.close(); ws.close(); return;
    }

    if (secure !== 'none') {
      const pbsz = await c.send('PBSZ 0');
      send(ws, { type: 'ftp.reply', line: `${pbsz.code} ${pbsz.text}` });
      const prot = await c.send('PROT P');
      send(ws, { type: 'ftp.reply', line: `${prot.code} ${prot.text}` });
      secureData = prot.code === 200;
    }

    send(ws, { type: 'ftp.status', state: 'connected', banner: banner.text, secure, secureData });

    async function gateWrite(op, detail) {
      const gate = await checkScope('activity', 'ftp-write', { source: origin });
      if (!gate.allowed) {
        send(ws, { type: 'ftp.error', message: `Blocked by RoE scope guard: ${gate.reason}` });
        return false;
      }
      auditAction('ftp-write', { host, source: origin, username, op, ...detail });
      return true;
    }

    ws.on('message', async raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        switch (msg.type) {
          case 'ftp.pwd': {
            const rr = await c.send('PWD');
            send(ws, { type: 'ftp.reply', line: `${rr.code} ${rr.text}` });
            send(ws, { type: 'ftp.pwd', text: rr.text });
            break;
          }
          case 'ftp.cwd': {
            const rr = await c.send(`CWD ${msg.path}`);
            send(ws, { type: 'ftp.reply', line: `CWD ${msg.path} -> ${rr.code} ${rr.text}` });
            send(ws, { type: 'ftp.cwdResult', ok: rr.code === 250, code: rr.code, text: rr.text });
            break;
          }
          case 'ftp.list': {
            const target = msg.path ? String(msg.path) : null;
            const res = await doList(c, host, secureData, target);
            send(ws, { type: 'ftp.listing', path: target, ok: res.ok, entries: res.entries || [], message: res.message });
            break;
          }
          case 'ftp.type': {
            const mode = msg.mode === 'I' ? 'I' : 'A';
            const rr = await c.send(`TYPE ${mode}`);
            send(ws, { type: 'ftp.reply', line: `TYPE ${mode} -> ${rr.code} ${rr.text}` });
            break;
          }
          case 'ftp.site': {
            const rr = await c.send(`SITE ${msg.args}`);
            send(ws, { type: 'ftp.reply', line: `SITE ${msg.args} -> ${rr.code} ${rr.text}` });
            break;
          }
          case 'ftp.mkd': case 'ftp.rmd': case 'ftp.dele': {
            const verb = msg.type === 'ftp.mkd' ? 'MKD' : msg.type === 'ftp.rmd' ? 'RMD' : 'DELE';
            if (!(await gateWrite(verb, { target: msg.path }))) break;
            const rr = await c.send(`${verb} ${msg.path}`);
            send(ws, { type: 'ftp.reply', line: `${verb} ${msg.path} -> ${rr.code} ${rr.text}` });
            send(ws, { type: 'ftp.opResult', op: msg.type, ok: [200, 250, 257].includes(rr.code), code: rr.code, text: rr.text });
            break;
          }
          case 'ftp.rename': {
            if (!(await gateWrite('RENAME', { from: msg.from, to: msg.to }))) break;
            let rr = await c.send(`RNFR ${msg.from}`);
            send(ws, { type: 'ftp.reply', line: `RNFR ${msg.from} -> ${rr.code} ${rr.text}` });
            if (rr.code !== 350) { send(ws, { type: 'ftp.opResult', op: 'ftp.rename', ok: false, code: rr.code, text: rr.text }); break; }
            rr = await c.send(`RNTO ${msg.to}`);
            send(ws, { type: 'ftp.reply', line: `RNTO ${msg.to} -> ${rr.code} ${rr.text}` });
            send(ws, { type: 'ftp.opResult', op: 'ftp.rename', ok: rr.code === 250, code: rr.code, text: rr.text });
            break;
          }
          case 'ftp.stor': {
            const bytes = Buffer.from(String(msg.dataBase64 || ''), 'base64');
            if (bytes.length > MAX_FILE_BYTES) { send(ws, { type: 'ftp.error', message: `File too large (${bytes.length} bytes, max ${MAX_FILE_BYTES})` }); break; }
            if (!(await gateWrite('STOR', { target: msg.name, bytes: bytes.length }))) break;
            const res = await transferStor(c, host, secureData, msg.name, bytes);
            send(ws, { type: 'ftp.reply', line: `STOR ${msg.name} -> ${res.code || ''} ${res.message}`.trim() });
            send(ws, { type: 'ftp.transfer', op: 'stor', name: msg.name, ok: res.ok, bytes: bytes.length, message: res.message });
            break;
          }
          case 'ftp.retr': {
            const res = await transferRetr(c, host, secureData, msg.name);
            send(ws, { type: 'ftp.reply', line: `RETR ${msg.name} -> ${res.code || ''} ${res.message}`.trim() });
            if (!res.ok) { send(ws, { type: 'ftp.transfer', op: 'retr', name: msg.name, ok: false, message: res.message }); break; }
            send(ws, { type: 'ftp.data', name: msg.name, dataBase64: res.data.toString('base64') });
            send(ws, { type: 'ftp.transfer', op: 'retr', name: msg.name, ok: true, bytes: res.data.length });
            break;
          }
          case 'ftp.cmd': {
            const line = String(msg.line || '').trim();
            if (!line) break;
            const verb = line.split(/\s+/)[0].toUpperCase();
            if (BLOCKED_VERBS.has(verb)) { send(ws, { type: 'ftp.error', message: `${verb} is not supported by this client` }); break; }
            if (WRITE_VERBS.has(verb) && !(await gateWrite(verb, { line }))) break;
            const rr = await c.send(line);
            send(ws, { type: 'ftp.reply', line: `${line} -> ${rr.code} ${rr.text}` });
            break;
          }
          case 'ftp.disconnect': {
            clientInitiated = true;
            c.close();
            ws.close();
            break;
          }
        }
      } catch (err) {
        send(ws, { type: 'ftp.error', message: err.message });
      }
    });

    ws.on('close', () => { clientInitiated = true; c.close(); });
  })();
}
