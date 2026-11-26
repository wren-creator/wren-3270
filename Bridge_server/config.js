/**
 * config.js
 * ─────────────────────────────────────────────────────────────────
 * All runtime configuration for the Wren/3270 bridge.
 * Values can be overridden via environment variables.
 */

import fs from 'fs';
import path from 'path';
import { getAppRoot } from './app-paths.js';

const __dirname = getAppRoot();

// ── Parse a single ssh-hosts file into profile objects ────────────
function parseSshHostsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => {
      const parts = line.split(',').map(s => s.trim());
      const [id, name, host, port, user] = parts;
      if (!id) return null;
      return { id, name: name || id, host: host || id, port: parseInt(port || '22', 10), user: user || '' };
    })
    .filter(Boolean);
}

// ── Load SSH host profiles — merges shipped defaults + user file ──
// ssh-hosts.shipped.txt: tracked in git, built-in demo hosts
// ssh-hosts.txt:         gitignored, user's private hosts (bind-mounted in Docker)
// User entries with the same id override shipped entries.
function loadSshHostsFile() {
  const skipShipped = process.env.BRIDGE_SKIP_SHIPPED_PROFILES === 'true';
  const shipped = skipShipped ? [] : parseSshHostsFile(path.join(__dirname, 'ssh-hosts.shipped.txt'));
  const user    = parseSshHostsFile(path.join(__dirname, 'ssh-hosts.txt'));

  // User entries override shipped entries with the same id
  const userIds = new Set(user.map(p => p.id));
  return [...shipped.filter(p => !userIds.has(p.id)), ...user];
}

// ── Parse a single ftp-hosts file into profile objects ────────────
function parseFtpHostsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => {
      const parts = line.split(',').map(s => s.trim());
      const [id, name, host, port, user, secure] = parts;
      if (!id) return null;
      return {
        id, name: name || id, host: host || id,
        port: parseInt(port || '21', 10), user: user || '',
        secure: ['explicit', 'implicit'].includes(secure) ? secure : 'none',
      };
    })
    .filter(Boolean);
}

// ── Load FTP host profiles — merges shipped defaults + user file ──
// ftp-hosts.shipped.txt: tracked in git, built-in demo hosts
// ftp-hosts.txt:         gitignored, user's private hosts (bind-mounted in Docker)
// User entries with the same id override shipped entries.
function loadFtpHostsFile() {
  const skipShipped = process.env.BRIDGE_SKIP_SHIPPED_PROFILES === 'true';
  const shipped = skipShipped ? [] : parseFtpHostsFile(path.join(__dirname, 'ftp-hosts.shipped.txt'));
  const user    = parseFtpHostsFile(path.join(__dirname, 'ftp-hosts.txt'));

  const userIds = new Set(user.map(p => p.id));
  return [...shipped.filter(p => !userIds.has(p.id)), ...user];
}

// ── Parse a single telnet-hosts file into profile objects ─────────
function parseTelnetHostsFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => {
      const parts = line.split(',').map(s => s.trim());
      const [id, name, host, port] = parts;
      if (!id) return null;
      return { id, name: name || id, host: host || id, port: parseInt(port || '23', 10) };
    })
    .filter(Boolean);
}

// ── Load Telnet host profiles — merges shipped defaults + user file ──
// telnet-hosts.shipped.txt: tracked in git, built-in demo hosts
// telnet-hosts.txt:         gitignored, user's private hosts (bind-mounted in Docker)
// User entries with the same id override shipped entries.
function loadTelnetHostsFile() {
  const skipShipped = process.env.BRIDGE_SKIP_SHIPPED_PROFILES === 'true';
  const shipped = skipShipped ? [] : parseTelnetHostsFile(path.join(__dirname, 'telnet-hosts.shipped.txt'));
  const user    = parseTelnetHostsFile(path.join(__dirname, 'telnet-hosts.txt'));

  const userIds = new Set(user.map(p => p.id));
  return [...shipped.filter(p => !userIds.has(p.id)), ...user];
}

