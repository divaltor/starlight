import { logger } from "@/logger.js";
import { prisma } from "../storage.js";
import { calculateHashDistance, calculatePerceptualHash } from "./image.js";

interface SimilarPhoto {
	id: string;
	userId: string;
	perceptualHash: string;
	distance: number;
	s3Path?: string;
	originalUrl: string;
	tweetId: string;
}

export async function findSimilarPhotos(
	targetHash: string,
	maxDistance = 10,
	excludePhotoId?: string,
	excludeUserId?: string,
): Promise<SimilarPhoto[]> {
	const buckets = [
		{ len: 12, field: "hashBucket12" as const, maxCandidates: 50 },
		{ len: 8, field: "hashBucket8" as const, maxCandidates: 200 },
		{ len: 4, field: "hashBucket4" as const, maxCandidates: 1000 },
	];

	for (const { len, field, maxCandidates } of buckets) {
		const prefix = targetHash.substring(0, len);

		logger.debug(
			{ prefix, field, maxCandidates },
			"Searching for similar photos",
		);

		const candidates = await prisma.photo.findMany({
			where: {
				[field]: prefix,
				perceptualHash: { not: null },
				deletedAt: null,
				NOT:
					excludePhotoId && excludeUserId
						? {
								AND: [{ id: excludePhotoId }, { userId: excludeUserId }],
							}
						: undefined,
			},
			select: {
				id: true,
				userId: true,
				perceptualHash: true,
				s3Path: true,
				originalUrl: true,
				tweetId: true,
			},
			take: maxCandidates,
		});

		if (candidates.length === 0) continue;

		// If we got results and didn't hit the limit, process them
		if (candidates.length < maxCandidates) {
			const similarPhotos: SimilarPhoto[] = [];

			for (const candidate of candidates) {
				if (!candidate.perceptualHash) continue;

				const distance = calculateHashDistance(
					targetHash,
					candidate.perceptualHash,
				);

				if (distance <= maxDistance) {
					similarPhotos.push({
						id: candidate.id,
						userId: candidate.userId,
						perceptualHash: candidate.perceptualHash,
						distance,
						s3Path: candidate.s3Path || undefined,
						originalUrl: candidate.originalUrl,
						tweetId: candidate.tweetId,
					});
				}
			}

			// Sort by distance (most similar first)
			return similarPhotos.sort((a, b) => a.distance - b.distance);
		}
	}

	return [];
}

export async function findDuplicatesByImageContent(
	imageContent: ArrayBuffer,
	maxDistance = 10,
): Promise<SimilarPhoto[]> {
	const targetHash = await calculatePerceptualHash(imageContent);

	logger.debug({ targetHash }, "Calculated target hash");

	return await findSimilarPhotos(targetHash, maxDistance);
}
