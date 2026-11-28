import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/bun/sqlite.ts";
import { SkillError, Skills } from "../src/skills.ts";
import { testEncryption } from "./key.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = handler as typeof fetch;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const skillMd = { path: "SKILL.md", contents: "---\nname: notes\ndescription: From skills.sh.\n---\n" };

describe("skills.sh installs and search", () => {
  test("installs a valid skill from skills.sh", async () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    mockFetch(() => jsonResponse({ files: [skillMd, { path: "docs/guide.md", contents: "hello" }] }));

    expect(await skills.installFromSkillsSh("acme/skills", "notes")).toBe(true);
    expect(skills.list()).toEqual([
      expect.objectContaining({ name: "notes", source: "skills.sh", ref: "acme/skills", description: "From skills.sh." }),
    ]);
    expect(skills.files("notes").map((file) => file.path)).toEqual(["SKILL.md", "docs/guide.md"]);
  });

  test("allows a 1 MB skill whose \\uXXXX-escaped JSON exceeds 4 MB while keeping the 1 MB decoded cap", async () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    const skillMdBytes = Buffer.byteLength(skillMd.contents, "utf8");
    const exactFit = "\u0000".repeat(1024 * 1024 - skillMdBytes);
    const encoded = JSON.stringify({ files: [skillMd, { path: "escaped.txt", contents: exactFit }] });
    expect(Buffer.byteLength(encoded, "utf8")).toBeGreaterThan(4 * 1024 * 1024);

    mockFetch(() => new Response(encoded, { headers: { "content-type": "application/json" } }));
    expect(await skills.installFromSkillsSh("acme/skills", "notes")).toBe(true);
    const saved = skills.files("notes").find((file) => file.path === "escaped.txt");
    expect(Buffer.from(saved!.data, "base64").byteLength).toBe(1024 * 1024 - skillMdBytes);

    const oneByteOver = JSON.stringify({ files: [skillMd, { path: "escaped.txt", contents: `${exactFit}\u0000` }] });
    mockFetch(() => new Response(oneByteOver, { headers: { "content-type": "application/json" } }));
    await expect(skills.installFromSkillsSh("acme/skills", "notes")).rejects.toThrow(/larger than 1 MB/);
  });

  test("rejects oversized, too many, duplicate, and invalid files from skills.sh with SkillError", async () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    const cases: { name: string; response: () => Response; pattern: RegExp }[] = [
      {
        name: "total size over 1 MB",
        response: () => jsonResponse({ files: [skillMd, { path: "big.txt", contents: "x".repeat(1024 * 1024) }] }),
        pattern: /larger than 1 MB/,
      },
      {
        name: "content-length over download cap",
        response: () => new Response("{}", { headers: { "content-length": String(7 * 1024 * 1024) } }),
        pattern: /too large/,
      },
      {
        name: "streamed body over download cap without content-length",
        response: () => {
          let sent = 0;
          const chunk = new Uint8Array(1024 * 1024);
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent >= 7) controller.close();
                else {
                  sent++;
                  controller.enqueue(chunk);
                }
              },
            }),
          );
        },
        pattern: /too large/,
      },
      {
        name: "invalid UTF-8 bytes in JSON body",
        response: () =>
          new Response(
            new Uint8Array([
              ...Buffer.from('{"files":[{"path":"SKILL.md","contents":"'),
              0xff,
              0xfe,
              ...Buffer.from('"}]}'),
            ]),
            { headers: { "content-type": "application/json" } },
          ),
        pattern: /invalid UTF-8/,
      },
      {
        name: "more than 100 files",
        response: () => jsonResponse({ files: [skillMd, ...Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.txt`, contents: "x" }))] }),
        pattern: /more than 100 files/,
      },
      {
        name: "duplicate file path",
        response: () => jsonResponse({ files: [skillMd, skillMd] }),
        pattern: /SKILL\.md twice/,
      },
      {
        name: "file and folder clash",
        response: () => jsonResponse({ files: [skillMd, { path: "docs", contents: "x" }, { path: "docs/a.md", contents: "x" }] }),
        pattern: /both a file and a folder/,
      },
      {
        name: "invalid path with control char",
        response: () => jsonResponse({ files: [skillMd, { path: "line\nbreak", contents: "x" }] }),
        pattern: /outside its folder or with an unusable name/,
      },
      {
        name: "missing files array",
        response: () => jsonResponse({}),
        pattern: /unusable response/,
      },
    ];

    for (const entry of cases) {
      mockFetch(() => entry.response());
      let thrown: unknown;
      try {
        await skills.installFromSkillsSh("acme/skills", "notes");
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.name).toBeInstanceOf(SkillError);
      expect((thrown as Error).message, entry.name).toMatch(entry.pattern);
    }
    expect(skills.list()).toEqual([]);
  });

  test("rejects skills.sh install and preserves upload when upload claims the name mid-fetch", async () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    let resolveFetch!: (response: Response) => void;
    mockFetch(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));

    const pending = skills.installFromSkillsSh("acme/skills", "notes");
    // Upload claims "notes" while the skills.sh download is still in flight.
    skills.installUpload("notes", [{ path: "SKILL.md", data: Buffer.from("---\nname: notes\ndescription: Uploaded.\n---\n").toString("base64") }]);

    let changesAfterUpload = 0;
    skills.on("changed", () => changesAfterUpload++);

    resolveFetch(jsonResponse({ files: [skillMd] }));
    let thrown: unknown;
    try {
      await pending;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SkillError);
    expect((thrown as Error).message).toContain("already installed from an upload");
    expect(changesAfterUpload).toBe(0);
    expect(skills.list()).toEqual([
      expect.objectContaining({ name: "notes", source: "upload", ref: "", description: "Uploaded." }),
    ]);
    expect(Buffer.from(skills.files("notes")[0]!.data, "base64").toString("utf8")).toContain("Uploaded.");
  });

  test("rejects second concurrent skills.sh install from a different repo for the same skillId", async () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    const resolvers: ((response: Response) => void)[] = [];
    mockFetch(() => new Promise<Response>((resolve) => { resolvers.push(resolve); }));

    const first = skills.installFromSkillsSh("acme/one", "notes");
    const second = skills.installFromSkillsSh("acme/two", "notes");

    resolvers[0]!(jsonResponse({ files: [{ path: "SKILL.md", contents: "---\nname: notes\ndescription: From one.\n---\n" }] }));
    expect(await first).toBe(true);

    resolvers[1]!(jsonResponse({ files: [{ path: "SKILL.md", contents: "---\nname: notes\ndescription: From two.\n---\n" }] }));
    let thrown: unknown;
    try {
      await second;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SkillError);
    expect((thrown as Error).message).toContain("already installed from acme/one");
    expect(skills.list()).toEqual([
      expect.objectContaining({ name: "notes", source: "skills.sh", ref: "acme/one", description: "From one." }),
    ]);
  });

  test("search returns [] when skills is missing or invalid, and maps valid results", async () => {
    const skills = new Skills(openDatabase(":memory:"), testEncryption);
    for (const payload of [{}, null, { skills: null }, { skills: "bad" }]) {
      mockFetch(() => jsonResponse(payload));
      expect(await skills.search("notes")).toEqual([]);
    }

    mockFetch(() =>
      jsonResponse({
        skills: [
          null,
          { source: "bad", skillId: "notes" },
          { source: "acme/skills", skillId: "../evil" },
          { source: "acme/skills", skillId: "notes", name: "Notes", installs: 42 },
          { source: "acme/skills", skillId: "plain" },
        ],
      }),
    );
    expect(await skills.search("notes")).toEqual([
      { source: "acme/skills", skillId: "notes", name: "Notes", installs: 42 },
      { source: "acme/skills", skillId: "plain", name: "plain", installs: 0 },
    ]);
  });
});
