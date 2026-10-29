// Keyline against staging, whose subduction runs the keyline branch (`--mode network`).
import { cardPeerId } from "../../src/keyhive";
import { fetchCard } from "../../src/keyhive/keyline";
import { publicAccess, readerAddedLater } from "../keyline-scenarios";

const STAGING = process.env.KEYLINE_SERVER ?? "wss://staging.subduction.sync.inkandswitch.com";

describe("keyline on staging", () => {
	it("hands out its own card", async () => {
		expect(cardPeerId(await fetchCard(STAGING))).toMatch(/^[A-Za-z0-9+/]{43}=$/);
	});

	it("lets a reader added later read what was written before", () => readerAddedLater(STAGING), 120_000);

	it("lets anyone read a repo with public read", () => publicAccess(STAGING, "read"), 120_000);

	it("lets nobody decrypt a repo with public relay", () => publicAccess(STAGING, "relay"), 120_000);
});
