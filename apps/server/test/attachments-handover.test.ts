import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import { Attachments } from "../src/gateway/attachments.ts";
import type { Wire } from "../src/gateway/types.ts";
import type { Backend } from "../src/vm/backend.ts";

function fakeBackend() {
  const calls: string[] = [];
  const uploads: { path: string; bytes: Uint8Array }[] = [];
  let minted = 0;
  const backend = {
    call: async (tag: string) => {
      calls.push(tag);
      minted++;
      return { attachmentId: `pending-00000000-0000-4000-8000-00000000000${minted}`, relativeUrl: `/api/attachments/upload/vmtoken${minted}`, expiresAt: 1 } satisfies Wire;
    },
    http: async (path: string, init: RequestInit = {}) => {
      uploads.push({ path, bytes: new Uint8Array(await new Response(init.body).arrayBuffer()) });
      return new Response(null, { status: 204 });
    },
  } as unknown as Backend;
  return { backend, calls, uploads };
}

async function uploadPending(attachments: Attachments, name: string, bytes: Uint8Array) {
  const minted = attachments.mint({ type: "file", name, mimeType: "text/plain", sizeBytes: bytes.byteLength }, "c1");
  const token = minted.relativeUrl.slice("/api/attachments/upload/".length);
  expect((await attachments.receive(token, new Request("http://bridge", { method: "POST", body: bytes }))).status).toBe(204);
  return minted.attachmentId;
}

describe("concurrent attachment handovers", () => {
  test("uploads an attachment to the same VM once and rejects another VM", async () => {
    const db = openDatabase(":memory:");
    try {
      const attachments = new Attachments(db);
      const vm1 = fakeBackend();
      const vm2 = fakeBackend();
      let releaseUpload!: () => void;
      const uploadGate = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      const originalHttp = vm1.backend.http;
      vm1.backend.http = async (path: string, init?: RequestInit) => {
        await uploadGate;
        return originalHttp(path, init);
      };

      const data = new TextEncoder().encode("same-attachment");
      const id = await uploadPending(attachments, "a.txt", data);
      const payload = { attachments: [{ id }] };

      const first = attachments.handOver(payload, "vm1", vm1.backend);
      const second = attachments.handOver(payload, "vm1", vm1.backend);
      const otherVm = attachments.handOver(payload, "vm2", vm2.backend);
      const otherVmError = otherVm.catch((error: unknown) => error);
      releaseUpload();

      const [r1, r2, err] = await Promise.all([first, second, otherVmError]);
      expect(r1).toEqual(r2);
      expect(r1.attachments[0]!.id).not.toBe(id);
      expect(vm1.uploads).toHaveLength(1);
      expect(vm1.calls).toEqual(["attachments.createUploadUrl"]);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("went to another VM");
      expect(vm2.uploads).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("a failed handover rejects joined callers and lets a waiting VM upload once, while remove stops later joins", async () => {
    const db = openDatabase(":memory:");
    try {
      const attachments = new Attachments(db);
      const vm1 = fakeBackend();
      const vm2 = fakeBackend();
      let releaseFail!: () => void;
      const failGate = new Promise<void>((resolve) => {
        releaseFail = resolve;
      });
      vm1.backend.http = async () => {
        await failGate;
        return new Response("upstream error", { status: 500 });
      };

      const data = new TextEncoder().encode("retry-body");
      const id = await uploadPending(attachments, "r.txt", data);
      const payload = { attachments: [{ id }] };

      const a = attachments.handOver(payload, "vm1", vm1.backend);
      const b = attachments.handOver(payload, "vm1", vm1.backend);
      const fallbackVm = attachments.handOver(payload, "vm2", vm2.backend);
      const aError = a.catch((error: unknown) => error);
      const bError = b.catch((error: unknown) => error);
      releaseFail();

      const [errA, errB, handed] = await Promise.all([aError, bError, fallbackVm]);
      expect(errA).toBeInstanceOf(Error);
      expect((errA as Error).message).toContain("refused attachment");
      expect(errB).toBeInstanceOf(Error);
      expect((errB as Error).message).toContain("refused attachment");
      expect(handed.attachments[0]!.id).not.toBe(id);
      expect(vm2.uploads).toHaveLength(1);
      expect(vm2.uploads[0]!.bytes).toEqual(data);

      // Deleting an upload while a transfer is in flight prevents a later send from joining it.
      let markPostStarted!: () => void;
      const postStarted = new Promise<void>((resolve) => {
        markPostStarted = resolve;
      });
      let releaseDeleted!: () => void;
      const deletedGate = new Promise<void>((resolve) => {
        releaseDeleted = resolve;
      });
      const originalVm2Http = vm2.backend.http;
      vm2.backend.http = async (path: string, init?: RequestInit) => {
        markPostStarted();
        await deletedGate;
        return originalVm2Http(path, init);
      };
      const doomedId = await uploadPending(attachments, "d.txt", data);
      const doomedPayload = { attachments: [{ id: doomedId }] };
      const inFlight = attachments.handOver(doomedPayload, "vm2", vm2.backend);
      await postStarted;
      attachments.remove(doomedId);
      const afterRemove = await attachments.handOver(doomedPayload, "vm2", vm2.backend);
      expect(afterRemove).toEqual(doomedPayload);
      releaseDeleted();
      await inFlight;
    } finally {
      db.close();
    }
  });
});
