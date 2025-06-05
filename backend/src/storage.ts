import env from "@/config";
import { PrismaClient } from "@prisma/client";
import { S3Client } from "bun";
import Redis from "ioredis";
import Sqids from "sqids";
import { Cookie } from "tough-cookie";
import { parse as uuidParse } from "uuid";

export const redis = new Redis(env.REDIS_URL, {
	connectTimeout: 3,
	enableReadyCheck: true,
	maxRetriesPerRequest: null,
});

const sqids = new Sqids({
	minLength: 16,
});

export const prisma = new PrismaClient({
	log:
		env.LOG_LEVEL === "debug"
			? ["query", "info", "warn", "error"]
			: ["info", "warn", "error"],
}).$extends({
	result: {
		photo: {
			externalId: {
				needs: {
					id: true,
					userId: true,
				},
				compute(data) {
					// Split Twitter ID into 3 parts to handle large numbers that exceed bigint
					const id = data.id;
					const chunkSize = Math.ceil(id.length / 3);

					const parts = [
						id.slice(0, chunkSize),
						id.slice(chunkSize, chunkSize * 2),
						id.slice(chunkSize * 2),
					].map((part) => Number.parseInt(part || "0"));

					const userId = uuidParse(data.userId);

					return sqids.encode([...parts, ...userId]);
				},
			},
			s3Url: {
				needs: {
					s3Path: true,
				},
				compute(data) {
					if (!data.s3Path) return undefined;

					return `${env.BASE_CDN_URL}/${data.s3Path}`;
				},
			},
		},
	},
});

export const tweetKey = (
	telegramUserId: string | number,
	tweetId: string | undefined,
) => `tweet:${telegramUserId}:${tweetId}`;
export const timelineKey = (userId: string | number) => `timeline:${userId}`;
export const perceptualHashKey = (userId: string) =>
	`perceptual-hash:${userId}`;

export const imageUrl = (photoId: string) =>
	`${env.BASE_CDN_URL}/media/${photoId}`;

export class Cookies {
	constructor(private cookies: Cookie[]) {
		this.cookies = cookies;
	}

	toString() {
		return this.cookies
			.map((cookie) => `${cookie.key}=${cookie.value}`)
			.join("; ");
	}

	static fromJSON(data: string): Cookies {
		const cookies = data
			.split(";")
			.map((cookie) => Cookie.parse(cookie))
			.filter((cookie): cookie is Cookie => cookie !== undefined);
		return new Cookies(cookies);
	}

	userId() {
		const twidValue = this.cookies.find(
			(cookie) => cookie.key === "twid",
		)?.value;

		if (!twidValue) return undefined;

		const decoded = decodeURIComponent(twidValue);
		const match = decoded.match(/u=(\d+)/);
		return match ? match[1] : undefined;
	}
}

interface SessionData {
	cookies: string | null;
}

export const s3 = new S3Client({
	accessKeyId: env.AWS_ACCESS_KEY_ID,
	secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	endpoint: env.AWS_ENDPOINT,
});

export type { SessionData };
