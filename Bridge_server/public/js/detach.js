// ── js/detach.js — receiving side of "detach tab to its own window".
// detachTab() in tabs.js opens this same page with ?detached=1 and hands
// off a reconnect payload over postMessage once this window signals it's
// ready. There's no server-side session to resume (handlers/ws.js treats
// each browser WebSocket as the session), so this reconnects fresh with
// the handed-off profile/host/credentials rather than continuing one.
const params = new URLSearchParams(location.search);

if (params.get('detached') === '1' && window.opener) {
  const bar = document.querySelector('.session-tabs');
  if (bar) {
    const tag = document.createElement('div');
    tag.textContent = '⧉ DETACHED';
    tag.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.08em;color:var(--accent-cyan);padding:0 10px;flex-shrink:0;';
    bar.insertBefore(tag, bar.firstChild);
  }

  window.addEventListener('message', ev => {
    if (ev.source !== window.opener || ev.origin !== location.origin) return;
    if (ev.data?.type !== 'detach-init') return;
    const p = ev.data.payload || {};
    if (p.kind === '3270')    window.openSession?.(p.profile);
    else if (p.kind === 'ssh') window.sshConnectWith?.(p);
    else if (p.kind === 'ftp') window.ftpConnectWith?.(p);
    else if (p.kind === 'telnet') window.telnetConnectWith?.(p);
  }, { once: true });

  try { window.opener.postMessage({ type: 'detach-ready' }, location.origin); } catch {}
}
