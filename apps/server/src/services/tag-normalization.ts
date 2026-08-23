export const normalizeTags = (tags: readonly string[]): string[] => {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		const value = tag.trim();
		if (value && !seen.has(value)) {
			seen.add(value);
			normalized.push(value);
		}
	}
	return normalized;
};
