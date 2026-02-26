/** biome-ignore-all lint/performance/noBarrelFile: Barrel file is necessary for the package to work */
export { default as env, getRandomProxy } from "./config";
export { prisma, toUniqueId } from "./db";
export * from "./generated/prisma/client";

export { DbNull, JsonNull } from "./generated/prisma/internal/prismaNamespace";
export * from "./twitter";

export function attachmentLabelFromMimeType(mimeType: string): string {
	if (mimeType.startsWith("image/")) {
		return "photo";
	}

	if (mimeType.startsWith("video/")) {
		return "video";
	}

	if (mimeType.startsWith("audio/")) {
		return "voice message";
	}

	return "file";
}
