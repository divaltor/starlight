export interface SleepOptions {
	/** Maximum milliseconds to sleep (inclusive) */
	maxMs: number;
	/** Minimum milliseconds to sleep (inclusive) */
	minMs: number;
}

export async function sleep(ms: number, options?: SleepOptions): Promise<void> {
	let duration = ms;

	if (options && options.minMs <= options.maxMs) {
		duration = Math.random() * (options.maxMs - options.minMs) + options.minMs;
	}

	if (duration <= 0) {
		return;
	}

	await Bun.sleep(duration);
}
