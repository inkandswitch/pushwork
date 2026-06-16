/**
 * Lightweight profiling + event-loop drift instrumentation for the bench.
 *
 * The most useful signal is *event-loop drift*: a monotonic timer that
 * should fire every `intervalMs` but fires late when the thread is blocked
 * in synchronous work. Drift discriminates "CPU-blocked" from
 * "idle-waiting on the network" — the former is what starves Automerge's
 * Wasm of the thread, missing sync-server pongs and stalling responses.
 *
 * Everything here is a no-op unless profiling is enabled, so the optional
 * span wrappers add a single boolean check when off.
 *
 * Output goes to stderr so it never contaminates a command's stdout; a
 * single machine-readable `PROFILE_JSON { ... }` line is emitted for the
 * bench harness to parse.
 */

let enabled = !!process.env.PUSHWORK_PROFILE;

export function setProfilingEnabled(on: boolean): void {
	enabled = on;
}

export function isProfilingEnabled(): boolean {
	return enabled;
}

interface PhaseStat {
	totalMs: number;
	count: number;
	maxMs: number;
}

interface DriftState {
	intervalMs: number;
	thresholdMs: number;
	last: number;
	start: number;
	samples: number;
	events: number;
	maxDriftMs: number;
	maxDriftSpan: string;
	totalBlockedMs: number;
}

const phases = new Map<string, PhaseStat>();
const counters = new Map<string, number>();

// Stack of currently-open profile spans, so the drift probe can attribute
// the longest block to whatever phase was running when it happened.
const activeSpans: string[] = [];
let peakRssBytes = 0;
let driftTimer: ReturnType<typeof setInterval> | null = null;
let drift: DriftState | null = null;

function record(name: string, ms: number): void {
	const p = phases.get(name) ?? { totalMs: 0, count: 0, maxMs: 0 };
	p.totalMs += ms;
	p.count += 1;
	if (ms > p.maxMs) p.maxMs = ms;
	phases.set(name, p);
}

/** Time a synchronous span. No-op (just calls `fn`) when disabled. */
export function profileSync<T>(name: string, fn: () => T): T {
	if (!enabled) return fn();
	const start = performance.now();
	activeSpans.push(name);
	try {
		return fn();
	} finally {
		activeSpans.pop();
		record(name, performance.now() - start);
	}
}

/** Time an async span. No-op (just calls `fn`) when disabled. */
export async function profileAsync<T>(
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (!enabled) return fn();
	const start = performance.now();
	activeSpans.push(name);
	try {
		return await fn();
	} finally {
		activeSpans.pop();
		record(name, performance.now() - start);
	}
}

/** Accumulate a named counter (e.g. docs created, chars diffed). */
export function count(name: string, n = 1): void {
	if (!enabled) return;
	counters.set(name, (counters.get(name) ?? 0) + n);
}

/**
 * Start the event-loop drift probe. Samples actual-vs-expected interval
 * timing; a tick arriving `>= thresholdMs` late means the loop was blocked.
 * Also samples RSS each tick to capture peak memory. The timer is `unref`'d
 * so it never keeps the process alive.
 */
export function startDriftProbe(intervalMs = 50, thresholdMs = 50): void {
	if (!enabled || driftTimer) return;
	const now = performance.now();
	drift = {
		intervalMs,
		thresholdMs,
		last: now,
		start: now,
		samples: 0,
		events: 0,
		maxDriftMs: 0,
		maxDriftSpan: "",
		totalBlockedMs: 0,
	};
	driftTimer = setInterval(() => {
		const t = performance.now();
		const s = drift!;
		const elapsed = t - s.last;
		s.last = t;
		s.samples += 1;
		const d = elapsed - s.intervalMs;
		if (d >= s.thresholdMs) {
			s.events += 1;
			s.totalBlockedMs += d;
			if (d > s.maxDriftMs) {
				s.maxDriftMs = d;
				s.maxDriftSpan = activeSpans[activeSpans.length - 1] ?? "(none)";
			}
		}
		const rss = process.memoryUsage().rss;
		if (rss > peakRssBytes) peakRssBytes = rss;
	}, intervalMs);

	// Don't hold the process open for the probe.
	(driftTimer as { unref?: () => void }).unref?.();
}

export function stopDriftProbe(): void {
	if (driftTimer) {
		clearInterval(driftTimer);
		driftTimer = null;
	}
}

export interface ProfileReport {
	phases: Array<{ name: string; totalMs: number; count: number; maxMs: number }>;
	counters: Record<string, number>;
	drift: {
		wallMs: number;
		samples: number;
		events: number;
		maxDriftMs: number;
		maxDriftSpan: string;
		totalBlockedMs: number;
		blockedFraction: number;
	} | null;
	peakRssMb: number;
}

export function getProfileReport(): ProfileReport {
	const phaseList = Array.from(phases.entries())
		.map(([name, p]) => ({
			name,
			totalMs: Math.round(p.totalMs),
			count: p.count,
			maxMs: Math.round(p.maxMs),
		}))
		.sort((a, b) => b.totalMs - a.totalMs);

	let driftReport: ProfileReport["drift"] = null;
	if (drift) {
		const wallMs = performance.now() - drift.start;
		driftReport = {
			wallMs: Math.round(wallMs),
			samples: drift.samples,
			events: drift.events,
			maxDriftMs: Math.round(drift.maxDriftMs),
			maxDriftSpan: drift.maxDriftSpan,
			totalBlockedMs: Math.round(drift.totalBlockedMs),
			blockedFraction: wallMs > 0 ? drift.totalBlockedMs / wallMs : 0,
		};
	}

	return {
		phases: phaseList,
		counters: Object.fromEntries(counters),
		drift: driftReport,
		peakRssMb: Math.round(peakRssBytes / (1024 * 1024)),
	};
}

export function resetProfile(): void {
	phases.clear();
	counters.clear();
	peakRssBytes = 0;
	drift = null;
}

/**
 * Write the report to stderr (human table) plus one machine-readable
 * `PROFILE_JSON {...}` line for the bench harness to parse.
 */
export function printProfileReport(label = "sync"): void {
	if (!enabled) return;
	const r = getProfileReport();
	const lines: string[] = [];
	lines.push(`\n=== pushwork profile: ${label} ===`);

	if (r.drift) {
		const pct = (r.drift.blockedFraction * 100).toFixed(1);
		lines.push(
			`event-loop: wall=${r.drift.wallMs}ms  blocks(>=thresh)=${r.drift.events}` +
				`  maxDrift=${r.drift.maxDriftMs}ms in [${r.drift.maxDriftSpan}]  blocked=${r.drift.totalBlockedMs}ms (${pct}%)`,
		);
	}
	lines.push(`peak RSS: ${r.peakRssMb} MB`);

	if (r.phases.length > 0) {
		lines.push("phases (by total ms):");
		for (const p of r.phases) {
			lines.push(
				`  ${p.name.padEnd(28)} ${String(p.totalMs).padStart(8)}ms  ` +
					`n=${String(p.count).padStart(6)}  max=${p.maxMs}ms`,
			);
		}
	}
	if (Object.keys(r.counters).length > 0) {
		lines.push("counters:");
		for (const [k, v] of Object.entries(r.counters)) {
			lines.push(`  ${k.padEnd(28)} ${v}`);
		}
	}

	process.stderr.write(lines.join("\n") + "\n");
	process.stderr.write(`PROFILE_JSON ${JSON.stringify(r)}\n`);
}
