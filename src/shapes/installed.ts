// Shapes installed with `pushwork shape install`, kept per account in ~/.pushwork/shapes.
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { loadCustomShape } from "./custom.js";

const BUILTIN = new Set(["vfs", "patchwork-folder"]);

export const shapesDir = () => path.join(os.homedir(), ".pushwork", "shapes");

// a name has no dots or slashes, so it can't be mistaken for a path
export const isShapeName = (s: string) => /^[a-z0-9][a-z0-9_-]*$/i.test(s);

export const installedShapePath = (name: string) => path.join(shapesDir(), `${name}.js`);

/** Install `code` as the shape `name`, after checking that it loads as one. */
export async function installShape(name: string, code: string): Promise<string> {
	if (!isShapeName(name)) throw new Error(`"${name}" isn't a usable shape name (letters, digits, - and _)`);
	if (BUILTIN.has(name)) throw new Error(`"${name}" is a built-in shape`);
	const dir = shapesDir();
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "package.json"), '{ "type": "module" }\n');
	const tmp = path.join(dir, `.${name}.${process.pid}.js`);
	await fs.writeFile(tmp, code);
	try {
		await loadCustomShape(tmp);
	} catch (e) {
		await fs.rm(tmp, { force: true });
		throw new Error(`not a shape: ${e instanceof Error ? e.message : e}`);
	}
	const dest = installedShapePath(name);
	await fs.rename(tmp, dest);
	return dest;
}

export async function listShapes(): Promise<string[]> {
	const names = await fs.readdir(shapesDir()).catch(() => []);
	return names
		.filter(n => n.endsWith(".js") && !n.startsWith("."))
		.map(n => n.slice(0, -3))
		.sort();
}

export async function removeShape(name: string): Promise<void> {
	if (!isShapeName(name) || !(await listShapes()).includes(name)) throw new Error(`no installed shape named ${name}`);
	await fs.rm(installedShapePath(name));
}
