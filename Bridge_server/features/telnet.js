// Interactive Telnet client — the raw-socket cousin of ssh.js. Telnet has
// no protocol-level auth (login happens inside the TTY stream itself, same
// as typing at a physical console), so this is just a TCP socket plus the
// minimum IAC option negotiation a real telnet client would do: agree to
// remote ECHO/SUPPRESS-GO-AHEAD (character-mode login prompts work right),
// answer TERMINAL-TYPE and NAWS when the far end asks, and refuse everything
// else with WONT/DONT. No encryption — plain Telnet never had any.
import net from 'net';

const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT = { ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31 };

// Byte-at-a-time IAC state machine. Chunks can split a sequence across
// reads, so state has to survive between feed() calls.
function makeNegotiator(sock, termType, cols, rows) {
  let state = 'data';
  let negVerb = 0;
  let sbBuf = [];

  const reply = bytes => { try { sock.write(Buffer.from(bytes)); } catch {} };

  function sendNaws(c, r) {
    reply([IAC, SB, OPT.NAWS, (c >> 8) & 0xff, c & 0xff, (r >> 8) & 0xff, r & 0xff, IAC, SE]);
  }

  function handleOption(verb, opt) {
    if (verb === DO) {
      if (opt === OPT.TTYPE) reply([IAC, WILL, OPT.TTYPE]);
      else if (opt === OPT.NAWS) { reply([IAC, WILL, OPT.NAWS]); sendNaws(cols, rows); }
      else if (opt === OPT.SGA) reply([IAC, WILL, OPT.SGA]);
      else reply([IAC, WONT, opt]);
    } else if (verb === DONT) {
      reply([IAC, WONT, opt]);
    } else if (verb === WILL) {
      if (opt === OPT.ECHO || opt === OPT.SGA) reply([IAC, DO, opt]);
      else reply([IAC, DONT, opt]);
    } else if (verb === WONT) {
      reply([IAC, DONT, opt]);
    }
  }

  function handleSubneg(bytes) {
    if (bytes[0] === OPT.TTYPE && bytes[1] === 1) {
      const term = Buffer.from(termType, 'ascii');
      reply([IAC, SB, OPT.TTYPE, 0, ...term, IAC, SE]);
    }
  }

  // Strips IAC negotiation out of chunk, returns the leftover plain bytes.
  function feed(chunk) {
    const dataOut = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (state === 'data') {
        if (b === IAC) state = 'iac';
        else dataOut.push(b);
      } else if (state === 'iac') {
        if (b === IAC) { dataOut.push(IAC); state = 'data'; }
        else if (b === SB) { state = 'sb'; sbBuf = []; }
        else if (b === DO || b === DONT || b === WILL || b === WONT) { negVerb = b; state = 'negopt'; }
        else { state = 'data'; }
      } else if (state === 'negopt') {
        handleOption(negVerb, b);
        state = 'data';
      } else if (state === 'sb') {
        if (b === IAC) state = 'sbIac';
        else sbBuf.push(b);
      } else if (state === 'sbIac') {
        if (b === SE) { handleSubneg(sbBuf); state = 'data'; }
        else if (b === IAC) { sbBuf.push(IAC); state = 'sb'; }
        else { state = 'sb'; }
      }
    }
    return Buffer.from(dataOut);
  }

  return {
    feed,
    resize(c, r) { cols = c; rows = r; sendNaws(c, r); },
  };
}

export function handleTelnetConnect(ws, wsId, params, send, logger) {
  const { host } = params;
  const port = parseInt(params.port, 10) || 23;
  if (!host) {
    send(ws, { type: 'telnet.error', message: 'host is required' });
    ws.close(); return;
  }
  const cols = parseInt(params.cols, 10) || 80;
  const rows = parseInt(params.rows, 10) || 24;

  logger.info(`[ws:${wsId}] Telnet → ${host}:${port}`);
  send(ws, { type: 'telnet.status', state: 'connecting' });

  let clientInitiated = false;
  const sock = net.connect({ host, port, timeout: 15000 });
  const neg = makeNegotiator(sock, 'xterm', cols, rows);

  sock.once('connect', () => {
    sock.setTimeout(0);
    logger.info(`[ws:${wsId}] Telnet connected`);
    send(ws, { type: 'telnet.status', state: 'connected' });
  });

  sock.on('data', chunk => {
    const data = neg.feed(chunk);
    if (data.length && ws.readyState === 1) {
      send(ws, { type: 'telnet.data', data: data.toString('base64') });
    }
  });

  sock.once('timeout', () => {
    send(ws, { type: 'telnet.error', message: 'connect timed out' });
    sock.destroy();
    ws.close();
  });

  sock.on('error', err => {
    logger.warn(`[ws:${wsId}] Telnet error: ${err.message}`);
    send(ws, { type: 'telnet.error', message: err.message });
    ws.close();
  });

  sock.on('close', () => {
    if (ws.readyState !== 1) return;
    const reason = clientInitiated ? 'client request' : 'remote close';
    send(ws, { type: 'telnet.status', state: 'disconnected', reason });
    ws.close();
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'telnet.data') {
      const bytes = Buffer.from(String(msg.data || ''), 'base64');
      const escaped = [];
      for (const b of bytes) { escaped.push(b); if (b === IAC) escaped.push(IAC); }
      try { sock.write(Buffer.from(escaped)); } catch {}
    } else if (msg.type === 'telnet.resize') {
      neg.resize(parseInt(msg.cols, 10) || 80, parseInt(msg.rows, 10) || 24);
    } else if (msg.type === 'telnet.disconnect') {
      clientInitiated = true;
      sock.end();
    }
  });

  ws.on('close', () => { clientInitiated = true; sock.destroy(); });
}
