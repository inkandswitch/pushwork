import * as A from "@automerge/automerge";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemorySigner, MemoryStorage } from "@automerge/automerge-subduction";
import { Docs } from "../../src/docs";
import { openHive } from "../../src/keyhive";
import { isProtected, parseAutomergeUrl } from "../../src/url";

// Offline: published docs round-trip through keyhive encryption and the saved archive.
describe("keyhive", () => {
	it("encrypts on save and decrypts after reopening the archive", async () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-hive-")), "keyhive");
		const seed = crypto.getRandomValues(new Uint8Array(32));
		const storage = new MemoryStorage();
		const hive = await openHive(file, seed);
		const group = await hive.createPublicGroup();
		const docs = await Docs.open({ storage, signer: MemorySigner.fromBytes(seed), codec: hive.codec, newId: hive.newId(group) });
		const url = await docs.create({ text: "secret" });
		await docs.change<{ text: string }>(url, d => {
			d.text = "published";
		});
		const heads = await docs.heads(url);
		await docs.close();
		await hive.close();

		const { documentId } = parseAutomergeUrl(url);
		expect(isProtected(documentId)).toBe(true);
		const plain = await Docs.open({ storage, signer: MemorySigner.fromBytes(seed) });
		await expect(plain.find(url)).rejects.toThrow();
		await plain.close();

		const reopened = await openHive(file, seed);
		expect(await reopened.canWrite(documentId)).toBe(true);
		const again = await Docs.open({ storage, signer: MemorySigner.fromBytes(seed), codec: reopened.codec });
		const doc = await again.find<{ text: string }>(url);
		expect(doc.text).toBe("published");
		expect(A.getHeads(doc)).toEqual(heads);
		await again.close();
		await reopened.close();
	});

	it("is held by one process at a time", async () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-hive-")), "keyhive");
		const seed = crypto.getRandomValues(new Uint8Array(32));
		const hive = await openHive(file, seed);
		await expect(openHive(file, seed)).rejects.toThrow(/in use/);
		// a reader neither waits for the lock nor writes the archive
		await (await openHive(file, seed, true)).close();
		expect(fs.existsSync(file)).toBe(false);
		await hive.close();
		// a lock left by a process that died is taken over
		fs.writeFileSync(`${file}.lock`, "999999");
		await (await openHive(file, seed)).close();
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});
});
