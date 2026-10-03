import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { readConfig, readOldConfig, writeConfig, type PushworkConfig } from "../../src/config.js";

const url = "automerge:qLoujReChD4mrphFKSHcteTf7m";

async function withConfig(config: object): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-config-"));
	await fs.mkdir(path.join(root, ".pushwork"));
	await fs.writeFile(path.join(root, ".pushwork", "config.json"), JSON.stringify(config));
	return root;
}

describe("config", () => {
	it("writes and reads v6", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pushwork-config-"));
		const config: PushworkConfig = {
			version: 6,
			rootUrl: url,
			shape: "vfs",
			artifactDirectories: ["dist"],
			server: "ws://127.0.0.1:1",
		};
		await writeConfig(root, config);
		expect(await readConfig(root)).toEqual(config);
		const written = JSON.parse(await fs.readFile(path.join(root, ".pushwork", "config.json"), "utf8"));
		expect("publishGroup" in written).toBe(false);
	});

	it("strips heads from the root url", async () => {
		const root = await withConfig({ version: 6, rootUrl: `${url}#abc`, shape: "vfs" });
		const config = await readConfig(root);
		expect(config.rootUrl).toBe(url);
		expect(config.artifactDirectories).toEqual([]);
	});

	it("points old configs at migrate", async () => {
		const root = await withConfig({ version: 5, rootUrl: url, backend: "subduction", shape: "vfs" });
		await expect(readConfig(root)).rejects.toThrow("run `pushwork migrate`");
	});

	it("reads what migrate needs from a v5 config", async () => {
		const root = await withConfig({
			version: 5,
			rootUrl: url,
			backend: "subduction",
			shape: "patchwork-folder",
			artifactDirectories: ["out"],
		});
		expect(await readOldConfig(root)).toEqual({
			rootUrl: url,
			shape: "patchwork-folder",
			artifactDirectories: ["out"],
		});
	});

	it("reads original pushwork configs as folders", async () => {
		const root = await withConfig({ root_directory_url: url, subduction: true, artifact_directories: ["dist"] });
		expect(await readOldConfig(root)).toEqual({
			rootUrl: url,
			shape: "patchwork-folder",
			artifactDirectories: ["dist"],
		});
	});

	it("finds an original repo's root url in snapshot.json", async () => {
		const root = await withConfig({ subduction: true });
		await fs.writeFile(
			path.join(root, ".pushwork", "snapshot.json"),
			JSON.stringify({ rootDirectoryUrl: url }),
		);
		expect((await readOldConfig(root))?.rootUrl).toBe(url);
	});

	it("has nothing to migrate in a v6 config", async () => {
		const root = await withConfig({ version: 6, rootUrl: url, shape: "vfs" });
		expect(await readOldConfig(root)).toBeUndefined();
	});

	it("asks legacy repos to republish", async () => {
		for (const config of [
			{ version: 5, rootUrl: url, backend: "legacy", shape: "vfs" },
			{ rootUrl: url, backend: "legacy" },
			{ root_directory_url: url, sync_server: "wss://sync3.automerge.org" },
		]) {
			await expect(readOldConfig(await withConfig(config))).rejects.toThrow(
				"retired sync3 server; `rm -rf .pushwork && pushwork init`",
			);
		}
	});
});
