// ── js/telnet.js — Interactive Telnet client: xterm session tabs, same
// plumbing as ssh.js (host dropdown, save/edit/delete, tab registry in
// state.sessions keyed by sid), wired to features/telnet.js over telnet.*
// WS messages. No username/password fields — telnet has no protocol-level
// auth, login happens inside the terminal stream itself.
import { state } from './state.js';
import { esc } from './utils.js';
import { setConnStatus, clearOiaFields } from './tabs.js';

let _telnetHosts = [];

async function telnetLoadHosts() {
  try {
    const res = await fetch('/api/telnet-hosts');
    _telnetHosts = await res.json();
    _telnetRenderHostDropdown();
  } catch (e) {
    console.warn('telnet: could not load telnet-hosts.txt', e);
  }
}

function _telnetRenderHostDropdown() {
  const sel = document.getElementById('telnetHostSelect');
  if (!sel) return;
  const placeholder = '<option value="">— Select Telnet host —</option>';
  const opts = _telnetHosts.map(h =>
    `<option value="${esc(h.id)}" data-host="${esc(h.host)}" data-port="${h.port}">${esc(h.name)} (${esc(h.host)})</option>`
  ).join('');
  sel.innerHTML = placeholder + opts;
}

export function openTelnetConnect() {
  telnetLoadHosts();
  const sel = document.getElementById('telnetHostSelect');
  if (sel) sel.value = '';
  const hostEl = document.getElementById('telnetManualHost');
  if (hostEl) hostEl.value = '';
  const portEl = document.getElementById('telnetManualPort');
  if (portEl) portEl.value = '23';
  const errEl = document.getElementById('telnetConnectErr');
  if (errEl) errEl.textContent = '';
  const modal = document.getElementById('telnetConnectModal');
  if (modal) modal.style.display = 'flex';
}

export function closeTelnetConnect() {
  const modal = document.getElementById('telnetConnectModal');
  if (modal) modal.style.display = 'none';
}

export function telnetHostChanged() {
  const sel = document.getElementById('telnetHostSelect');
  const opt = sel?.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  const hostEl = document.getElementById('telnetManualHost');
  const portEl = document.getElementById('telnetManualPort');
  if (hostEl) hostEl.value = opt.dataset.host || '';
  if (portEl) portEl.value = opt.dataset.port || '23';
}

export async function telnetConnect() {
  const sel     = document.getElementById('telnetHostSelect');
  const opt     = sel?.options[sel.selectedIndex];
  const hostEl  = document.getElementById('telnetManualHost');
  const portEl  = document.getElementById('telnetManualPort');
  const errEl   = document.getElementById('telnetConnectErr');

  const host = hostEl?.value.trim() || opt?.dataset.host || '';
  const port = parseInt(portEl?.value || opt?.dataset.port, 10) || 23;
  const name = (opt && opt.value) ? opt.text.split('(')[0].trim() : host;
  if (!host) { if (errEl) errEl.textContent = 'Enter or select a host.'; return; }
  if (errEl) errEl.textContent = '';

  closeTelnetConnect();

  const sid = Date.now();
  _telnetOpenSession(sid, name, host, port);
}

// Reopens a Telnet session from a handed-off payload (see detachTab() in
// tabs.js) instead of the connect modal's form fields.
export function telnetConnectWith({ host, port, name }) {
  const sid = Date.now();
  _telnetOpenSession(sid, name || host, host, port);
}