// ── Parse a single lpars file into profile objects ────────────────
function parseLparFile(filePath, source) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .map(line => {
      const parts = line.split(',').map(s => s.trim());
      const [id, name, host, port, tls, type, model] = parts;
      if (!id) return null;
      // protocol and tlsServername are appended as optional trailing fields
      // so existing lpars.txt/lpars.shipped.txt lines keep working unchanged
      // — protocol absent means '3270', tlsServername absent means "verify
      // the TLS cert against whatever's in the host column".
      // tlsServername matters when host is an IP but the cert's SAN list
      // only has DNS names (the usual case with IP-addressed lpars.txt
      // entries and hostname-issued certs) — it dials the IP but checks
      // the cert against this name instead.
      const protocol = (parts[8] || '3270').toLowerCase();
      return {
        id,
        name: name || id.toUpperCase(),
        host: host || id,
        port: parseInt(port || '23', 10),
        tls: (tls || 'false') === 'true',
        type: (type || 'TSO').toUpperCase(),
        protocol,
        model: model || process.env.DEFAULT_MODEL || (protocol === '5250' ? '3179-2' : '3278-2'),
        codepage: 37,
        tn3270e: parts[7] !== undefined ? parts[7] === 'true' : true,
        tlsServername: parts[9] || undefined,
        source,
      };
    })
    .filter(Boolean);
}

// ── Load session profiles — merges shipped defaults + user file ──
// lpars.shipped.txt: tracked in git, built-in demo connections
// lpars.txt:         gitignored, user's private connections
// User entries with the same id override shipped entries.
function loadLparFile() {
  const shippedPath = path.join(__dirname, 'lpars.shipped.txt');
  const userPath    = path.join(__dirname, 'lpars.txt');
  const skipShipped = process.env.BRIDGE_SKIP_SHIPPED_PROFILES === 'true';

  const shipped = skipShipped ? [] : parseLparFile(shippedPath, 'shipped');
  const user    = parseLparFile(userPath,    'user');

  if (shipped.length === 0 && user.length === 0) {
    console.warn('[config] No session profiles found in lpars.shipped.txt or lpars.txt');
  }

  // User entries override shipped entries with the same id
  const userIds = new Set(user.map(p => p.id));
  return [...shipped.filter(p => !userIds.has(p.id)), ...user];
}

export default {
  bridge: {
    port: parseInt(process.env.BRIDGE_PORT || '8081', 10),
    // Docker/OpenShift need 0.0.0.0 explicitly (see their env blocks) so the
    // container's mapped port is reachable from the host; a native process
    // serving only the local user's own browser is more correct bound to
    // loopback, and it skips an avoidable Windows Firewall prompt.
    host: process.env.BRIDGE_HOST || '127.0.0.1',
    verifyTls: process.env.BRIDGE_VERIFY_TLS !== 'false',
    socketTimeoutMs: parseInt(process.env.BRIDGE_SOCKET_TIMEOUT_MS || '300000', 10),
    maxSessions: parseInt(process.env.BRIDGE_MAX_SESSIONS || '100', 10),
    corsOrigin: process.env.BRIDGE_CORS_ORIGIN || '*',
    // Hosted webterm-3270.com deployment only. Leave unset for the
    // self-hosted deployment — it has no account system and
    // stays on the shared config.securityPassword gate instead of
    // per-account sku tiers (handlers/ws.js).
    multiTenant: process.env.BRIDGE_MULTI_TENANT === 'true',
  },

  defaults: {
    model: process.env.DEFAULT_MODEL || '3278-5',
    codepage: parseInt(process.env.DEFAULT_CODEPAGE || '37', 10),
  },

  profiles: loadLparFile(),
  sshHosts: loadSshHostsFile(),
  ftpHosts: loadFtpHostsFile(),
  telnetHosts: loadTelnetHostsFile(),

  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  loadLparFile,
  loadSshHostsFile,
  loadFtpHostsFile,
  loadTelnetHostsFile,

  securityPassword: process.env.SECURITY_TOOLS_PASSWORD || '2970',

  macroSecurityFile: process.env.MACRO_SECURITY_FILE ||
    path.join(__dirname, 'macros-security.json'),
};
// @iplxec
