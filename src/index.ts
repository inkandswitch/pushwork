export { init, clone, sync, url } from "./pushwork.js";
export type { Backend, PushworkConfig } from "./config.js";
export { CONFIG_VERSION } from "./config.js";
export type { Shape, VfsNode, UnixFileEntry } from "./shapes/index.js";
export {
	vfsShape,
	patchworkFolderShape,
	isInArtifactDir,
	normalizeArtifactDir,
	pinUrl,
	stripHeads,
} from "./shapes/index.js";
