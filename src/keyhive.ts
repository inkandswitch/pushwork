// Keyhive, in whichever automerge-repo-keyhive version a repo uses. Each version lives in
// its own module (keyhive/ark-*.ts) and only the one a repo needs is loaded.

import {
	DEFAULT_KEYHIVE_VERSION,
	type Hive,
	type KeyhiveVersion,
	type Settings,
} from "./keyhive/common.js";

export {
	type AccessLevel,
	type Hive,
	type KeyhiveVersion,
	type Settings,
	DEFAULT_KEYHIVE_VERSION,
	DEFAULT_SERVER_NAME,
	KEYHIVE_VERSIONS,
	archiveFile,
	isKeyhiveVersion,
} from "./keyhive/common.js";

// Both versions ship the same built-in servers and cards, and read cards the same way.
export { SERVERS, cardPeerId, resolveSettings } from "./keyhive/ark-0.5.js";

/** Open the keyhive archive in `file` with `version`; see each version's `openHive`. */
export async function openHive(
	file: string,
	seed: Uint8Array,
	settings: Settings,
	reader = false,
	version: KeyhiveVersion = DEFAULT_KEYHIVE_VERSION,
): Promise<Hive> {
	const impl = version === "0.6" ? await import("./keyhive/ark-0.6.js") : await import("./keyhive/ark-0.5.js");
	return impl.openHive(file, seed, settings, reader);
}
