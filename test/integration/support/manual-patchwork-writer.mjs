import fs from "node:fs/promises";
import path from "node:path";
import { Repo, initSubduction } from "@automerge/automerge-repo";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs";

const [action, writerDir, serverUrl, storageId] = process.argv.slice(2);

if (!action || !writerDir || !serverUrl || !storageId) {
  throw new Error("usage: manual-patchwork-writer.mjs <action> <writerDir> <serverUrl> <storageId>");
}

const statePath = path.join(writerDir, "writer-state.json");

function createRepo() {
  return new Repo({
    storage: new NodeFSStorageAdapter(path.join(writerDir, "automerge")),
    network: [new BrowserWebSocketClientAdapter(serverUrl)],
  });
}

await initSubduction();

async function pauseForRelay() {
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function initWriter() {
  await fs.mkdir(writerDir, { recursive: true });
  const repo = createRepo();
  try {
    const rootHandle = repo.create({
      "@patchwork": { type: "folder" },
      name: "root",
      title: "root",
      docs: [],
    });
    const alphaHandle = repo.create({
      "@patchwork": { type: "folder" },
      name: "alpha",
      title: "alpha",
      docs: [],
    });
    const helloHandle = repo.create({
      "@patchwork": { type: "file" },
      name: "hello.md",
      extension: "md",
      mimeType: "text/markdown",
      contentType: "public.markdown",
      content: "# hello\n",
      metadata: { permissions: 0o644 },
    });

    alphaHandle.change(doc => {
      doc.docs.push({ name: "hello.md", type: "file", url: helloHandle.url });
    });
    rootHandle.change(doc => {
      doc.docs.push({ name: "alpha", type: "folder", url: alphaHandle.url });
    });

    await pauseForRelay();

    await fs.writeFile(
      statePath,
      JSON.stringify({ rootUrl: rootHandle.url, alphaUrl: alphaHandle.url }, null, 2),
      "utf8",
    );

    process.stdout.write(rootHandle.url);
  } finally {
    await repo.shutdown();
  }
}

async function addSecondFile() {
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const repo = createRepo();
  try {
    const alphaHandle = await repo.find(state.alphaUrl);
    const secondHandle = repo.create({
      "@patchwork": { type: "file" },
      name: "second.md",
      extension: "md",
      mimeType: "text/markdown",
      contentType: "public.markdown",
      content: "second file\n",
      metadata: { permissions: 0o644 },
    });

    alphaHandle.change(doc => {
      doc.docs.push({ name: "second.md", type: "file", url: secondHandle.url });
    });

    await pauseForRelay();
  } finally {
    await repo.shutdown();
  }
}

if (action === "init") {
  await initWriter();
} else if (action === "add-second") {
  await addSecondFile();
} else {
  throw new Error(`unknown action: ${action}`);
}
