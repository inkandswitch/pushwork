import * as A from "@automerge/automerge";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { MemorySigner, MemoryStorage } from "@automerge/automerge-subduction";
import { Docs } from "../../src/docs";
import { SERVERS, archiveFile, cardPeerId, openHive, resolveSettings } from "../../src/keyhive";
import { keyhiveInfo, setKeyhiveServer } from "../../src/pushwork";
import { isProtected, parseAutomergeUrl } from "../../src/url";

// Offline: keyhive docs round-trip through keyhive encryption and the saved archive.
describe("keyhive", () => {
	it("encrypts on save and decrypts after reopening the archive", async () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-hive-")), "keyhive");
		const seed = crypto.getRandomValues(new Uint8Array(32));
		const storage = new MemoryStorage();
		const hive = await openHive(file, seed, {});
		const group = await hive.createGroup({ public: "read", server: "relay" });
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

		const reopened = await openHive(file, seed, {});
		expect(await reopened.canWrite(documentId)).toBe(true);
		expect(await reopened.groupOf(documentId)).toBe(group);
		const again = await Docs.open({ storage, signer: MemorySigner.fromBytes(seed), codec: reopened.codec });
		const doc = await again.find<{ text: string }>(url);
		expect(doc.text).toBe("published");
		expect(A.getHeads(doc)).toEqual(heads);
		await again.close();
		await reopened.close();
	});

	it("keeps each keyhive version's archive apart, moving the old single file into 0.5", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-home-"));
		const dir = path.join(home, "keyhive");
		fs.writeFileSync(dir, "old archive");
		expect(await archiveFile(dir, "0.6")).toBe(path.join(dir, "0.6", "archive"));
		expect(fs.readFileSync(path.join(dir, "0.5", "archive"), "utf8")).toBe("old archive");
		expect(await archiveFile(dir, "0.5")).toBe(path.join(dir, "0.5", "archive"));
		// a move that stopped between its two renames is finished
		const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-home-")), "keyhive");
		fs.writeFileSync(`${other}.moving`, "half moved");
		await archiveFile(other, "0.5");
		expect(fs.readFileSync(path.join(other, "0.5", "archive"), "utf8")).toBe("half moved");
		// the old archive isn't moved out from under a running pushwork
		const busy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-home-")), "keyhive");
		fs.writeFileSync(busy, "in use");
		fs.writeFileSync(`${busy}.lock`, String(process.pid));
		await expect(archiveFile(busy, "0.5")).rejects.toThrow(/in use/);
		expect(fs.readFileSync(busy, "utf8")).toBe("in use");
	});

	it("opens a 0.6 archive with automerge-repo-keyhive 0.6", async () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-hive-")), "archive");
		const seed = crypto.getRandomValues(new Uint8Array(32));
		const hive = await openHive(file, seed, {}, false, "0.6");
		const group = await hive.createGroup({ public: "read", server: "relay" });
		const id = await hive.newId(group)();
		expect(await hive.groupOf(id)).toBe(group);
		expect(await hive.canWrite(id)).toBe(true);
		await hive.close();
		const reopened = await openHive(file, seed, {}, false, "0.6");
		expect(await reopened.groupOf(id)).toBe(group);
		await reopened.close();
	});

	it("is held by one process at a time", async () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-hive-")), "keyhive");
		const seed = crypto.getRandomValues(new Uint8Array(32));
		const hive = await openHive(file, seed, {});
		await expect(openHive(file, seed, {})).rejects.toThrow(/in use/);
		// a reader neither waits for the lock nor writes the archive
		await (await openHive(file, seed, {}, true)).close();
		expect(fs.existsSync(file)).toBe(false);
		await hive.close();
		// a lock left by a process that died is taken over
		fs.writeFileSync(`${file}.lock`, "999999");
		await (await openHive(file, seed, {})).close();
		expect(fs.existsSync(`${file}.lock`)).toBe(false);
	});

	describe("settings", () => {
		const home = process.env.HOME;
		beforeEach(() => {
			process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-home-"));
		});
		afterEach(() => {
			process.env.HOME = home;
		});
		const saved = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pushwork", "keyhive.json"), "utf8"));

		it("defaults to the keyhive server and its card", () => {
			expect(resolveSettings({})).toEqual(SERVERS.keyhive);
		});

		it("takes a built-in server by name or url, with its card", async () => {
			await setKeyhiveServer("subduction");
			expect(saved()).toEqual({ server: "subduction" });
			expect(resolveSettings(saved())).toEqual(SERVERS.subduction);
			await setKeyhiveServer(SERVERS.keyhive.url);
			expect(saved()).toEqual({ server: "keyhive" });
		});

		it("needs a card with a custom url", async () => {
			await expect(setKeyhiveServer("ws://127.0.0.1:9")).rejects.toThrow("needs its contact card");
			expect(() => resolveSettings({ server: "ws://127.0.0.1:9" })).toThrow("pushwork keyhive server");
		});

		it("takes a custom url with a card by name, JSON or file", async () => {
			await setKeyhiveServer("ws://127.0.0.1:9", "subduction");
			expect(resolveSettings(saved())).toEqual({ url: "ws://127.0.0.1:9", card: SERVERS.subduction.card });

			await setKeyhiveServer("ws://127.0.0.1:9", SERVERS.keyhive.card);
			expect(resolveSettings(saved()).card).toBe(SERVERS.keyhive.card);

			const file = path.join(os.homedir(), "card.json");
			fs.writeFileSync(file, SERVERS.subduction.card + "\n");
			await setKeyhiveServer("ws://127.0.0.1:9", file);
			expect(saved().card).toBe(SERVERS.subduction.card);
		});

		it("fetches a card from an http url", async () => {
			const server = http.createServer((_, res) => res.end(SERVERS.keyhive.card)).listen(0, "127.0.0.1");
			await new Promise(r => server.once("listening", r));
			const { port } = server.address() as { port: number };
			try {
				await setKeyhiveServer("ws://127.0.0.1:9", `http://127.0.0.1:${port}/card`);
			} finally {
				server.close();
			}
			expect(saved().card).toBe(SERVERS.keyhive.card);
		});

		it("rejects things that aren't servers or cards", async () => {
			await expect(setKeyhiveServer("nowhere")).rejects.toThrow("ws(s):// url");
			await expect(setKeyhiveServer("ws://127.0.0.1:9", "{}")).rejects.toThrow("not a keyhive contact card");
		});

		it("shows the server's peer id and this machine's contact card", async () => {
			const first = await keyhiveInfo();
			expect(first.server).toBe(SERVERS.keyhive.url);
			expect(first.serverPeer).toBe(cardPeerId(SERVERS.keyhive.card));
			expect(cardPeerId(first.me)).toBe(first.id);
			expect((await keyhiveInfo()).id).toBe(first.id);
		});
	});
});
