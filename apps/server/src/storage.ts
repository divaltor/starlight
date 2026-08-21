import { RedisClient } from "bun";
import { env } from "@starlight/utils";
import { createBunRedisClient } from "bullmq";
import { Cookie } from "tough-cookie";

export const redis = createBunRedisClient(new RedisClient(env.REDIS_URL));

export interface RFC6265Cookie {
	domain: string;
	key: string;
	value: string;
}

// External Firefox cookie-store export shape.
interface FirefoxCookieRecord {
	"Content raw": string;
	"Host raw": string;
	"Name raw": string;
}

const TWID_REGEX = /u=(?<twidValue>\d+)/u;
const DOMAIN_REGEX = /https?:\/\/(?<domain>.+?)\//u;

export class Cookies {
	readonly cookies: Cookie[];

	constructor(cookies: Cookie[]) {
		this.cookies = cookies;
	}

	toString() {
		return this.cookies.map((cookie) => `${cookie.key}=${cookie.value}`).join("; ");
	}

	static fromJSON(data: string): Cookies {
		// Firefox cookie-store export is external input; parse and narrow once at this boundary.
		const parsed = JSON.parse(data) as FirefoxCookieRecord[];

		return new Cookies(parsed.map((cookie) => new Cookie(mapToRFC6265Cookie(cookie))));
	}

	userId() {
		const twidValue = this.cookies.find((cookie) => cookie.key === "twid")?.value;

		if (!twidValue) {
			return;
		}

		const decoded = decodeURIComponent(twidValue);
		const match = decoded.match(TWID_REGEX);
		return match?.groups?.twidValue;
	}
}

export const s3 = new Bun.S3Client({
	accessKeyId: env.AWS_ACCESS_KEY_ID,
	secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	endpoint: env.AWS_ENDPOINT,
});

function extractDomain(hostRaw: string): string {
	const match = hostRaw.match(DOMAIN_REGEX);
	return match?.groups?.domain ?? "x.com";
}

export function mapToRFC6265Cookie(firefoxCookie: FirefoxCookieRecord): RFC6265Cookie {
	return {
		key: firefoxCookie["Name raw"],
		value: firefoxCookie["Content raw"],
		domain: extractDomain(firefoxCookie["Host raw"]),
	};
}
