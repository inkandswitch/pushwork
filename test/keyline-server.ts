import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

// subduction_cli built from subduction's keyline branch: $SUBDUCTION_CLI, else a sibling checkout's
export const keylineServerBinary = [
	process.env.SUBDUCTION_CLI,
	path.resolve(__dirname, "../../subduction/target/debug/subduction_cli"),
	path.resolve(__dirname, "../../subduction/target/release/subduction_cli"),
].find((bin): bin is string => !!bin && fs.existsSync(bin));

const freePort = () =>
	new Promise<number>((resolve, reject) => {
		const probe = net.createServer().once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});

/** A keyhive subduction server on a free port, with its keys and storage in a temp dir. */
export async function startKeylineServer(extraArgs: string[] = []): Promise<{ url: string; close(): Promise<void> }> {
	if (!keylineServerBinary) throw new Error("no subduction_cli; set SUBDUCTION_CLI");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pushwork-keyline-server-"));
	const ready = path.join(dir, "ready");
	const port = await freePort();
	// the service name must equal the client's URL.host or the handshake fails
	const host = `127.0.0.1:${port}`;
	const child: ChildProcess = spawn(
		keylineServerBinary,
		["server", "--socket", host, "--service-name", host, "--ephemeral-key", "--data-dir", dir, "--ready-file", ready, ...extraArgs],
		{ env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" }, stdio: ["ignore", "ignore", "inherit"] },
	);
	const exited = new Promise<never>((_, reject) => child.once("exit", code => reject(new Error(`subduction_cli exited: ${code}`))));
	const up = (async () => {
		while (!fs.existsSync(ready)) await new Promise(r => setTimeout(r, 50));
	})();
	await Promise.race([up, exited]);
	return {
		url: `ws://${host}`,
		close: async () => {
			child.kill();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
