// A pushwork shape for slaygrounds projects: { meta, src }. The working tree is
// `src`: nested objects are folders, strings are text files, bytes are binary
// files. `meta` is left alone.
//
//   pushwork clone --shape examples/shapes/slay.js automerge:... my-project

const utf8 = new TextDecoder("utf-8", { fatal: true });

// text if it is valid utf-8 without NULs, else bytes
function contentOf(bytes) {
	if (bytes.includes(0)) return bytes;
	try {
		return utf8.decode(bytes);
	} catch {
		return bytes;
	}
}

const isFile = value => typeof value === "string" || value instanceof Uint8Array;
const isFolder = value => value !== null && typeof value === "object" && !isFile(value);

function sameContent(a, b) {
	if (typeof a === "string" || typeof b === "string") return a === b;
	return a.length === b.length && a.every((x, i) => x === b[i]);
}

// drop files that aren't in `keep` and folders left empty
function prune(folder, prefix, keep) {
	for (const [name, value] of Object.entries(folder)) {
		const path = prefix + name;
		if (isFile(value) && !keep.has(path)) delete folder[name];
		else if (isFolder(value)) {
			prune(value, `${path}/`, keep);
			if (Object.keys(value).length === 0) delete folder[name];
		}
	}
}

export default {
	async encode({ docs, files, previousRoot }) {
		const url = previousRoot ?? (await docs.create({ meta: {}, src: {} }));
		await docs.change(url, doc => {
			if (!isFolder(doc.src)) doc.src = {};
			prune(doc.src, "", files);
			for (const [path, bytes] of files) {
				const names = path.split("/");
				const name = names.pop();
				let folder = doc.src;
				for (const dir of names) {
					if (!isFolder(folder[dir])) folder[dir] = {};
					folder = folder[dir];
				}
				const content = contentOf(bytes);
				const old = folder[name];
				if (old !== undefined && isFile(old) && sameContent(old, content)) continue;
				// merge text into the existing string so concurrent edits survive
				if (typeof old === "string" && typeof content === "string") {
					docs.updateText(doc, ["src", ...names, name], content);
				} else {
					folder[name] = content;
				}
			}
		});
		return url;
	},

	async decode({ docs, root }) {
		const doc = await docs.find(root);
		const files = new Map();
		const encoder = new TextEncoder();
		const walk = (folder, prefix) => {
			for (const [name, value] of Object.entries(folder ?? {})) {
				if (typeof value === "string") files.set(prefix + name, { bytes: encoder.encode(value) });
				else if (value instanceof Uint8Array) files.set(prefix + name, { bytes: value });
				else if (isFolder(value)) walk(value, `${prefix}${name}/`);
			}
		};
		walk(doc.src, "");
		return files;
	},
};