// Opens (or reopens, for reconnect) the WebSocket for a Telnet session onto
// an existing sid, reusing the session's terminal. Split out from
// _telnetOpenSession so a dropped session can be reconnected onto the same
// tab instead of spawning a new one.
function _telnetConnectWs(sid) {
  const session = state.sessions.get(sid);
  if (!session) return null;
  const ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'telnet.connect', host: session.host, port: session.port,
      rows: session.term.rows, cols: session.term.cols,
    }));
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'telnet.data') {
      session.term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
    } else if (msg.type === 'telnet.status') {
      if (msg.state === 'connected') {
        session.state = 'connected';
        session.reconnectAttempt = 0;
        _telnetUpdateTabDot(sid, '#3a9a6a');
        if (state.activeTelnetSession === sid) {
          const oiaMode = document.getElementById('oiaMode');
          if (oiaMode) { oiaMode.textContent = 'TELNET CONNECTED'; oiaMode.className = 'oia-val blue'; }
        }
      } else if (msg.state === 'disconnected') {
        session.state = 'disconnected';
        session.lastDisconnectReason = msg.reason;
        _telnetUpdateTabDot(sid, '#c0392b');
        if (state.activeTelnetSession === sid) {
          const oiaMode = document.getElementById('oiaMode');
          if (oiaMode) { oiaMode.textContent = 'TELNET CLOSED'; oiaMode.className = 'oia-val'; }
        }
        // Reconnect decision happens in ws.onclose below, which fires right
        // after this message as the server tears down the socket — keeping
        // it in one place avoids scheduling two competing reconnects.
      }
    } else if (msg.type === 'telnet.error') {
      session.state = 'error';
      session.term.writeln(`\r\n\x1b[31m[Telnet Error] ${msg.message}\x1b[0m`);
      _telnetUpdateTabDot(sid, '#c0392b');
      if (state.activeTelnetSession === sid) {
        setConnStatus(session.name, 'error');
      }
    }
  };

  ws.onclose = () => {
    // telnet.error (host refused the connection, etc.) already put us in
    // 'error' state — never auto-reconnect onto that.
    const wasError = session.state === 'error';
    session.state = 'closed';
    _telnetUpdateTabDot(sid, '#888');
    // If the tab was closed intentionally, telnetCloseTab already deleted it
    // from state.sessions, so this won't fire.
    if (!state.sessions.has(sid)) return;
    const reason = session.lastDisconnectReason;
    session.lastDisconnectReason = null;
    if (wasError) return;
    // No telnet.status message ever arrived (bridge restart, network blip killed
    // the socket outright) — treat that as an unexpected drop, same as 'remote close'.
    if (state.settings.autoReconnect && (reason === 'remote close' || reason === undefined)) {
      _scheduleTelnetReconnect(sid);
    }
  };

  return ws;
}

const TELNET_RECONNECT_DELAYS_MS = [2000, 5000, 10000];

// Retries a dropped Telnet session onto its existing tab (sid). Only called
// for unexpected drops — see the reason check in _telnetConnectWs above.
function _scheduleTelnetReconnect(sid) {
  const session = state.sessions.get(sid);
  if (!session) return;
  const attempt = session.reconnectAttempt || 0;
  if (attempt >= TELNET_RECONNECT_DELAYS_MS.length) return;
  session.reconnectAttempt = attempt + 1;
  setTimeout(() => {
    const s = state.sessions.get(sid);
    if (!s) return; // tab was closed while we were waiting
    s.term.writeln('\r\n\x1b[33m[Reconnecting…]\x1b[0m');
    _telnetUpdateTabDot(sid, '#ffaa00');
    const ws = _telnetConnectWs(sid);
    if (ws) s.ws = ws;
  }, TELNET_RECONNECT_DELAYS_MS[attempt]);
}

function _telnetOpenSession(sid, name, host, port) {
  const container = document.createElement('div');
  container.className = 'telnet-xterm-container';
  container.style.cssText = 'width:100%;height:100%;display:none;';
  document.getElementById('telnetPool').appendChild(container);

  const term = new Terminal({
    fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
    fontSize: state.settings.sshFontSize || 14,
    theme: {
      background:  '#140e02',
      foreground:  '#e8d8b8',
      cursor:      '#d4a94a',
      black:       '#140e02',
      brightBlack: '#5a4a3a',
    },
    cursorBlink: true,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  const session = {
    ws: null, term, fitAddon, container, host, name, port,
    type: 'telnet', sid, state: 'connecting', reconnectAttempt: 0,
  };
  state.sessions.set(sid, session);
  session.ws = _telnetConnectWs(sid);

  term.onData(data => {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'telnet.data', data: btoa(data) }));
    }
  });

  _telnetAddTab(sid, name);
}

function _telnetAddTab(sid, name) {
  const tabs   = document.querySelector('.session-tabs');
  const addBtn = tabs.querySelector('.tab-add');
  const tab    = document.createElement('div');
  tab.className    = 'session-tab telnet-tab';
  tab.dataset.sid  = sid;
  tab.dataset.type = 'telnet';
  tab.innerHTML    = `<div class="tab-dot" style="background:#ffaa00;box-shadow:0 0 4px #ffaa00"></div>\u{1F4E1} ${esc(name)}<span class="tab-detach" onclick="detachTab(event,this)" title="Detach into its own window">⧉</span><span class="tab-close" onclick="telnetCloseTab(event,this)">&times;</span>`;
  tab.onclick = () => telnetActivateTab(sid);
  tabs.insertBefore(tab, addBtn);
  telnetActivateTab(sid);
}

