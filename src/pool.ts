/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order.
 *
 * Used for filesystem fan-out, where unbounded `Promise.all` risks EMFILE on
 * a large tree. Document fan-out is deliberately *not* pooled: a single
 * Subduction connection multiplexes concurrent `repo.find`s and the
 * transport's receive-credit windowing is the backpressure.
 */
export async function pooled<T, R>(
	items: Iterable<T>,
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const list = [...items];
	const out = new Array<R>(list.length);
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < list.length; i = next++) {
			out[i] = await fn(list[i]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, list.length) }, worker),
	);
	return out;
}

/** Concurrent filesystem operations per fan-out. Well under the 256-fd default. */
export const FS_CONCURRENCY = 64;
