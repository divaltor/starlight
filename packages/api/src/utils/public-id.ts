const PUBLIC_ID_PREFIX = "~";
const LEGACY_TWITTER_MEDIA_ID = /^\d+$/;

export const createPublicId = (
	kind: "post" | "media",
	provider: string,
	externalId: string,
	userId: string,
): string =>
	`${PUBLIC_ID_PREFIX}${Buffer.from(JSON.stringify(["v1", kind, provider, externalId, userId])).toString("base64url")}`;

export const parseMediaPublicId = (
	id: string,
): { provider: string; externalId: string; userId?: string } | null => {
	if (!id.startsWith(PUBLIC_ID_PREFIX)) {
		return LEGACY_TWITTER_MEDIA_ID.test(id) ? { provider: "twitter", externalId: id } : null;
	}

	try {
		const encoded = id.slice(PUBLIC_ID_PREFIX.length);
		const bytes = Buffer.from(encoded, "base64url");
		const decoded: unknown = JSON.parse(bytes.toString());
		if (
			bytes.toString("base64url") !== encoded ||
			!Array.isArray(decoded) ||
			decoded.length !== 5 ||
			decoded[0] !== "v1" ||
			decoded[1] !== "media" ||
			decoded
				.slice(2)
				.some((value) => typeof value !== "string" || value.trim() !== value || value.length === 0)
		) {
			return null;
		}
		return { provider: decoded[2], externalId: decoded[3], userId: decoded[4] };
	} catch {
		return null;
	}
};
