import { describe, expect, test } from "bun:test";
import { ViewOnlyFilter } from "../src/watch/rfb.ts";

const enc = new TextEncoder();
const handshake38 = new Uint8Array([...enc.encode("RFB 003.008\n"), 1, 1]);
const frameRequest = new Uint8Array([3, 1, 0, 0, 0, 0, 4, 0, 3, 0]);
const setPixelFormat = new Uint8Array([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);

describe("ViewOnlyFilter", () => {
  test("rejects RFB 3.3 downgrade framing desync that smuggles a KeyEvent inside allowed messages", () => {
    // Under RFC 6143 §7.1.1, RFB 3.3 omits the client's 1-byte security-type selection, so byte 12 is
    // ClientInit (shared=1, which happens to equal securityNone=1) and byte 13 is the first client message
    // type (0x04 = KeyEvent). Without validating the 12-byte RFB 3.8 version, the filter shifts by 1 byte
    // and forwards the smuggled KeyEvent inside a SetPixelFormat payload.
    const smuggled = new Uint8Array([
      ...enc.encode("RFB 003.003\n"),
      1, // Server: ClientInit(shared=1); buggy filter: securityNone(1)
      4, // Server: KeyEvent opcode; buggy filter: ClientInit
      ...setPixelFormat, // Buggy filter: SetPixelFormat (20 bytes); Server: KeyEvent payload + more input
    ]);
    expect(new ViewOnlyFilter().push(smuggled)).toBeNull();
  });

  test("rejects RFB 3.3 and other non-3.8 versions even when split across chunks", () => {
    for (const version of ["RFB 003.003\n", "RFB 003.007\n", "RFB 004.000\n", "NOT 003.008\n"]) {
      const filter = new ViewOnlyFilter();
      const raw = new Uint8Array([...enc.encode(version), 1, 1]);
      let rejected = false;
      for (let i = 0; i < raw.length; i += 3) {
        if (filter.push(raw.subarray(i, i + 3)) === null) {
          rejected = true;
          break;
        }
      }
      expect(rejected).toBe(true);
    }
  });

  test("streams valid RFB 3.8 handshake incrementally byte-by-byte without stalling turn-taking", () => {
    const filter = new ViewOnlyFilter();
    const out: number[] = [];
    for (let i = 0; i < handshake38.length; i++) {
      const part = filter.push(handshake38.subarray(i, i + 1));
      expect(part).not.toBeNull();
      expect(part!.length).toBe(1);
      out.push(...part!);
    }
    expect(out).toEqual([...handshake38]);
    expect([...filter.push(frameRequest)!]).toEqual([...frameRequest]);
  });

  test("rejects non-None security type and exclusive ClientInit (shared = 0), and allows nonzero shared flags", () => {
    // Non-None security selection (e.g., VNC auth = 2) is rejected and latches rejection.
    const badSecurity = new Uint8Array([...enc.encode("RFB 003.008\n"), 2, 1]);
    const badSecurityFilter = new ViewOnlyFilter();
    expect(badSecurityFilter.push(badSecurity)).toBeNull();
    expect(badSecurityFilter.push(handshake38)).toBeNull();

    // Full handshake with shared = 0 is rejected outright and never forwarded.
    const exclusive = new Uint8Array([...enc.encode("RFB 003.008\n"), 1, 0]);
    expect(new ViewOnlyFilter().push(exclusive)).toBeNull();

    // Split right before ClientInit: the 0 byte is rejected, never forwarded, and latches rejection.
    const split = new ViewOnlyFilter();
    expect([...split.push(exclusive.subarray(0, 13))!]).toEqual([...exclusive.subarray(0, 13)]);
    expect(split.push(exclusive.subarray(13, 14))).toBeNull();
    expect(split.push(frameRequest)).toBeNull();

    // Per RFC 6143 §7.3.1, any nonzero shared-flag byte requests shared access.
    for (const shared of [1, 2, 0xff]) {
      const filter = new ViewOnlyFilter();
      const valid = new Uint8Array([...enc.encode("RFB 003.008\n"), 1, shared]);
      expect([...filter.push(valid)!]).toEqual([...valid]);
      expect([...filter.push(frameRequest)!]).toEqual([...frameRequest]);
    }
  });

  test("rejects oversized ClientFence immediately when split header completes and latches rejection", () => {
    const okFilter = new ViewOnlyFilter();
    expect(okFilter.push(handshake38)).not.toBeNull();
    const validFence = new Uint8Array([248, 0, 0, 0, 0, 0, 0, 1, 64, ...new Uint8Array(64).fill(0x41)]);
    expect([...okFilter.push(validFence)!]).toEqual([...validFence]);

    const splitFilter = new ViewOnlyFilter();
    expect(splitFilter.push(handshake38)).not.toBeNull();
    // Send first 5 bytes of the 9-byte ClientFence header; wait for the rest without forwarding.
    const partial = splitFilter.push(new Uint8Array([248, 0, 0, 0, 0]));
    expect(partial).not.toBeNull();
    expect(partial!.length).toBe(0);
    // Completing the 9-byte header with length = 65 rejects immediately without waiting for payload.
    expect(splitFilter.push(new Uint8Array([0, 0, 1, 65]))).toBeNull();
    // Rejection is latched so a subsequent valid FramebufferUpdateRequest is also rejected.
    expect(splitFilter.push(frameRequest)).toBeNull();
  });
});
