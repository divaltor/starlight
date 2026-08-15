import { createHash } from "node:crypto";

export const createInlineImageResultId = (
	provider: string,
	externalMediaId: string,
	userId: string,
): string =>
	`m_${createHash("sha256")
		.update(JSON.stringify(["v1", provider, externalMediaId, userId]))
		.digest("base64url")}`;

export const createInlineImageIdentityKey = (
	provider: string,
	externalMediaId: string,
	userId: string,
): string => JSON.stringify([provider, externalMediaId, userId]);

export const createInlineImageDedupeKey = (
	provider: string,
	externalMediaId: string,
	userId: string,
	perceptualHash: string | null,
): string =>
	perceptualHash?.trim()
		? JSON.stringify(["hash", provider, perceptualHash.trim(), userId])
		: JSON.stringify(["identity", provider, externalMediaId, userId]);
