// Keyline scenarios against a real subduction server: a local subduction_cli in the unit
// tests, staging in the network ones.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemorySigner, MemoryStorage } from "@automerge/automerge-subduction";
import { Docs, DocumentNotFound, DocumentUnreadable } from "../src/docs";
import { type Hive, openHive } from "../src/keyhive";
import { fetchCard, openPublicHive } from "../src/keyhive/keyline";
import { type PublicPrincipals, pairOf } from "../src/keyhive/keyline/public";
import { parseAutomergeUrl, toSedimentreeId } from "../src/url";

const archive = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-keyline-")), "archive");
const seed = () => crypto.getRandomValues(new Uint8Array(32));

type Text = { text: string };

async function online(
	url: string,
	key: Uint8Array,
	hive: Pick<Hive, "codec" | "sync">,
	newId?: () => Promise<any>,
	storage = new MemoryStorage(),
) {
	const docs = await Docs.open({ storage, signer: MemorySigner.fromBytes(key), server: url, codec: hive.codec, newId });
	await hive.sync(docs as Docs);
	return docs;
}

// an owner's hive with a group the server can relay, and a doc in it written twice
async function publish(url: string, publicAccess?: "relay" | "read", app?: PublicPrincipals) {
	const settings = { server: url, card: await fetchCard(url) };
	const key = seed();
	const hive = await openHive(archive(), key, settings, false, "keyline");
	const group = await hive.createGroup({ server: "relay", public: publicAccess, publicPair: app && pairOf(app) });
	const docs = await online(url, key, hive, hive.newId(group));
	const doc = await docs.create<Text>({ text: "before" });
	await docs.change<Text>(doc, d => {
		d.text = "still before";
	});
	await hive.sync(docs);
	expect(await docs.sync([doc])).toMatchObject({ synced: 1, unsynced: [] });
	return { settings, hive, group, docs, doc };
}

/** A reader added after a doc was written reads what was written before. */
export async function readerAddedLater(url: string) {
	const { settings, hive: alice, group, docs: aliceDocs, doc } = await publish(url);
	const bobKey = seed();
	const bob = await openHive(archive(), bobKey, settings, false, "keyline");
	await alice.setAccess(group, { card: await bob.contactCard() }, "read");
	await alice.sync(aliceDocs);

	const bobDocs = await online(url, bobKey, bob);
	const { documentId } = parseAutomergeUrl(doc);
	expect(await bob.groupOf(documentId)).toBe(group);
	expect(await bob.canWrite(documentId)).toBe(false);
	await bobDocs.sync([doc]);
	expect((await bobDocs.find<Text>(doc)).text).toBe("still before");

	await Promise.all([aliceDocs.close(), bobDocs.close()]);
	await Promise.all([alice.close(), bob.close()]);
}

/**
 * With public read, anyone reads through the app's public principals (Patchwork's unless
 * given); with relay, nobody decrypts. Another app's users read nothing.
 */
export async function publicAccess(url: string, level: "relay" | "read", app?: PublicPrincipals) {
	const { settings, hive, docs, doc } = await publish(url, level, app);
	if (app) {
		// Patchwork's public isn't this app's
		const patchwork = await openPublicHive(settings);
		const patchworkDocs = await online(url, patchwork.seed, patchwork);
		await patchworkDocs.sync([doc]);
		await expect(patchworkDocs.find(doc)).rejects.toThrow(DocumentNotFound);
		await patchworkDocs.close();
	}
	const outsider = await openPublicHive(settings, app);
	const storage = new MemoryStorage();
	const outsiderDocs = await online(url, outsider.seed, outsider, undefined, storage);
	await outsiderDocs.sync([doc]);
	// the fetcher can relay either way: the blobs arrive
	expect((await storage.loadAllCommits(toSedimentreeId(parseAutomergeUrl(doc).documentId))).length).toBeGreaterThan(0);
	if (level === "read") expect((await outsiderDocs.find<Text>(doc)).text).toBe("still before");
	else await expect(outsiderDocs.find(doc)).rejects.toThrow(DocumentUnreadable);
	await Promise.all([docs.close(), outsiderDocs.close()]);
	await hive.close();
}
