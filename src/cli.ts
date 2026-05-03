#!/usr/bin/env node
import { Command } from "@commander-js/extra-typings";
import * as path from "path";
import { clone, init, sync, url } from "./pushwork.js";

const program = new Command()
	.name("pushwork")
	.description("Bidirectional directory synchronization using Automerge CRDTs");

program
	.command("init")
	.description("Initialize pushwork in a directory")
	.argument("[dir]", "Directory to initialize", ".")
	.option("--sub", "Use subduction backend")
	.action(async (dir, opts) => {
		const u = await init({
			dir: path.resolve(dir),
			backend: opts.sub ? "subduction" : "legacy",
		});
		process.stderr.write(`initialized ${u}\n`);
	});

program
	.command("clone")
	.description("Clone an automerge URL into a directory")
	.argument("<url>", "automerge: URL")
	.argument("[dir]", "Target directory", ".")
	.option("--sub", "Use subduction backend")
	.action(async (u, dir, opts) => {
		await clone({
			url: u,
			dir: path.resolve(dir),
			backend: opts.sub ? "subduction" : "legacy",
		});
		process.stderr.write(`cloned into ${path.resolve(dir)}\n`);
	});

program
	.command("url")
	.description("Print the automerge URL of this pushwork repo")
	.action(async () => {
		const u = await url(process.cwd());
		process.stdout.write(u + "\n");
	});

program
	.command("sync")
	.description("Sync local changes with peers")
	.action(async () => {
		await sync(process.cwd());
		process.stderr.write("synced\n");
	});

program.parseAsync(process.argv).catch((err) => {
	process.stderr.write(
		`pushwork: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
