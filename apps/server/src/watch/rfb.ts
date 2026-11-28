/**
 * The RFB (VNC) bytes a watch page may send to the screen. Kubi drops input on view-only sessions already; this keeps
 * it from ever reaching Kubi, should that change. A view-only client sends the handshake and asks for frames, which
 * pass. It also offers its clipboard, which is dropped. Anything else, input included, ends the stream instead of
 * being skipped over: guessing at the length of a message it does not know would lose its place in the stream.
 *
 * The handshake is RFB 3.8 with no VNC security (Kubi's ticket opens the socket): the client's 12-byte version, the
 * one-byte security type, which must be None (1), and the one-byte ClientInit, which must be shared (nonzero).
 */

const rfbVersion = new TextEncoder().encode("RFB 003.008\n");
const securityNone = 1;
const handshakeBytes = rfbVersion.length + 2;
/** More clipboard than a viewer has reason to send. */
const maxClipboardBytes = 1024 * 1024;
/** RFB Fence extension caps payload length at 64 bytes. */
const maxFenceBytes = 64;

interface Message {
  /** Bytes needed to know the message's length. */
  header: number;
  /** The length of the whole message, or null when it is too long to accept. */
  length: (view: DataView, at: number) => number | null;
  /** Dropped instead of passed on. */
  drop?: true;
}

/** Client messages a viewer sends, by type. */
const known: Record<number, Message> = {
  // SetPixelFormat
  0: { header: 1, length: () => 20 },
  // SetEncodings: a count, then 4 bytes per encoding.
  2: { header: 4, length: (view, at) => 4 + 4 * view.getUint16(at + 2) },
  // FramebufferUpdateRequest
  3: { header: 1, length: () => 10 },
  // ClientCutText: noVNC offers its clipboard on connect. A negative length is the extended clipboard's.
  6: {
    header: 8,
    length: (view, at) => {
      const size = Math.abs(view.getInt32(at + 4));
      return size <= maxClipboardBytes ? 8 + size : null;
    },
    drop: true,
  },
  // EnableContinuousUpdates
  150: { header: 1, length: () => 10 },
  // ClientFence: flags, then a payload of at most 64 bytes.
  248: {
    header: 9,
    length: (view, at) => {
      const size = view.getUint8(at + 8);
      return size <= maxFenceBytes ? 9 + size : null;
    },
  },
};

export class ViewOnlyFilter {
  private pending = new Uint8Array(0);
  /** Handshake bytes validated and passed so far. */
  private handshakeOffset = 0;
  private rejected = false;

  private fail(): null {
    this.rejected = true;
    this.pending = new Uint8Array(0);
    return null;
  }

  /** The bytes to pass on to the screen, or null when the client sent something a viewer never sends. */
  push(chunk: Uint8Array): Uint8Array | null {
    if (this.rejected) return null;
    const data = new Uint8Array(this.pending.length + chunk.length);
    data.set(this.pending);
    data.set(chunk, this.pending.length);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const passed: Uint8Array[] = [];
    let at = 0;
    if (this.handshakeOffset < handshakeBytes) {
      const taken = Math.min(handshakeBytes - this.handshakeOffset, data.length);
      for (let i = 0; i < taken; i++) {
        const pos = this.handshakeOffset + i;
        if (pos < rfbVersion.length) {
          if (data[i] !== rfbVersion[pos]) return this.fail();
        } else if (pos === rfbVersion.length) {
          if (data[i] !== securityNone) return this.fail();
        } else if (data[i] === 0) {
          return this.fail();
        }
      }
      this.handshakeOffset += taken;
      passed.push(data.subarray(0, taken));
      at = taken;
    }
    while (at < data.length) {
      const message = known[data[at]!];
      if (!message) return this.fail();
      if (data.length - at < message.header) break;
      const length = message.length(view, at);
      if (length === null) return this.fail();
      if (data.length - at < length) break;
      if (!message.drop) passed.push(data.subarray(at, at + length));
      at += length;
    }
    this.pending = data.slice(at);
    const out = new Uint8Array(passed.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of passed) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}
