import { loadCustomShape } from "./custom.js";
import { installedShapePath, isShapeName, listShapes } from "./installed.js";
import { patchworkFolderShape } from "./patchwork-folder.js";
import { vfsShape } from "./vfs.js";
import type { Shape } from "./types.js";

export type ShapeName = "vfs" | "patchwork-folder" | string;

export async function resolveShape(name: ShapeName): Promise<Shape> {
	if (name === "vfs") return vfsShape;
	if (name === "patchwork-folder") return patchworkFolderShape;
	if (!isShapeName(name)) return loadCustomShape(name);
	if (!(await listShapes()).includes(name)) {
		throw new Error(`no shape named ${name}; install it with \`pushwork shape install\``);
	}
	return loadCustomShape(installedShapePath(name));
}

export { vfsShape, patchworkFolderShape };
export * from "./types.js";
export * from "./file.js";
export * from "./file-docs.js";
export { installShape, listShapes, removeShape } from "./installed.js";
