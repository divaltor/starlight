const PUBLIC_ID_PREFIX = "~";

export const createPublicId = (
	kind: "post" | "media",
	provider: string,
	externalId: string,
	userId: string,
): string =>
	`${PUBLIC_ID_PREFIX}${Buffer.from(JSON.stringify(["v1", kind, provider, externalId, userId])).toString("base64url")}`;

export const parseMediaPublicId = (
	id: string,
): { provider: string; externalId: string; userId?: string } => {
	if (id.startsWith(PUBLIC_ID_PREFIX)) {
		try {
			const decoded = JSON.parse(
				Buffer.from(id.slice(PUBLIC_ID_PREFIX.length), "base64url").toString(),
			) as unknown;
			if (
				Array.isArray(decoded) &&
				decoded.length === 5 &&
				decoded[0] === "v1" &&
				decoded[1] === "media" &&
				typeof decoded[2] === "string" &&
				typeof decoded[3] === "string" &&
				typeof decoded[4] === "string"
			) {
				return { provider: decoded[2], externalId: decoded[3], userId: decoded[4] };
			}
			if (
				Array.isArray(decoded) &&
				decoded.length === 4 &&
				decoded[0] === "media" &&
				typeof decoded[1] === "string" &&
				typeof decoded[2] === "string" &&
				typeof decoded[3] === "string"
			) {
				return { provider: decoded[1], externalId: decoded[2], userId: decoded[3] };
			}
		} catch {
			// Fall through to the established public ID format.
		}
	}
	const separator = id.indexOf(":");
	return separator === -1
		? { provider: "twitter", externalId: id }
		: { provider: id.slice(0, separator), externalId: id.slice(separator + 1) };
};
