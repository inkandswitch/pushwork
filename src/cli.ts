#!/usr/bin/env node
import "./log.js"; // sets up DEBUG=true → DEBUG=* before anything else
import { Command } from "@commander-js/extra-typings";
import * as path from "path";
import { clone, init, sync, url } from "./pushwork.js";
import { log } from "./log.js";

const dlog = log("cli");

const collect = (value: string, prev: string[] | undefined) =>
	(prev ?? []).concat(value);

const program = new Command()
	.name("pushwork")
	.description("Bidirectional directory synchronization using Automerge CRDTs");

program
	.command("init")
	.description("Initialize pushwork in a directory")
	.argument("[dir]", "Directory to initialize", ".")
	.option("--sub", "Use subduction backend")
	.option(
		"--shape <shape>",
		"Document shape: vfs, patchwork-folder, or path to a custom shape module",
		"vfs",
	)
	.option(
		"--artifact-dir <dir>",
		"Directory whose contents are stored as ImmutableString and pinned with heads in the root doc. Repeatable.",
		collect,
		undefined as string[] | undefined,
	)
	.action(async (dir, opts) => {
		dlog("init dir=%s opts=%o", dir, opts);
		const u = await init({
			dir: path.resolve(dir),
			backend: opts.sub ? "subduction" : "legacy",
			shape: opts.shape,
			artifactDirectories: opts.artifactDir,
		});
		process.stderr.write(`initialized ${u}\n`);
	});

program
	.command("clone")
	.description("Clone an automerge URL into a directory")
	.argument("<url>", "automerge: URL")
	.argument("[dir]", "Target directory", ".")
	.option("--sub", "Use subduction backend")
	.option(
		"--shape <shape>",
		"Document shape: vfs, patchwork-folder, or path to a custom shape module",
		"vfs",
	)
	.option(
		"--artifact-dir <dir>",
		"Directory whose contents are stored as ImmutableString and pinned with heads in the root doc. Repeatable.",
		collect,
		undefined as string[] | undefined,
	)
	.action(async (u, dir, opts) => {
		dlog("clone url=%s dir=%s opts=%o", u, dir, opts);
		await clone({
			url: u,
			dir: path.resolve(dir),
			backend: opts.sub ? "subduction" : "legacy",
			shape: opts.shape,
			artifactDirectories: opts.artifactDir,
		});
		process.stderr.write(`cloned into ${path.resolve(dir)}\n`);
	});

program
	.command("url")
	.description("Print the automerge URL of this pushwork repo")
	.action(async () => {
		dlog("url cwd=%s", process.cwd());
		const u = await url(process.cwd());
		process.stdout.write(u + "\n");
	});

program
	.command("sync")
	.description("Sync local changes with peers")
	.action(async () => {
		dlog("sync cwd=%s", process.cwd());
		await sync(process.cwd());
		process.stderr.write("synced\n");
	});

program
	.parseAsync(process.argv)
	.then(() => process.exit(0))
	.catch((err) => {
		process.stderr.write(
			`pushwork: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
