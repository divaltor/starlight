import { PrismaPg } from "@prisma/adapter-pg";
import Sqids from "sqids";
import { parse as uuidParse } from "uuid";
import env from "./config";
import { PrismaClient, type Prisma as PrismaGenerated } from "./generated/prisma/client";

const sqids = new Sqids({
	minLength: 12,
});

export const toUniqueId = (id: number) => sqids.encode([Math.abs(id)]);

const adapter = new PrismaPg({
	connectionString: env.DATABASE_URL,
});

const onlyNotDeletedMessages = <
	T extends {
		where?: PrismaGenerated.MessageWhereInput;
	},
>(
	args: T,
): T => {
	const where = args.where as Record<string, unknown> | undefined;
	if (where?.deletedAt !== undefined) {
		return args;
	}

	args.where = {
		...args.where,
		deletedAt: null,
	} as PrismaGenerated.MessageWhereInput;

	return args;
};

const isMessageReadOperation = (operation: string) => {
	return (
		operation === "findUnique" ||
		operation === "findUniqueOrThrow" ||
		operation === "findMany" ||
		operation === "findFirst" ||
		operation === "findFirstOrThrow" ||
		operation === "count" ||
		operation === "aggregate" ||
		operation === "groupBy"
	);
};

export const prisma = new PrismaClient({
	log: env.NODE_ENV === "production" ? ["warn", "error"] : ["info", "warn", "error"],
	adapter,
}).$extends({
	query: {
		message: {
			$allOperations({ operation, args, query }) {
				if (isMessageReadOperation(operation)) {
					return query(
						onlyNotDeletedMessages(
							args as {
								where?: PrismaGenerated.MessageWhereInput;
							},
						),
					);
				}

				return query(args);
			},
		},
	},
	result: {
		attachment: {
			base64Data: {
				needs: { id: true },
				compute() {
					return undefined as string | undefined;
				},
			},
		},
		photo: {
			externalId: {
				needs: {
					id: true,
					userId: true,
				},
				compute(data: { id: string; userId: string }) {
					// Split Twitter ID into 3 parts to handle large numbers that exceed bigint
					const id = data.id;
					const chunkSize = Math.ceil(id.length / 3);

					const parts = [
						id.slice(0, chunkSize),
						id.slice(chunkSize, chunkSize * 2),
						id.slice(chunkSize * 2),
					].map((part) => Number.parseInt(part || "0", 10));

					const userId = uuidParse(data.userId);

					return sqids.encode([...parts, ...userId]);
				},
			},
			s3Url: {
				needs: {
					s3Path: true,
				},
				compute(data: { s3Path: string }) {
					if (!(data.s3Path && env.BASE_CDN_URL)) {
						return;
					}

					return `${env.BASE_CDN_URL}/${data.s3Path}`;
				},
			},
		},
		chat: {
			thumbnailUrl: {
				needs: {
					photoThumbnail: true,
				},
				compute(data: { photoThumbnail: string }) {
					if (!data.photoThumbnail) {
						return;
					}

					return `${env.BASE_CDN_URL}/${data.photoThumbnail}`;
				},
			},
			bigUrl: {
				needs: {
					photoBig: true,
				},
				compute(data: { photoBig: string }) {
					if (!(data.photoBig && env.BASE_CDN_URL)) {
						return;
					}

					return `${env.BASE_CDN_URL}/${data.photoBig}`;
				},
			},
		},
	},
	model: {
		photo: {
			available: () => ({
				deletedAt: null,
				s3Path: { not: null },
			}),
			unpublished: (chatId: number | string | bigint) => ({
				deletedAt: null,
				s3Path: { not: null },
				publishedPhotos: { none: { chatId: Number(chatId) } },
			}),
		} satisfies Record<string, (...args: any) => PrismaGenerated.PhotoWhereInput>,
		tweet: {
			available: () => ({
				photos: {
					some: {
						deletedAt: null,
						s3Path: { not: null },
					},
				},
			}),
		} satisfies Record<string, (...args: any) => PrismaGenerated.TweetWhereInput>,
		message: {
			async hasNewerMessages(params: {
				chatId: bigint | number;
				messageId: number;
				messageThreadId: number | null | undefined;
			}): Promise<boolean> {
				const newerMessage = await prisma.message.findFirst({
					where: {
						chatId: BigInt(params.chatId),
						messageThreadId: params.messageThreadId,
						messageId: { gt: params.messageId },
						fromId: { not: null },
						rawData: {
							path: ["from", "is_bot"],
							equals: false,
						},
					},
					select: { messageId: true },
					orderBy: { messageId: "desc" },
				});

				return newerMessage !== null;
			},
		},
	},
});