function _telnetUpdateTabDot(sid, color) {
  const tab = document.querySelector(`.session-tab[data-sid="${sid}"]`);
  const dot = tab?.querySelector('.tab-dot');
  if (dot) { dot.style.background = color; dot.style.boxShadow = `0 0 4px ${color}`; }
}

export function telnetActivateTab(sid) {
  document.querySelectorAll('.session-tab').forEach(t => t.classList.remove('active'));
  const tab = document.querySelector(`.session-tab[data-sid="${sid}"]`);
  if (tab) tab.classList.add('active');

  const term3270    = document.getElementById('terminal');
  const telnetPane   = document.getElementById('telnetTerminal');
  const sshPane      = document.getElementById('sshTerminal');
  const ftpPane      = document.getElementById('ftpPane');
  if (term3270)   term3270.style.display  = 'none';
  if (sshPane)    sshPane.style.display   = 'none';
  if (ftpPane)    ftpPane.style.display   = 'none';
  if (telnetPane) telnetPane.style.display = 'flex';
  state.activeFtpSession = null;
  state.activeSshSession  = null;

  const session = state.sessions.get(sid);
  if (!session) return;
  if (telnetPane) {
    telnetPane.innerHTML = '';
    session.container.style.display = 'block';
    telnetPane.appendChild(session.container);
    try { session.fitAddon.fit(); } catch {}
    session.term.focus();
  }

  state.activeSession       = null;
  state.activeTelnetSession = sid;

  const oiaSys   = document.getElementById('oiaSys');
  const oiaLu    = document.getElementById('oiaLu');
  const oiaTls   = document.getElementById('oiaTls');
  const oiaModel = document.getElementById('oiaModel');
  const oiaApp   = document.getElementById('oiaApp');
  const oiaMode  = document.getElementById('oiaMode');
  if (oiaSys)   oiaSys.textContent   = session.host;
  if (oiaLu)    oiaLu.textContent    = '—';
  if (oiaTls)   oiaTls.textContent   = 'TELNET';
  if (oiaModel) oiaModel.textContent = '—';
  if (oiaApp)   { oiaApp.textContent = '—'; oiaApp.style.color = ''; }
  const connColor = session.state === 'connected' ? 'var(--accent-green)' : session.state === 'connecting' ? 'var(--accent-amber)' : 'var(--text-muted)';
  const dot = document.getElementById('mainConnDot');
  const txt = document.getElementById('connStatusText');
  if (dot) { dot.className = session.state === 'connected' ? 'conn-dot' : session.state === 'connecting' ? 'conn-dot connecting' : 'conn-dot disconnected'; }
  if (txt) { txt.textContent = session.name + (session.state === 'connected' ? ' · Connected' : session.state === 'connecting' ? ' · Connecting…' : ' · Disconnected'); txt.style.color = connColor; }
  if (oiaMode) {
    if (session.state === 'connected')       { oiaMode.textContent = 'TELNET CONNECTED';  oiaMode.className = 'oia-val blue'; }
    else if (session.state === 'connecting') { oiaMode.textContent = 'TELNET CONNECTING'; oiaMode.className = 'oia-val amber'; }
    else                                     { oiaMode.textContent = 'TELNET CLOSED';     oiaMode.className = 'oia-val'; }
  }
}

export function telnetCloseTab(e, closeBtn) {
  e.stopPropagation();
  const tab = closeBtn.closest('.session-tab');
  const sid = Number(tab.dataset.sid);
  const session = state.sessions.get(sid);
  if (session) {
    session.ws.send(JSON.stringify({ type: 'telnet.disconnect' }));
    session.ws.close();
    session.term.dispose();
    session.container.remove();
    state.sessions.delete(sid);
  }
  tab.remove();
  if (state.activeTelnetSession === sid) {
    state.activeTelnetSession = null;
    const term3270   = document.getElementById('terminal');
    const telnetPane = document.getElementById('telnetTerminal');
    if (term3270)   term3270.style.display   = '';
    if (telnetPane) telnetPane.style.display = 'none';
    setConnStatus('', 'disconnected');
    clearOiaFields();
    const remaining = document.querySelector('.session-tab');
    if (remaining) remaining.click();
  }
}

