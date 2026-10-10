import * as path from "path";
import { log } from "./log.js";
import { isValidAutomergeUrl, type AutomergeUrl } from "./url.js";

const dlog = log("xattr");

/**
 * Every synced file carries its doc's url in this extended attribute, so
 * `xattr -p user.automerge.url <file>` (or `getfattr`) says where it lives.
 * `mv` keeps xattrs, which is how a sync tells a moved file from a new one.
 * Where xattrs aren't available (Windows, some filesystems) this does nothing.
 */
export const URL_XATTR = "user.automerge.url";

type Xattr = typeof import("@napi-rs/xattr");

let loaded: Promise<Xattr | null> | undefined;
const xattr = () =>
	(loaded ??= import("@napi-rs/xattr").catch((e) => {
		dlog("xattrs unavailable: %s", e);
		return null;
	}));

const toFs = (root: string, posixPath: string) => path.join(root, ...posixPath.split("/"));

/** The url recorded on `posixPath`, if it has one. */
export async function readUrlAttr(root: string, posixPath: string): Promise<AutomergeUrl | undefined> {
	const x = await xattr();
	try {
		const value = x?.getAttributeSync(toFs(root, posixPath), URL_XATTR)?.toString("utf8");
		return isValidAutomergeUrl(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Record each file's url on it, skipping those already right. */
export async function writeUrlAttrs(root: string, files: Iterable<[string, { url?: AutomergeUrl }]>): Promise<void> {
	const x = await xattr();
	if (!x) return;
	for (const [posixPath, { url }] of files) {
		if (!url) continue;
		const file = toFs(root, posixPath);
		try {
			if (x.getAttributeSync(file, URL_XATTR)?.toString("utf8") === url) continue;
			x.setAttributeSync(file, URL_XATTR, url);
		} catch (e) {
			dlog("can't set %s on %s: %s", URL_XATTR, posixPath, e);
		}
	}
}
