#!/usr/bin/env node
import * as fs from "fs";

const args = process.argv.slice(2);
const flag = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};

const basePath = flag("--base", "");
const headPath = flag("--head", "");
const baseLabel = flag("--base-label", "base");
const headLabel = flag("--head-label", "head");
const threshold = parseFloat(flag("--threshold", "20"));

function read(path) {
	if (!path || !fs.existsSync(path)) return [];
	return fs
		.readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l));
}

function key(run) {
	const c = run.config;
	return `${run.mode} files=${c.files} size=${c.size}B text=${c.text} backend=${c.backend}`;
}

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function group(runs) {
	const out = new Map();
	for (const run of runs) {
		const k = key(run);
		if (!out.has(k)) out.set(k, []);
		out.get(k).push(run);
	}
	return out;
}

function stats(runs) {
	const ms = runs.map((r) => r.syncMs);
	const rss = runs.map((r) => r.peakRssMb);
	const blocked = runs.map((r) => Math.round(r.drift?.totalBlockedMs ?? 0));
	return {
		n: runs.length,
		medianMs: median(ms),
		minMs: Math.min(...ms),
		medianRss: median(rss),
		medianBlocked: median(blocked),
	};
}

const baseRuns = group(read(basePath));
const headRuns = group(read(headPath));

const scenarios = [...new Set([...baseRuns.keys(), ...headRuns.keys()])].sort();

const rows = [];
let regressions = 0;

for (const scenario of scenarios) {
	const b = baseRuns.get(scenario);
	const h = headRuns.get(scenario);
	if (!b || !h) {
		rows.push({ scenario, missing: b ? headLabel : baseLabel });
		continue;
	}
	const bs = stats(b);
	const hs = stats(h);
	const delta = ((hs.medianMs - bs.medianMs) / bs.medianMs) * 100;
	if (delta > threshold) regressions++;
	rows.push({ scenario, base: bs, head: hs, delta });
}

const sign = (d) => (d >= 0 ? "+" : "") + d.toFixed(1) + "%";
const mark = (d) => (d > threshold ? "🔴" : d < -threshold ? "🟢" : "⚪️");

const out = [];
out.push(`### bench: \`${headLabel}\` vs \`${baseLabel}\``);
out.push("");

if (rows.length === 0) {
	out.push("No benchmark results were produced.");
} else {
	out.push(
		`| | scenario | ${baseLabel} median | ${headLabel} median | delta | ${baseLabel} min | ${headLabel} min | peak RSS |`,
	);
	out.push("|---|---|---|---|---|---|---|---|");
	for (const r of rows) {
		if (r.missing) {
			out.push(`| ⚠️ | \`${r.scenario}\` | missing on ${r.missing} | | | | | |`);
			continue;
		}
		out.push(
			`| ${mark(r.delta)} | \`${r.scenario}\` | ${r.base.medianMs}ms | ${r.head.medianMs}ms | ${sign(r.delta)} | ` +
				`${r.base.minMs}ms | ${r.head.minMs}ms | ${r.base.medianRss} → ${r.head.medianRss} MB |`,
		);
	}
	out.push("");
	const n = rows.find((r) => r.base)?.base.n ?? 0;
	out.push(
		`Median of ${n} run(s) per scenario, base and head interleaved on one runner. ` +
			`Offline paths only — no network. Most of this wall clock is LMDB commit fsync, ` +
			`which varies up to 2x run-to-run on shared CI hardware, so deltas under ${threshold}% ` +
			`are noise and even a larger one wants a local profile before it counts as a regression.`,
	);
}

const md = out.join("\n");
process.stdout.write(md + "\n");

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) fs.appendFileSync(summary, md + "\n");

const outFile = flag("--out", "");
if (outFile) fs.writeFileSync(outFile, md + "\n");

if (args.includes("--fail-on-regression") && regressions > 0) {
	console.error(`${regressions} scenario(s) regressed by more than ${threshold}%`);
	process.exit(1);
}
