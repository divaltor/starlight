import { Absurd } from "absurd-sdk";
import { env, prisma } from "@starlight/utils";
import sharp from "sharp";
import { logger } from "@/logger";
import { absurdLogger, QUEUES, RETRY } from "@/queue/absurd";
import { classificationApp } from "@/queue/classification";
import { enqueueClassification } from "@/queue/classification-recovery";
import { findSimilarPhotos } from "@/services/duplicate-detection";
import { calculatePerceptualHash } from "@/services/image";
import { normalizeCollectorTags } from "@/services/collector-tags";
import { isMediaResolved, resolveMediaFromAsset } from "@/services/media-resolution";
import {
	MAX_MEDIA_DOWNLOAD_BYTES,
	MAX_POST_DOWNLOAD_BYTES,
	readResponseBounded,
} from "@/services/media-download";
import { s3 } from "@/storage";

export const mediaCollectorApp = new Absurd({
	db: env.DATABASE_URL,
	log: absurdLogger,
	queueName: QUEUES.media,
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
		tags?: string[];
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

mediaCollectorApp.registerTask<MediaCollectorJobData>(
	{ name: "images-collector" },
	async (data) => {
		const { post, userId } = data;
		const tags = normalizeCollectorTags(post.provider, post.tags, post.providerPayload);
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
				text: post.text,
				tags,
				username: post.authorUsername,
				providerPayload: post.providerPayload,
				media: {
					createMany: {
						data: post.media.map((media) => ({
							id: media.externalId,
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
				text: post.text,
				tags,
				username: post.authorUsername,
				providerPayload: post.providerPayload,
				media: {
					createMany: {
						data: post.media.map((media) => ({
							id: media.externalId,
							position: media.position,
							kind: media.kind ?? "image",
							originalUrl: media.url,
						})),
						skipDuplicates: true,
					},
				},
			},
			include: { media: true },
		});

		for (const media of postRecord.media) {
			if (isMediaResolved(media)) {
				if (media.kind === "image" && media.classification === null) {
					await enqueueClassification(
						{ classificationApp, retryStrategy: RETRY.classification, logger },
						media.id,
						post.provider,
						userId,
					);
				}
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

			const hash = await calculatePerceptualHash(bytes);
			const duplicates = await findSimilarPhotos(hash);
			if (duplicates.length > 0) {
				const asset = duplicates[0]!;
				await prisma.media.update({
					where: { mediaId: { id: media.id, userId, provider: post.provider } },
					data: resolveMediaFromAsset(asset),
				});
				logger.info(
					{
						mediaId: media.id,
						provider: post.provider,
						userId,
						assetMediaId: asset.id,
						assetUserId: asset.userId,
					},
					"Duplicate media resolved from existing asset",
				);
				await enqueueClassification(
					{ classificationApp, retryStrategy: RETRY.classification, logger },
					media.id,
					post.provider,
					userId,
				);
				continue;
			}
			const [, metadata] = await Promise.all([
				s3.write(mediaPath, bytes),
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
			await enqueueClassification(
				{ classificationApp, retryStrategy: RETRY.classification, logger },
				media.id,
				post.provider,
				userId,
			);
		}
	},
);
