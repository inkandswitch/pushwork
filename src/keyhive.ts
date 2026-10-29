// Keyhive, in whichever version a repo uses. Each version lives in its own module
// (keyhive/ark-*.ts for automerge-repo-keyhive, keyhive/keyline.ts for keyhive itself) and
// only the one a repo needs is opened.

import * as ark from "./keyhive/ark-0.5.js";
import {
	DEFAULT_KEYHIVE_VERSION,
	type Hive,
	type KeyhiveVersion,
	type Settings,
} from "./keyhive/common.js";
import * as keyline from "./keyhive/keyline.js";

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

// Every version knows the same built-in servers by name; the ARK ones ship their cards.
export const SERVERS = ark.SERVERS;

/** The peer id a contact card's holder answers to (its key, base64): JSON for ARK, base64 for keyline. */
export const cardPeerId = (card: string) => (keyline.isCard(card) ? keyline.cardPeerId(card) : ark.cardPeerId(card));

/** The server url and contact card `settings` name, in its version (ARK's when it has none). */
export const resolveSettings = (settings: Settings & { version?: KeyhiveVersion }) =>
	(settings.version === "keyline" ? keyline : ark).resolveSettings(settings);

/** Open the keyhive archive in `file` with `version`; see each version's `openHive`. */
export async function openHive(
	file: string,
	seed: Uint8Array,
	settings: Settings,
	reader = false,
	version: KeyhiveVersion = DEFAULT_KEYHIVE_VERSION,
): Promise<Hive> {
	const impl = version === "keyline" ? keyline : version === "0.6" ? await import("./keyhive/ark-0.6.js") : ark;
	return impl.openHive(file, seed, settings, reader);
}
