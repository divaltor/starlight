export const MAX_MEDIA_DOWNLOAD_BYTES = 50_000_000;
export const MAX_POST_DOWNLOAD_BYTES = 200_000_000;

export const readResponseBounded = async (response: Response, limit = MAX_MEDIA_DOWNLOAD_BYTES) => {
	if (!response.ok) {
		throw new Error(`Media request failed (${response.status})`);
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limit) {
		await response.body?.cancel();
		throw new Error("Media is too large");
	}
	if (!response.body) {
		throw new Error("Media response had no body");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				break;
			}
			total += chunk.value.byteLength;
			if (total > limit) {
				await reader.cancel("Media is too large");
				throw new Error("Media is too large");
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
};
