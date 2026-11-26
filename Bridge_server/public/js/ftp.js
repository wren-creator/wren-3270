// ── js/ftp.js — Interactive FTP client: session tabs, directory/dataset
// browser, upload/download, and a raw command console. Mirrors ssh.js's
// tab/session plumbing (host dropdown, save/edit/delete, tab registry in
// state.sessions keyed by sid) but the pane is a file browser instead of
// an xterm terminal, wired to features/ftp-client.js over ftp.* WS messages.
import { state } from './state.js';
import { esc, saveAs } from './utils.js';
import { setConnStatus, clearOiaFields } from './tabs.js';

let _ftpHosts = [];

async function ftpLoadHosts() {
  try {
    const res = await fetch('/api/ftp-hosts');
    _ftpHosts = await res.json();
    _ftpRenderHostDropdown();
  } catch (e) {
    console.warn('ftp: could not load ftp-hosts.txt', e);
  }
}

function _ftpRenderHostDropdown() {
  const sel = document.getElementById('ftpHostSelect');
  if (!sel) return;
  const placeholder = '<option value="">— Select FTP host —</option>';
  const opts = _ftpHosts.map(h =>
    `<option value="${esc(h.id)}" data-user="${esc(h.user)}" data-host="${esc(h.host)}" data-port="${h.port}" data-secure="${esc(h.secure || 'none')}">${esc(h.name)} (${esc(h.host)})</option>`
  ).join('');
  sel.innerHTML = placeholder + opts;
}

export function openFtpConnect() {
  ftpLoadHosts();
  const sel = document.getElementById('ftpHostSelect');
  if (sel) sel.value = '';
  const userEl = document.getElementById('ftpUser');
  if (userEl) userEl.value = '';
  const passEl = document.getElementById('ftpPassword');
  if (passEl) passEl.value = '';
  const errEl = document.getElementById('ftpConnectErr');
  if (errEl) errEl.textContent = '';
  const modal = document.getElementById('ftpConnectModal');
  if (modal) modal.style.display = 'flex';
  setTimeout(() => document.getElementById('ftpPassword')?.focus(), 80);
}

export function closeFtpConnect() {
  const modal = document.getElementById('ftpConnectModal');
  if (modal) modal.style.display = 'none';
}

export function ftpHostChanged() {
  const sel = document.getElementById('ftpHostSelect');
  const opt = sel?.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  const userInput = document.getElementById('ftpUser');
  if (userInput && opt.dataset.user) userInput.value = opt.dataset.user;
  const secureSel = document.getElementById('ftpSecure');
  if (secureSel && opt.dataset.secure) secureSel.value = opt.dataset.secure;
}

export async function ftpConnect() {
  const sel      = document.getElementById('ftpHostSelect');
  const opt      = sel?.options[sel.selectedIndex];
  const userEl   = document.getElementById('ftpUser');
  const passEl   = document.getElementById('ftpPassword');
  const secureEl = document.getElementById('ftpSecure');
  const errEl    = document.getElementById('ftpConnectErr');

  if (!opt || !opt.value) { if (errEl) errEl.textContent = 'Select a host.'; return; }
  const host     = opt.dataset.host;
  const port     = parseInt(opt.dataset.port) || 21;
  const name     = opt.text.split('(')[0].trim();
  const username = userEl?.value.trim() || opt.dataset.user || '';
  const password = passEl?.value || '';
  const secure   = secureEl?.value || opt.dataset.secure || 'none';
  if (!username) { if (errEl) errEl.textContent = 'Enter a username.'; return; }
  if (errEl) errEl.textContent = '';

  closeFtpConnect();
  if (passEl) passEl.value = '';

  const sid = Date.now();
  _ftpOpenSession(sid, name, host, port, username, password, secure);
}

// Reopens an FTP session from a handed-off payload (see detachTab() in
// tabs.js) instead of the connect modal's form fields.
export function ftpConnectWith({ host, port, username, password, secure, name }) {
  const sid = Date.now();
  _ftpOpenSession(sid, name || host, host, port, username, password, secure);
}

