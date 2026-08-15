import { Absurd } from "absurd-sdk";
import { env, prisma } from "@starlight/utils";
import sharp from "sharp";
import { logger } from "@/logger";
import { absurdLogger, QUEUES, RETRY } from "@/queue/absurd";
import { classificationApp } from "@/queue/classification";
import { findDuplicatesByImageContent } from "@/services/duplicate-detection";
import { calculatePerceptualHash } from "@/services/image";
import {
	MAX_MEDIA_DOWNLOAD_BYTES,
	MAX_POST_DOWNLOAD_BYTES,
	readResponseBounded,
} from "@/services/media-download";
import { s3 } from "@/storage";

export const imagesApp = new Absurd({
	db: env.DATABASE_URL,
	log: absurdLogger,
	queueName: QUEUES.images,
});

export interface MediaCollectorJobData {
	userId: string;
	post: {
		provider: string;
		externalId: string;
		sourceUrl: string;
		authorExternalId?: string;
		authorName?: string;
		authorUsername?: string;
		title?: string;
		text?: string;
		providerPayload: object;
		media: Array<{
			externalId: string;
			url: string;
			kind?: string;
			position: number;
			fetchHeaders?: Record<string, string>;
		}>;
	};
}

imagesApp.registerTask<MediaCollectorJobData>({ name: "images-collector" }, async (data) => {
	const { post, userId } = data;
	let downloadedBytes = 0;
	const postRecord = await prisma.post.upsert({
		where: { postId: { id: post.externalId, userId, provider: post.provider } },
		create: {
			id: post.externalId,
			userId,
			provider: post.provider,
			sourceUrl: post.sourceUrl,
			authorExternalId: post.authorExternalId,
			authorName: post.authorName,
			authorUsername: post.authorUsername,
			title: post.title,
			providerPayload: { ...post.providerPayload, text: post.text, username: post.authorUsername },
			photos: {
				createMany: {
					data: post.media.map((media) => ({
						id: media.externalId,
						provider: post.provider,
						position: media.position,
						kind: media.kind ?? "image",
						originalUrl: media.url,
					})),
					skipDuplicates: true,
				},
			},
		},
		update: {
			sourceUrl: post.sourceUrl,
			authorExternalId: post.authorExternalId,
			authorName: post.authorName,
			authorUsername: post.authorUsername,
			title: post.title,
			providerPayload: { ...post.providerPayload, text: post.text, username: post.authorUsername },
			photos: {
				createMany: {
					data: post.media.map((media) => ({
						id: media.externalId,
						provider: post.provider,
						position: media.position,
						kind: media.kind ?? "image",
						originalUrl: media.url,
					})),
					skipDuplicates: true,
				},
			},
		},
		include: { photos: true },
	});

	for (const media of postRecord.photos) {
		if (media.s3Path && (media.kind !== "image" || media.perceptualHash)) {
			continue;
		}
		const input = post.media.find((item) => item.externalId === media.id);
		if (!input) {
			throw new Error(`Media ${media.id} is missing from collector payload`);
		}
		const remainingBytes = MAX_POST_DOWNLOAD_BYTES - downloadedBytes;
		if (remainingBytes <= 0) {
			throw new Error("Post media is too large");
		}
		const bytes = await readResponseBounded(
			await fetch(media.originalUrl, { headers: input.fetchHeaders }),
			Math.min(MAX_MEDIA_DOWNLOAD_BYTES, remainingBytes),
		);
		downloadedBytes += bytes.byteLength;
		const extension = new URL(media.originalUrl).pathname.split(".").at(-1) ?? "jpg";
		const mediaPath = `media/${post.provider}/${userId}/${media.id}.${extension}`;

		if (media.kind !== "image") {
			await s3.write(mediaPath, bytes);
			await prisma.media.update({
				where: { mediaId: { id: media.id, userId, provider: post.provider } },
				data: { s3Path: mediaPath },
			});
			continue;
		}

		const duplicates = await findDuplicatesByImageContent(bytes);
		if (duplicates.length > 0) {
			logger.info(
				{ mediaId: media.id, provider: post.provider, userId },
				"Duplicate media skipped",
			);
			continue;
		}
		const [, hash, metadata] = await Promise.all([
			s3.write(mediaPath, bytes),
			calculatePerceptualHash(bytes),
			sharp(bytes)
				.metadata()
				.catch(() => ({ height: null, width: null })),
		]);
		await prisma.media.update({
			where: { mediaId: { id: media.id, userId, provider: post.provider } },
			data: {
				perceptualHash: hash,
				s3Path: mediaPath,
				height: metadata.height,
				width: metadata.width,
			},
		});
		await classificationApp.spawn(
			"classification",
			{ photoId: media.id, provider: post.provider, userId },
			{
				idempotencyKey: `classify-${post.provider}-${userId}-${media.id}`,
				maxAttempts: 5,
				retryStrategy: RETRY.classification,
			},
		);
	}
});
