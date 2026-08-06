// Minimal RFC 6455 WebSocket server.
//
// Why hand-rolled instead of `ws`: this repo's whole premise is that you can
// clone it and run a working agent with bare Node and no install step. A
// telephony gateway that needs `npm install` before it can answer a call
// breaks that. The protocol surface we actually need is small — text and
// binary frames, ping/pong, close — and that's what's here.
//
// Not implemented (deliberately, we don't need them): extensions,
// permessage-deflate, subprotocol negotiation. If you ever do, switch to
// `ws` rather than growing this.

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = {
  CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa,
};

/**
 * Attaches WebSocket upgrade handling to an existing http.Server.
 * `onConnection(socket, request)` fires with a WebSocketConnection.
 */
export function attachWebSocket(server, onConnection, { path = null } = {}) {
  server.on("upgrade", (req, socket, head) => {
    if (path && new URL(req.url, "http://x").pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      return socket.destroy();
    }

    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const conn = new WebSocketConnection(socket);
    if (head?.length) conn._ingest(head);
    onConnection(conn, req);
  });
  return server;
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOp = null;

    socket.on("data", (c) => this._ingest(c));
    socket.on("close", () => this._finish());
    socket.on("error", (e) => { this.emit("error", e); this._finish(); });

    // Keepalive: telephony media sessions sit idle between utterances and
    // intermediaries will drop a silent TCP connection.
    this._ping = setInterval(() => { if (!this.closed) this.ping(); }, 20000);
    this._ping.unref?.();
  }

  _ingest(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this._buf.length >= 2) {
      const frame = decodeFrame(this._buf);
      if (!frame) break; // need more bytes
      this._buf = this._buf.subarray(frame.size);
      this._handle(frame);
    }
  }

  _handle({ fin, opcode, payload }) {
    switch (opcode) {
      case OPCODE.PING: return this._send(OPCODE.PONG, payload);
      case OPCODE.PONG: return;
      case OPCODE.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this._send(OPCODE.CLOSE, payload.subarray(0, 2));
        this.emit("close", code);
        return this._finish();
      }
      case OPCODE.CONT:
        this._fragments.push(payload);
        if (!fin) return;
        return this._deliver(this._fragmentOp, Buffer.concat(this._fragments));
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (!fin) { this._fragmentOp = opcode; this._fragments = [payload]; return; }
        return this._deliver(opcode, payload);
    }
  }

  _deliver(opcode, payload) {
    this._fragments = []; this._fragmentOp = null;
    if (opcode === OPCODE.TEXT) {
      const text = payload.toString("utf8");
      this.emit("message", text, false);
      let parsed;
      try { parsed = JSON.parse(text); } catch { /* not JSON, fine */ }
      if (parsed !== undefined) this.emit("json", parsed);
    } else {
      this.emit("message", payload, true);
      this.emit("binary", payload);
    }
  }

  _send(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return false;
    try { return this.socket.write(encodeFrame(opcode, payload)); }
    catch { return false; }
  }

  send(data) {
    return Buffer.isBuffer(data)
      ? this._send(OPCODE.BINARY, data)
      : this._send(OPCODE.TEXT, Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8"));
  }

  sendJson(obj) { return this._send(OPCODE.TEXT, Buffer.from(JSON.stringify(obj), "utf8")); }
  sendBinary(buf) { return this._send(OPCODE.BINARY, buf); }
  ping() { return this._send(OPCODE.PING, randomBytes(4)); }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const r = Buffer.from(reason, "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._send(OPCODE.CLOSE, p);
    setTimeout(() => this._finish(), 100).unref?.();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._ping);
    try { this.socket.destroy(); } catch { /* already gone */ }
    this.emit("disconnected");
  }
}

// --- framing ---------------------------------------------------------------

/** Returns { fin, opcode, payload, size } or null when more bytes are needed. */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off); off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off); off += 8;
    // A frame larger than 64MB on a telephony stream means something is
    // wrong upstream; refuse rather than allocate it.
    if (big > 67108864n) throw new Error("websocket frame too large");
    len = Number(big);
  }

  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4); off += 4;
  }

  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

  return { fin, opcode, payload, size: off + len };
}

/** Server-to-client frames are never masked, per spec. */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}