function _ftpConnectWs(sid) {
  const session = state.sessions.get(sid);
  if (!session) return null;
  const ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'ftp.connect', host: session.host, port: session.port,
      username: session.username, password: session.password, secure: session.secure,
    }));
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    switch (msg.type) {
      case 'ftp.status':
        if (msg.state === 'connected') {
          session.state = 'connected';
          session.secureData = !!msg.secureData;
          _ftpUpdateTabDot(sid, '#3a9a6a');
          _ftpLog(session, `Connected. ${msg.secure !== 'none' ? `TLS: control secured, data ${msg.secureData ? 'secured (PROT P)' : 'NOT secured'}.` : 'No TLS.'}`);
          if (state.activeFtpSession === sid) _ftpSyncOia(session);
          ws.send(JSON.stringify({ type: 'ftp.pwd' }));
          ws.send(JSON.stringify({ type: 'ftp.list' }));
        } else if (msg.state === 'disconnected') {
          session.state = 'closed';
          _ftpUpdateTabDot(sid, '#888');
          _ftpLog(session, `Disconnected (${msg.reason || 'remote close'}).`);
          if (state.activeFtpSession === sid) setConnStatus(session.name, 'disconnected');
        }
        break;
      case 'ftp.error':
        session.state = 'error';
        _ftpLog(session, `ERROR: ${msg.message}`);
        _ftpUpdateTabDot(sid, '#c0392b');
        if (state.activeFtpSession === sid) setConnStatus(session.name, 'error');
        break;
      case 'ftp.reply':
        _ftpLog(session, msg.line);
        break;
      case 'ftp.pwd':
        session.cwd = msg.text;
        _ftpUpdatePathBar(session);
        break;
      case 'ftp.cwdResult':
        if (msg.ok) { ws.send(JSON.stringify({ type: 'ftp.pwd' })); ws.send(JSON.stringify({ type: 'ftp.list' })); }
        else _ftpLog(session, `Could not change directory: ${msg.code} ${msg.text}`);
        break;
      case 'ftp.listing':
        if (msg.ok) _ftpRenderListing(session, msg.entries);
        else _ftpLog(session, `List failed: ${msg.message}`);
        break;
      case 'ftp.opResult':
        if (!msg.ok) _ftpLog(session, `${msg.op} failed: ${msg.code} ${msg.text}`);
        ws.send(JSON.stringify({ type: 'ftp.list', path: session.lastListPath || null }));
        break;
      case 'ftp.transfer':
        if (msg.op === 'stor') {
          _ftpLog(session, msg.ok ? `Uploaded ${msg.name} (${msg.bytes} bytes).` : `Upload of ${msg.name} failed: ${msg.message}`);
          if (msg.ok) ws.send(JSON.stringify({ type: 'ftp.list', path: session.lastListPath || null }));
        } else if (msg.op === 'retr') {
          _ftpLog(session, msg.ok ? `Downloaded ${msg.name} (${msg.bytes} bytes).` : `Download of ${msg.name} failed: ${msg.message}`);
        }
        break;
      case 'ftp.data': {
        const bytes = Uint8Array.from(atob(msg.dataBase64), c => c.charCodeAt(0));
        saveAs(new Blob([bytes]), msg.name.replace(/^.*[\/\\]/, '').replace(/[()']/g, '') || 'download');
        break;
      }
    }
  };

  ws.onclose = () => {
    if (session.state !== 'error') session.state = 'closed';
    _ftpUpdateTabDot(sid, '#888');
  };

  return ws;
}

function _ftpLog(session, text) {
  const log = session.container?.querySelector('.ftp-console-log');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'ftp-console-line';
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function _ftpUpdatePathBar(session) {
  const bar = session.container?.querySelector('.ftp-pwd');
  if (bar) bar.textContent = session.cwd || '?';
}

// Best-effort "what's the name" out of one raw LIST line. FTP has no
// standard listing format — z/OS dataset/PDS-member listings put the name
// first, Unix-style `ls -l` (USS, IBM i IFS) puts it last. Good enough for
// the double-click/row-button convenience actions; the raw console below
// is always there for anything this guesses wrong on.
function _ftpParseName(line) {
  const t = line.trim();
  if (/^[-dlcbps][-rwxXsStT]{9}/.test(t)) {
    const parts = t.split(/\s+/);
    return parts[parts.length - 1];
  }
  return t.split(/\s+/)[0];
}

function _ftpRenderListing(session, entries) {
  const el = session.container?.querySelector('.ftp-listing');
  if (!el) return;
  el.innerHTML = '';
  if (!entries.length) {
    el.innerHTML = '<div class="ftp-listing-empty">(empty)</div>';
    return;
  }
  for (const line of entries) {
    const name = _ftpParseName(line);
    const row = document.createElement('div');
    row.className = 'ftp-row';
    row.innerHTML = `<span class="ftp-row-text">${esc(line)}</span>` +
      `<span class="ftp-row-actions">` +
        `<button class="ftp-row-btn" data-act="get" title="Download">↓</button>` +
        `<button class="ftp-row-btn" data-act="ren" title="Rename">✎</button>` +
        `<button class="ftp-row-btn" data-act="del" title="Delete">✕</button>` +
      `</span>`;
    row.addEventListener('dblclick', () => _ftpTryEnter(session, name));
    row.querySelector('[data-act="get"]').addEventListener('click', ev => { ev.stopPropagation(); _ftpDownload(session, name); });
    row.querySelector('[data-act="ren"]').addEventListener('click', ev => { ev.stopPropagation(); _ftpRename(session, name); });
    row.querySelector('[data-act="del"]').addEventListener('click', ev => { ev.stopPropagation(); _ftpDelete(session, name); });
    el.appendChild(row);
  }
}

function _ftpSend(session, msg) {
  if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(msg));
}

function _ftpTryEnter(session, name) {
  session.lastListPath = null;
  _ftpSend(session, { type: 'ftp.cwd', path: name });
}

function _ftpDownload(session, name) {
  _ftpSend(session, { type: 'ftp.retr', name });
}

function _ftpDelete(session, name) {
  if (!confirm(`Delete "${name}"?`)) return;
  _ftpSend(session, { type: 'ftp.dele', path: name });
}

function _ftpRename(session, name) {
  const to = prompt(`Rename "${name}" to:`, name);
  if (!to || to === name) return;
  _ftpSend(session, { type: 'ftp.rename', from: name, to });
}

function _buildFtpContainer(session) {
  const container = document.createElement('div');
  container.className = 'ftp-session-container';
  container.innerHTML = `
    <div class="ftp-toolbar">
      <button class="ftp-btn" data-act="up" title="Up one level">⬆</button>
      <button class="ftp-btn" data-act="refresh" title="Refresh listing">↻</button>
      <span class="ftp-pwd">?</span>
      <input class="ftp-path-input" type="text" placeholder="path or dataset pattern — Enter to go/list">
      <button class="ftp-btn" data-act="upload">⬆ Upload</button>
      <input type="file" class="ftp-file-input" style="display:none">
      <button class="ftp-btn" data-act="mkd">+ Dir</button>
      <select class="ftp-type-select" title="Transfer type">
        <option value="A">ASCII</option>
        <option value="I">Binary</option>
      </select>
    </div>
    <div class="ftp-listing"></div>
    <div class="ftp-console">
      <div class="ftp-console-log"></div>
      <div class="ftp-console-row">
        <span class="ftp-prompt">ftp&gt;</span>
        <input class="ftp-console-input" type="text" placeholder="raw command — SITE RECFM=FB LRECL=80, quote PWD, ...">
      </div>
    </div>`;

  container.querySelector('[data-act="up"]').addEventListener('click', () => _ftpSend(session, { type: 'ftp.cwd', path: '..' }));
  container.querySelector('[data-act="refresh"]').addEventListener('click', () => { session.lastListPath = null; _ftpSend(session, { type: 'ftp.list' }); });
  container.querySelector('[data-act="mkd"]').addEventListener('click', () => {
    const name = prompt('New directory name:');
    if (name) _ftpSend(session, { type: 'ftp.mkd', path: name });
  });

  const pathInput = container.querySelector('.ftp-path-input');
  pathInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = pathInput.value.trim();
    if (!v) return;
    session.lastListPath = v;
    _ftpSend(session, { type: 'ftp.list', path: v });
  });

  const typeSelect = container.querySelector('.ftp-type-select');
  typeSelect.addEventListener('change', () => _ftpSend(session, { type: 'ftp.type', mode: typeSelect.value }));

  const fileInput = container.querySelector('.ftp-file-input');
  container.querySelector('[data-act="upload"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const target = prompt('Remote name/dataset(member) to STOR as:', file.name);
    if (!target) return;
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      _ftpSend(session, { type: 'ftp.stor', name: target, dataBase64: btoa(bin) });
    };
    reader.readAsArrayBuffer(file);
  });

  const consoleInput = container.querySelector('.ftp-console-input');
  consoleInput.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const line = consoleInput.value.trim();
    if (!line) return;
    consoleInput.value = '';
    _ftpSend(session, { type: 'ftp.cmd', line });
  });

  return container;
}

