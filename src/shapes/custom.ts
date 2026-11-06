import * as fs from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";
import { log } from "../log.js";
import type { Shape } from "./types.js";

const dlog = log("shapes:custom");

export async function loadCustomShape(filePath: string): Promise<Shape> {
	const absolute = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	dlog("loading custom shape from %s", absolute);
	// a long-lived process (the daemon) would otherwise keep running the first version it loaded
	const changed = await fs.stat(absolute).then(st => `?${st.mtimeMs}`, () => "");
	const url = pathToFileURL(absolute).href + changed;
	const mod = (await import(url)) as {
		default?: Partial<Shape>;
	};
	const candidate = mod.default;
	if (
		!candidate ||
		typeof candidate.encode !== "function" ||
		typeof candidate.decode !== "function"
	) {
		throw new Error(
			`shape ${filePath} must export default { encode, decode }`,
		);
	}
	dlog("custom shape loaded ok");
	return candidate as Shape;
}
