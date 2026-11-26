import http from 'http';
import { exec } from 'child_process';
import { WebSocketServer } from 'ws';
import * as Ebcdic from './tn3270/ebcdic.js';

import config from './config.js';
import logger from './logger.cjs';

import { createRequestHandler } from './handlers/http.js';
import { createWsHandler }      from './handlers/ws.js';

const sessions = new Map();

const httpServer = http.createServer(
  createRequestHandler({ config, logger, sessions })
);

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', createWsHandler({ config, logger, sessions, Ebcdic }));

httpServer.listen(config.bridge.port, config.bridge.host, () => {
  logger.info('─────────────────────────────────────────────────────');
  logger.info(`  Wren/3270 bridge ready`);
  logger.info(`  Client (production) → http://localhost:${config.bridge.port}`);
  logger.info(`  Client (demo)       → http://localhost:${config.bridge.port}/demo`);
  logger.info(`  API profiles        → http://localhost:${config.bridge.port}/api/profiles`);
  logger.info(`  WebSocket bridge    → ws://localhost:${config.bridge.port}`);
  logger.info('─────────────────────────────────────────────────────');

  // Packaged Windows exe only: there's no docker-compose output or terminal
  // the user is already watching, so open the client for them. Gated on
  // win32 alone — Docker/OpenShift are always Linux, so this never fires
  // there; BRIDGE_NO_OPEN is a cheap escape hatch for debugging.
  if (process.platform === 'win32' && !process.env.BRIDGE_NO_OPEN) {
    exec(`start "" "http://127.0.0.1:${config.bridge.port}"`);
  }
});

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

function shutdown() {
  logger.info('Shutting down — closing all sessions…');
  for (const [, session] of sessions) session.disconnect('server shutdown');
  wss.close(() => { logger.info('Bridge stopped.'); process.exit(0); });
}
