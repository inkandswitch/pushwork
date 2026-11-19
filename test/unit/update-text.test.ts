import * as Automerge from "@automerge/automerge";
import { updateTextByLines } from "../../src/shapes/file.js";

type Doc = { content: string };

function apply(before: string, after: string): string {
	let doc = Automerge.from<Doc>({ content: before });
	doc = Automerge.change(doc, (d) => updateTextByLines(d, ["content"], d.content, after));
	return doc.content;
}

describe("updateTextByLines", () => {
	const cases: [string, string, string][] = [
		["edit inside a line", "one\ntwo\nthree\n", "one\nTWO!\nthree\n"],
		["insert and delete lines", "a\nb\nc\nd\n", "a\nx\ny\nc\n"],
		["empty to text and back", "", "hello\n"],
		["text to empty", "hello\nworld", ""],
		["no trailing newline", "a\nb", "a\nb\nc"],
		["non-ASCII and emoji", "12:00–20:00 × 🏥 beds\nnext\n", "12:00–21:00 × 🏥🚑 beds\nnext → later\n"],
		["CRLF", "a\r\nb\r\n", "a\r\nB\r\nc\r\n"],
	];
	for (const [name, before, after] of cases) {
		it(name, () => expect(apply(before, after)).toBe(after));
	}

	it("replaces a large changed run whole", () => {
		const big = (c: string) => `${"x".repeat(10)}\n${c.repeat(30_000)}\n${"y".repeat(10)}\n`;
		expect(apply(big("a"), big("b"))).toBe(big("b"));
	});

	it("keeps a concurrent edit elsewhere in the text", () => {
		const base = Automerge.from<Doc>({ content: "one\ntwo\nthree\n" });
		const ours = Automerge.change(Automerge.clone(base), (d) =>
			updateTextByLines(d, ["content"], d.content, "ONE\ntwo\nthree\n"),
		);
		const theirs = Automerge.change(Automerge.clone(base), (d) =>
			updateTextByLines(d, ["content"], d.content, "one\ntwo\nthree!\n"),
		);
		expect(Automerge.merge(ours, theirs).content).toBe("ONE\ntwo\nthree!\n");
	});
});
