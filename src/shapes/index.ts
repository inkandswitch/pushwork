import { loadCustomShape } from "./custom.js";
import { patchworkFolderShape } from "./patchwork-folder.js";
import { vfsShape } from "./vfs.js";
import type { Shape } from "./types.js";

export type ShapeName = "vfs" | "patchwork-folder" | string;

export const isBuiltinShape = (name: string): boolean =>
	name === "vfs" || name === "patchwork-folder";

export async function resolveShape(name: ShapeName): Promise<Shape> {
	if (name === "vfs") return vfsShape;
	if (name === "patchwork-folder") return patchworkFolderShape;
	return loadCustomShape(name);
}

export { vfsShape, patchworkFolderShape };
export * from "./types.js";
export * from "./file.js";