function _ftpOpenSession(sid, name, host, port, username, password, secure) {
  const session = {
    ws: null, container: null, host, name, port, username, password, secure,
    type: 'ftp', sid, state: 'connecting', cwd: null, lastListPath: null, secureData: false,
  };
  const container = _buildFtpContainer(session);
  container.style.cssText = 'width:100%;height:100%;display:none;';
  document.getElementById('ftpPool').appendChild(container);
  session.container = container;

  state.sessions.set(sid, session);
  session.ws = _ftpConnectWs(sid);
  _ftpAddTab(sid, name);
}

function _ftpAddTab(sid, name) {
  const tabs   = document.querySelector('.session-tabs');
  const addBtn = tabs.querySelector('.tab-add');
  const tab    = document.createElement('div');
  tab.className    = 'session-tab ftp-tab';
  tab.dataset.sid  = sid;
  tab.dataset.type = 'ftp';
  tab.innerHTML    = `<div class="tab-dot" style="background:#ffaa00;box-shadow:0 0 4px #ffaa00"></div>\u{1F4C1} ${esc(name)}<span class="tab-detach" onclick="detachTab(event,this)" title="Detach into its own window">⧉</span><span class="tab-close" onclick="ftpCloseTab(event,this)">&times;</span>`;
  tab.onclick = () => ftpActivateTab(sid);
  tabs.insertBefore(tab, addBtn);
  ftpActivateTab(sid);
}

