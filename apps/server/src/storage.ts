import { getTwitterUserId, parseTwitterCookies } from "@starlight/api/services/twitter-cookies";
import { env } from "@starlight/utils";
import { Cookie } from "tough-cookie";

export class Cookies {
	readonly cookies: Cookie[];

	constructor(cookies: Cookie[]) {
		this.cookies = cookies;
	}

	toString() {
		return this.cookies.map((cookie) => `${cookie.key}=${cookie.value}`).join("; ");
	}

	static fromJSON(data: string): Cookies {
		return new Cookies(parseTwitterCookies(data).map((cookie) => new Cookie(cookie)));
	}

	userId() {
		return getTwitterUserId(
			this.cookies.map((cookie) => ({
				domain: cookie.domain ?? "",
				key: cookie.key,
				value: cookie.value,
			})),
		);
	}
}

export const s3 = new Bun.S3Client({
	accessKeyId: env.AWS_ACCESS_KEY_ID,
	secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	endpoint: env.AWS_ENDPOINT,
});
