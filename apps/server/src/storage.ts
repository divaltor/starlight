import env from "@/config";
import { S3Client } from "bun";
import Redis from "ioredis";
import { Cookie } from "tough-cookie";

export const redis = new Redis(env.REDIS_URL, {
	connectTimeout: 3,
	enableReadyCheck: true,
	maxRetriesPerRequest: null,
});

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
