// Event-loop drift and peak RSS for the bench. A timer that should fire every
// `intervalMs` fires late when the thread is blocked in synchronous work.

type Drift = {
	intervalMs: number;
	thresholdMs: number;
	start: number;
	last: number;
	samples: number;
	events: number;
	maxDriftMs: number;
	totalBlockedMs: number;
};

export type ProfileReport = {
	drift: {
		wallMs: number;
		samples: number;
		events: number;
		maxDriftMs: number;
		totalBlockedMs: number;
		blockedFraction: number;
	} | null;
	peakRssMb: number;
};

let drift: Drift | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let peakRssBytes = 0;

export function startDriftProbe(intervalMs = 50, thresholdMs = 50): void {
	const now = performance.now();
	drift = {
		intervalMs,
		thresholdMs,
		start: now,
		last: now,
		samples: 0,
		events: 0,
		maxDriftMs: 0,
		totalBlockedMs: 0,
	};
	peakRssBytes = 0;
	timer = setInterval(() => {
		const s = drift!;
		const t = performance.now();
		const late = t - s.last - s.intervalMs;
		s.last = t;
		s.samples += 1;
		if (late >= s.thresholdMs) {
			s.events += 1;
			s.totalBlockedMs += late;
			s.maxDriftMs = Math.max(s.maxDriftMs, late);
		}
		peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
	}, intervalMs);
	timer.unref();
}

export function stopDriftProbe(): void {
	if (timer) clearInterval(timer);
	timer = null;
}

export function getProfileReport(): ProfileReport {
	const peakRssMb = Math.round(peakRssBytes / (1024 * 1024));
	if (!drift) return { drift: null, peakRssMb };
	const wallMs = performance.now() - drift.start;
	return {
		drift: {
			wallMs: Math.round(wallMs),
			samples: drift.samples,
			events: drift.events,
			maxDriftMs: Math.round(drift.maxDriftMs),
			totalBlockedMs: Math.round(drift.totalBlockedMs),
			blockedFraction: wallMs > 0 ? drift.totalBlockedMs / wallMs : 0,
		},
		peakRssMb,
	};
}

// A readable line on stderr, so stdout stays one JSON line per run.
export function printProfileReport(label: string): void {
	const r = getProfileReport();
	const d = r.drift;
	const blocked = d
		? `blocks=${d.events} maxDrift=${d.maxDriftMs}ms blocked=${d.totalBlockedMs}ms (${(d.blockedFraction * 100).toFixed(1)}%)`
		: "";
	process.stderr.write(`${label}: ${blocked} peakRss=${r.peakRssMb}MB\n`);
}
