import { expect, test } from "bun:test";
import { readBoundedBytes, verifyChecksum } from "../src/update.ts";

const bytes = new TextEncoder().encode("a VM Bridge build");
const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

test("accepts a download whose SHA-256 is the one SHA256SUMS lists for its file", () => {
  expect(() => verifyChecksum(bytes, `${"0".repeat(64)}  vmbridge-linux-x64\n${hash}  vmbridge-darwin-arm64\n`, "vmbridge-darwin-arm64")).not.toThrow();
});

test("refuses a changed download, and one the release lists no checksum for", () => {
  const changed = new TextEncoder().encode("a VM Bridge build, changed");
  expect(() => verifyChecksum(changed, `${hash}  vmbridge-darwin-arm64\n`, "vmbridge-darwin-arm64")).toThrow("does not match its checksum");
  // The right hash under another file's name does not vouch for this one.
  expect(() => verifyChecksum(bytes, `${hash}  vmbridge-linux-x64\n`, "vmbridge-darwin-arm64")).toThrow("no checksum for vmbridge-darwin-arm64");
});

test("readBoundedBytes returns streamed responses up to the byte limit", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.close();
    },
  });
  const result = await readBoundedBytes(new Response(stream, { headers: { "content-length": "5" } }), 5, "SHA256SUMS");
  expect([...result]).toEqual([1, 2, 3, 4, 5]);
});

test("readBoundedBytes rejects oversized Content-Length and oversized chunked streams and cancels the body", async () => {
  let headerCancelled = false;
  const headerStream = new ReadableStream<Uint8Array>({
    pull() {},
    cancel() {
      headerCancelled = true;
    },
  });
  await expect(
    readBoundedBytes(new Response(headerStream, { headers: { "content-length": "100" } }), 16, "SHA256SUMS"),
  ).rejects.toThrow("larger than expected");
  expect(headerCancelled).toBe(true);

  let streamCancelled = false;
  const chunked = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(10));
    },
    cancel() {
      streamCancelled = true;
    },
  });
  await expect(readBoundedBytes(new Response(chunked), 16, "vmbridge-darwin-arm64")).rejects.toThrow("larger than expected");
  expect(streamCancelled).toBe(true);
});
