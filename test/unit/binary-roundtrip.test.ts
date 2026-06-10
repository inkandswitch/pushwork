/**
 * Binary content round-trip fidelity.
 *
 * Regression guard for the silent binary-corruption bug: a binary file with no
 * 0x00 byte in its sampled prefix was misclassified as text and read via a
 * lossy UTF-8 decode, replacing invalid sequences with U+FFFD (a 256-byte
 * random file came back as 461 bytes after sync/clone).
 *
 * The contract under test: whatever `readFileContent` returns, writing it back
 * with `writeFileContent` must reproduce the original bytes exactly — for ANY
 * input. Text files must additionally come back as `string` (so they keep the
 * collaborative-text CRDT path).
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as fc from "fast-check";
import { readFileContent, writeFileContent } from "../../src/utils/fs";

let baseDir: string;
let counter = 0;

beforeAll(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "pw-bin-rt-"));
});

afterAll(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

/** Write bytes to a file, read via readFileContent, write back, return raw bytes. */
async function roundTrip(
  bytes: Buffer,
  ext = ".bin"
): Promise<{ out: Buffer; content: string | Uint8Array }> {
  const n = counter++;
  const src = path.join(baseDir, `src-${n}${ext}`);
  const dst = path.join(baseDir, `dst-${n}${ext}`);
  await fs.writeFile(src, bytes);
  const content = await readFileContent(src);
  await writeFileContent(dst, content);
  return { out: await fs.readFile(dst), content };
}

describe("binary content round-trip fidelity", () => {
  it("preserves null-free high-byte binary (the corruption repro)", async () => {
    // 256 bytes, no 0x00, not valid UTF-8 — the exact misclassification case.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => 128 + (i % 127)));
    expect(bytes.includes(0)).toBe(false);
    const { out } = await roundTrip(bytes);
    expect(out.length).toBe(bytes.length);
    expect(out.equals(bytes)).toBe(true);
  });

  it("preserves binary that contains null bytes", async () => {
    const bytes = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]);
    const { out } = await roundTrip(bytes);
    expect(out.equals(bytes)).toBe(true);
  });

  it("preserves empty files", async () => {
    const { out } = await roundTrip(Buffer.alloc(0));
    expect(out.length).toBe(0);
  });

  it("preserves valid UTF-8 text and returns it as a string", async () => {
    const text = "café 🎉 ünïcödé\nconst x = 1;\n";
    const bytes = Buffer.from(text, "utf8");
    const { out, content } = await roundTrip(bytes, ".txt");
    expect(typeof content).toBe("string");
    expect(content).toBe(text);
    expect(out.equals(bytes)).toBe(true);
  });

  it("preserves latin-1 bytes that are not valid UTF-8 (no lossy decode)", async () => {
    // 0xE9 = 'é' in latin-1; lone 0xE9 is invalid UTF-8. Must NOT be mangled.
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "caf<0xE9>\n"
    const { out } = await roundTrip(bytes, ".txt");
    expect(out.equals(bytes)).toBe(true);
  });

  it("property: arbitrary byte buffers round-trip losslessly", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (arr) => {
        const bytes = Buffer.from(arr);
        const { out } = await roundTrip(bytes);
        return out.length === bytes.length && out.equals(bytes);
      }),
      { numRuns: 150 }
    );
  });
});