function _ftpUpdateTabDot(sid, color) {
  const tab = document.querySelector(`.session-tab[data-sid="${sid}"]`);
  const dot = tab?.querySelector('.tab-dot');
  if (dot) { dot.style.background = color; dot.style.boxShadow = `0 0 4px ${color}`; }
}

function _ftpSyncOia(session) {
  const oiaSys   = document.getElementById('oiaSys');
  const oiaLu    = document.getElementById('oiaLu');
  const oiaTls   = document.getElementById('oiaTls');
  const oiaModel = document.getElementById('oiaModel');
  const oiaApp   = document.getElementById('oiaApp');
  const oiaMode  = document.getElementById('oiaMode');
  if (oiaSys)   oiaSys.textContent   = session.host;
  if (oiaLu)    oiaLu.textContent    = session.username;
  if (oiaTls)   oiaTls.textContent   = session.secure === 'none' ? 'FTP' : (session.secureData ? 'FTPS' : 'FTP(AUTH)');
  if (oiaModel) oiaModel.textContent = '—';
  if (oiaApp)   { oiaApp.textContent = '—'; oiaApp.style.color = ''; }
  const connColor = session.state === 'connected' ? 'var(--accent-green)' : session.state === 'connecting' ? 'var(--accent-amber)' : 'var(--text-muted)';
  const dot = document.getElementById('mainConnDot');
  const txt = document.getElementById('connStatusText');
  if (dot) dot.className = session.state === 'connected' ? 'conn-dot' : session.state === 'connecting' ? 'conn-dot connecting' : 'conn-dot disconnected';
  if (txt) { txt.textContent = session.name + (session.state === 'connected' ? ' · Connected' : session.state === 'connecting' ? ' · Connecting…' : ' · Disconnected'); txt.style.color = connColor; }
  if (oiaMode) {
    if (session.state === 'connected')       { oiaMode.textContent = 'FTP CONNECTED';  oiaMode.className = 'oia-val blue'; }
    else if (session.state === 'connecting') { oiaMode.textContent = 'FTP CONNECTING'; oiaMode.className = 'oia-val amber'; }
    else                                     { oiaMode.textContent = 'FTP CLOSED';     oiaMode.className = 'oia-val'; }
  }
}

