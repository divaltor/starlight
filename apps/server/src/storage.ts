import { env } from "@starlight/utils";
import Redis from "ioredis";
import { Cookie } from "tough-cookie";

export const redis = new Redis(env.REDIS_URL, {
	connectTimeout: 3,
	enableReadyCheck: true,
	maxRetriesPerRequest: null,
});

export interface RFC6265Cookie {
	domain: string;
	key: string;
	value: string;
}

const TWID_REGEX = /u=(\d+)/;
const DOMAIN_REGEX = /https?:\/\/(.+?)\//;

export class Cookies {
	readonly cookies: Cookie[];

	constructor(cookies: Cookie[]) {
		this.cookies = cookies;
	}

	toString() {
		return this.cookies.map((cookie) => `${cookie.key}=${cookie.value}`).join("; ");
	}

	static fromJSON(data: string): Cookies {
		const parsed = JSON.parse(data);

		return new Cookies(parsed.map((cookie: any) => new Cookie(mapToRFC6265Cookie(cookie))));
	}

	userId() {
		const twidValue = this.cookies.find((cookie) => cookie.key === "twid")?.value;

		if (!twidValue) {
			return;
		}

		const decoded = decodeURIComponent(twidValue);
		const match = decoded.match(TWID_REGEX);
		return match ? match[1] : undefined;
	}
}

export const s3 = new Bun.S3Client({
	accessKeyId: env.AWS_ACCESS_KEY_ID,
	secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	endpoint: env.AWS_ENDPOINT,
});

function extractDomain(hostRaw: string): string {
	const match = hostRaw.match(DOMAIN_REGEX);
	return match?.[1] ?? "x.com";
}

export function mapToRFC6265Cookie(firefoxCookie: any): RFC6265Cookie {
	return {
		key: firefoxCookie["Name raw"],
		value: firefoxCookie["Content raw"],
		domain: extractDomain(firefoxCookie["Host raw"]),
	};
}