export function telnetFitActive() {
  if (state.activeTelnetSession == null) return;
  const session = state.sessions.get(state.activeTelnetSession);
  if (!session) return;
  try { session.fitAddon.fit(); } catch {}
  if (session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: 'telnet.resize', rows: session.term.rows, cols: session.term.cols }));
  }
}

export function telnetRenderSplitPane(sid) {
  const session  = state.sessions.get(sid);
  const pane     = document.getElementById('telnetTerminalSplit');
  const pane3270 = document.getElementById('terminal-split');
  if (!session || !pane) return;
  if (pane3270) pane3270.style.display = 'none';
  pane.style.display = 'flex';
  pane.innerHTML = '';
  session.container.style.display = 'block';
  pane.appendChild(session.container);
  try { session.fitAddon.fit(); } catch {}
}

export function telnetClearSplitPane() {
  const pane = document.getElementById('telnetTerminalSplit');
  if (pane) { pane.style.display = 'none'; pane.innerHTML = ''; }
  const pane3270 = document.getElementById('terminal-split');
  if (pane3270) pane3270.style.display = '';
}

export async function telnetSaveHost() {
  const statusEl = document.getElementById('telnetSaveHostStatus');
  const setStatus = (msg, ok) => { if (statusEl) { statusEl.textContent = msg; statusEl.style.color = ok ? '#3a9a6a' : '#c0392b'; } };
  const id   = document.getElementById('telnetNewId')?.value.trim();
  const name = document.getElementById('telnetNewName')?.value.trim();
  const host = document.getElementById('telnetNewHost')?.value.trim();
  const port = parseInt(document.getElementById('telnetNewPort')?.value) || 23;
  if (!id || !host) { setStatus('id and host are required.', false); return; }
  try {
    const res = await fetch('/api/telnet-hosts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: name || id, host, port }) });
    if (!res.ok) { const e = await res.json().catch(() => ({})); setStatus(e.error || `Save failed (${res.status}).`, false); return; }
    await telnetLoadHosts();
    const sel = document.getElementById('telnetHostSelect');
    if (sel) sel.value = id;
    setStatus(`Saved "${name || id}".`, true);
    ['telnetNewId', 'telnetNewName', 'telnetNewHost'].forEach(f => { const el = document.getElementById(f); if (el) el.value = ''; });
    const portEl = document.getElementById('telnetNewPort');
    if (portEl) portEl.value = '23';
  } catch (err) {
    setStatus(`Save failed: ${err.message}`, false);
  }
}

export function telnetEditHost() {
  const sel = document.getElementById('telnetHostSelect');
  const opt = sel?.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  const h = _telnetHosts.find(x => x.id === opt.value);
  if (!h) return;
  document.getElementById('telnetNewId').value   = h.id;
  document.getElementById('telnetNewName').value = h.name;
  document.getElementById('telnetNewHost').value = h.host;
  document.getElementById('telnetNewPort').value = h.port;
  const details = document.getElementById('telnetAddHostDetails');
  if (details) details.open = true;
  const statusEl = document.getElementById('telnetSaveHostStatus');
  if (statusEl) statusEl.textContent = '';
}

export async function telnetDeleteHost() {
  const sel = document.getElementById('telnetHostSelect');
  const opt = sel?.options[sel.selectedIndex];
  if (!opt || !opt.value) return;
  if (!confirm(`Delete "${opt.text.split('(')[0].trim()}"?`)) return;
  await fetch(`/api/telnet-hosts/${encodeURIComponent(opt.value)}`, { method: 'DELETE' });
  await telnetLoadHosts();
}

window.addEventListener('resize', telnetFitActive);

Object.assign(window, {
  openTelnetConnect, closeTelnetConnect, telnetHostChanged, telnetConnect, telnetConnectWith,
  telnetActivateTab, telnetCloseTab, telnetFitActive, telnetRenderSplitPane, telnetClearSplitPane,
  telnetSaveHost, telnetEditHost, telnetDeleteHost,
});
