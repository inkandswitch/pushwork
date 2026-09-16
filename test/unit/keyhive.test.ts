/**
 * Unit tests for the keyhive helpers that need no hive, network, or wasm
 * state: identity parsing, grantee parsing, and the config's backend check.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as tmp from "tmp";

import {
	accessName,
	hasIdentity,
	identityPath,
	isProtectedUrl,
	parseAccess,
	parseGrantee,
	parseIdentity,
} from "../../src/keyhive.js";
import { CONFIG_VERSION, readConfig } from "../../src/config.js";

tmp.setGracefulCleanup();

const JWK = {
	kty: "OKP",
	crv: "Ed25519",
	x: "TGS_X7KI-bUjibRfBMNqMJ6Nc6yBxBSjF85SaBhIQIU",
	d: "Xwd0OgMlq0YpV6ZM6xFChW4dP4zeT6m62O6Qhbd8wCE",
};

describe("parseIdentity", () => {
	it("accepts the browser snippet's JSON, with or without prekeys", () => {
		expect(parseIdentity(JSON.stringify({ key: JWK }))).toEqual({
			key: JWK,
			prekeys: undefined,
		});
		expect(parseIdentity(` ${JSON.stringify({ key: JWK, prekeys: "AAAA" })}\n`)).toEqual({
			key: JWK,
			prekeys: "AAAA",
		});
	});

	it("rejects non-JSON, a public-only key, and non-Ed25519 keys", () => {
		expect(() => parseIdentity("not json")).toThrow(/not JSON/);
		const { d: _d, ...publicOnly } = JWK;
		expect(() => parseIdentity(JSON.stringify({ key: publicOnly }))).toThrow(/private key/);
		expect(() => parseIdentity(JSON.stringify({ key: { ...JWK, crv: "P-256" } }))).toThrow(
			/private key/,
		);
		expect(() => parseIdentity(JSON.stringify({ key: JWK, prekeys: 3 }))).toThrow(/base64/);
	});
});

describe("access levels", () => {
	it("maps pushwork's names (and keyhive's own) onto keyhive Access", () => {
		expect(accessName(parseAccess("pull"))).toBe("pull");
		expect(accessName(parseAccess("relay"))).toBe("pull");
		expect(accessName(parseAccess("read"))).toBe("read");
		expect(accessName(parseAccess("edit"))).toBe("edit");
		expect(accessName(parseAccess("write"))).toBe("edit");
		expect(accessName(parseAccess("ADMIN"))).toBe("admin");
		expect(() => parseAccess("owner")).toThrow(/unknown access level/);
	});
});

describe("parseGrantee", () => {
	it("treats the public aliases as the world", () => {
		for (const w of ["public", "World", "everyone", " anyone "]) {
			expect(parseGrantee(w)).toEqual({ kind: "public" });
		}
	});

	it("rejects anything that is neither public nor a contact card", () => {
		expect(() => parseGrantee("alice")).toThrow(/contact card/);
		expect(() => parseGrantee("{}")).toThrow(/invalid contact card/);
	});
});

describe("isProtectedUrl", () => {
	it("tells 32-byte keyhive ids from zero-padded classic ones", () => {
		expect(isProtectedUrl("automerge:XoQnpXDDPXEtRVPhdQruLDVRduB")).toBe(false);
		expect(
			isProtectedUrl("automerge:4WxamPn7dsxgkhEUcFyMbxtptfPvEtfaCLFqLeZZrJCfca3B9"),
		).toBe(true);
		expect(isProtectedUrl("nope")).toBe(false);
	});
});

describe("identity storage", () => {
	let home: string;
	let cleanup: () => void;
	let priorHome: string | undefined;

	beforeEach(() => {
		const d = tmp.dirSync({ unsafeCleanup: true });
		home = d.name;
		cleanup = d.removeCallback;
		priorHome = process.env.PUSHWORK_HOME;
		process.env.PUSHWORK_HOME = home;
	});

	afterEach(() => {
		if (priorHome === undefined) delete process.env.PUSHWORK_HOME;
		else process.env.PUSHWORK_HOME = priorHome;
		cleanup();
	});

	it("lives under PUSHWORK_HOME and is absent until `keyhive use`", async () => {
		expect(identityPath()).toBe(path.join(home, "keyhive.lmdb"));
		expect(await hasIdentity()).toBe(false);
		await fs.mkdir(identityPath(), { recursive: true });
		expect(await hasIdentity()).toBe(true);
	});
});

describe("config keyhive flag", () => {
	it("reads `keyhive: true`, defaults to false, and still refuses unknown backends", async () => {
		const d = tmp.dirSync({ unsafeCleanup: true });
		try {
			await fs.mkdir(path.join(d.name, ".pushwork"));
			const write = (backend: string, keyhive?: boolean) =>
				fs.writeFile(
					path.join(d.name, ".pushwork", "config.json"),
					JSON.stringify({
						version: CONFIG_VERSION,
						rootUrl: "automerge:XoQnpXDDPXEtRVPhdQruLDVRduB",
						backend,
						shape: "vfs",
						artifactDirectories: [],
						...(keyhive === undefined ? {} : { keyhive }),
					}),
				);
			await write("subduction", true);
			expect((await readConfig(d.name))).toMatchObject({ backend: "subduction", keyhive: true });
			await write("subduction");
			expect((await readConfig(d.name)).keyhive).toBe(false);
			await write("carrier-pigeon");
			await expect(readConfig(d.name)).rejects.toThrow(/unknown backend/);
		} finally {
			d.removeCallback();
		}
	});
});
