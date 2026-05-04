export {
	init,
	clone,
	sync,
	save,
	status,
	diff,
	url,
	currentBranch,
	createBranch,
	switchBranch,
	listBranches,
	mergeBranch,
	previewMerge,
	cutWorkdir,
	pasteStash,
	showStashes,
} from "./pushwork.js";
export type { MergeReport, MergePreview, MergePreviewEntry } from "./pushwork.js";
export type { Stash, StashEntry } from "./stash.js";
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
export {
	DEFAULT_BRANCH,
	detectDocType,
	isBranchesDoc,
	resolveEffectiveRoot,
	type BranchesDoc,
} from "./branches.js";
