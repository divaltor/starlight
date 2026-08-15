import { prisma } from "@starlight/utils";
import { logger } from "@/logger";
import { calculateHashDistance, calculatePerceptualHash } from "./image";

interface SimilarPhoto {
	distance: number;
	id: string;
	originalUrl: string;
	perceptualHash: string;
	s3Path: string;
	height: number | null;
	width: number | null;
	sourceUrl: string;
	postId: string;
	userId: string;
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
	const similarPhotos = new Map<string, SimilarPhoto>();

	for (const { len, field, maxCandidates } of buckets) {
		const prefix = targetHash.substring(0, len);

		logger.debug({ prefix, field, maxCandidates }, "Searching for similar photos");

		const candidates = await prisma.media.findMany({
			where: {
				[field]: prefix,
				perceptualHash: { not: null },
				s3Path: { not: null },
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
				postId: true,
				height: true,
				width: true,
				post: { select: { sourceUrl: true } },
			},
			take: maxCandidates,
		});

		if (candidates.length === 0) {
			continue;
		}

		for (const candidate of candidates) {
			const distance = calculateHashDistance(targetHash, candidate.perceptualHash!);

			if (distance <= maxDistance) {
				const similarPhoto = {
					id: candidate.id,
					userId: candidate.userId,
					perceptualHash: candidate.perceptualHash!,
					distance,
					s3Path: candidate.s3Path!,
					originalUrl: candidate.originalUrl,
					postId: candidate.postId,
					sourceUrl: candidate.post.sourceUrl,
					height: candidate.height,
					width: candidate.width,
				};
				similarPhotos.set(`${candidate.id}:${candidate.userId}:${candidate.s3Path}`, similarPhoto);
			}
		}
	}

	return [...similarPhotos.values()].sort((a, b) => a.distance - b.distance);
}

export async function findDuplicatesByImageContent(
	imageContent: Parameters<typeof calculatePerceptualHash>[0],
	maxDistance = 10,
): Promise<SimilarPhoto[]> {
	const targetHash = await calculatePerceptualHash(imageContent);

	logger.debug({ targetHash }, "Calculated target hash");

	return await findSimilarPhotos(targetHash, maxDistance);
}