export function ftpActivateTab(sid) {
  document.querySelectorAll('.session-tab').forEach(t => t.classList.remove('active'));
  const tab = document.querySelector(`.session-tab[data-sid="${sid}"]`);
  if (tab) tab.classList.add('active');

  const term3270 = document.getElementById('terminal');
  const sshPane  = document.getElementById('sshTerminal');
  const ftpPane  = document.getElementById('ftpPane');
  if (term3270) term3270.style.display = 'none';
  if (sshPane)  sshPane.style.display  = 'none';
  if (ftpPane)  ftpPane.style.display  = 'flex';

  const session = state.sessions.get(sid);
  if (!session) return;
  if (ftpPane) {
    ftpPane.innerHTML = '';
    session.container.style.display = 'flex';
    ftpPane.appendChild(session.container);
  }

  state.activeSession    = null;
  state.activeSshSession = null;
  state.activeFtpSession = sid;
  _ftpSyncOia(session);
}

export function ftpCloseTab(e, closeBtn) {
  e.stopPropagation();
  const tab = closeBtn.closest('.session-tab');
  const sid = Number(tab.dataset.sid);
  const session = state.sessions.get(sid);
  if (session) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'ftp.disconnect' }));
    if (session.ws) session.ws.close();
    session.container.remove();
    state.sessions.delete(sid);
  }
  tab.remove();
  if (state.activeFtpSession === sid) {
    state.activeFtpSession = null;
    const term3270 = document.getElementById('terminal');
    const ftpPane  = document.getElementById('ftpPane');
    if (term3270) term3270.style.display = '';
    if (ftpPane)  ftpPane.style.display  = 'none';
    setConnStatus('', 'disconnected');
    clearOiaFields();
    const remaining = document.querySelector('.session-tab');
    if (remaining) remaining.click();
  }
}

export async function ftpSaveHost() {
  const statusEl = document.getElementById('ftpSaveHostStatus');
  const setStatus = (msg, ok) => { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = ok ? '#3a9a6a' : '#c0392b'; } };
  const id     = document.getElementById('ftpNewId')?.value.trim();
  const name   = document.getElementById('ftpNewName')?.value.trim();
  const host   = document.getElementById('ftpNewHost')?.value.trim();
  const port   = parseInt(document.getElementById('ftpNewPort')?.value) || 21;
  const user   = document.getElementById('ftpNewUser')?.value.trim() || '';
  const secure = document.getElementById('ftpNewSecure')?.value || 'none';
  if (!id || !host) { setStatus('id and host are required.', false); return; }
  try {
    const res = await fetch('/api/ftp-hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: name || id, host, port, user, secure }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); setStatus(e.error || `Save failed (${res.status}).`, false); return; }
    await ftpLoadHosts();
    const sel = document.getElementById('ftpHostSelect');
    if (sel) sel.value = id;
    setStatus(`Saved "${name || id}".`, true);
    ['ftpNewId', 'ftpNewName', 'ftpNewHost', 'ftpNewUser'].forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
    const portEl = document.getElementById('ftpNewPort');
    if (portEl) portEl.value = '21';
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, false);
  }
}

export function ftpEditHost() {
  const sel = document.getElementById('ftpHostSelect');
  const opt = sel?.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  const h = _ftpHosts.find(x => x.id === opt.value);
  if (!h) return;
  document.getElementById('ftpNewId').value     = h.id;
  document.getElementById('ftpNewName').value   = h.name;
  document.getElementById('ftpNewHost').value   = h.host;
  document.getElementById('ftpNewPort').value   = h.port;
  document.getElementById('ftpNewUser').value   = h.user || '';
  const secureEl = document.getElementById('ftpNewSecure');
  if (secureEl) secureEl.value = h.secure || 'none';
  const details = document.getElementById('ftpAddHostDetails');
  if (details) details.open = true;
  const statusEl = document.getElementById('ftpSaveHostStatus');
  if (statusEl) statusEl.textContent = '';
}

export async function ftpDeleteHost() {
  const sel = document.getElementById('ftpHostSelect');
  const opt = sel?.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  if (!confirm(`Delete "${opt.text.split('(')[0].trim()}"?`)) return;
  await fetch(`/api/ftp-hosts/${encodeURIComponent(opt.value)}`, { method: 'DELETE' });
  await ftpLoadHosts();
}

Object.assign(window, {
  openFtpConnect, closeFtpConnect, ftpHostChanged, ftpConnect, ftpConnectWith,
  ftpActivateTab, ftpCloseTab, ftpSaveHost, ftpEditHost, ftpDeleteHost,
});
