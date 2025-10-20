import { env } from "@starlight/utils";
import type { StorageAdapter } from "grammy";
import Redis from "ioredis";
import { Cookie } from "tough-cookie";

export const redis = new Redis(env.REDIS_URL, {
	connectTimeout: 3,
	enableReadyCheck: true,
	maxRetriesPerRequest: null,
});

export class RedisAdapter<T> implements StorageAdapter<T> {
	readonly redis: Redis;
	private readonly ttl?: number;
	private readonly parseJSON?: boolean;
	/**
	 * @constructor
	 * @param {opts} Constructor options
	 * @param {opts.ttl} ttl - Session time to life in SECONDS.
	 * @param {opts.instance} instance - Instance of redis.
	 * @param {opts.parseJSON} parseJSON - Set to true to parse JSON.
	 */
	constructor({
		instance,
		ttl,
		parseJSON,
	}: { instance?: Redis; ttl?: number; parseJSON?: boolean }) {
		if (instance) {
			this.redis = instance;
		} else {
			throw new Error("You should pass redis instance to constructor.");
		}

		this.ttl = ttl;
		this.parseJSON = parseJSON;
	}

	async read(key: string) {
		const session = await this.redis.get(key);

		if (session === null || session === undefined) {
			return;
		}

		if (this.parseJSON) {
			return JSON.parse(session) as unknown as T;
		}

		return session as unknown as T;
	}

	async write(key: string, value: T) {
		if (this.parseJSON) {
			await this.redis.set(key, JSON.stringify(value));
		} else {
			await this.redis.set(key, value as string);
		}

		if (this.ttl) {
			this.redis.expire(key, this.ttl);
		}
	}

	async delete(key: string) {
		await this.redis.del(key);
	}
}

export type RFC6265Cookie = {
	key: string;
	value: string;
	domain: string;
};

const TWID_REGEX = /u=(\d+)/;

export class Cookies {
	readonly cookies: Cookie[];

	constructor(cookies: Cookie[]) {
		this.cookies = cookies;
	}

	toString() {
		return this.cookies
			.map((cookie) => `${cookie.key}=${cookie.value}`)
			.join("; ");
	}

	static fromJSON(data: string): Cookies {
		const parsed = JSON.parse(data);

		return new Cookies(
			parsed.map((cookie: RFC6265Cookie) => new Cookie(cookie))
		);
	}

	userId() {
		const twidValue = this.cookies.find(
			(cookie) => cookie.key === "twid"
		)?.value;

		if (!twidValue) {
			return;
		}

		const decoded = decodeURIComponent(twidValue);
		const match = decoded.match(TWID_REGEX);
		return match ? match[1] : undefined;
	}
}

type SessionData = {
	cookies: RFC6265Cookie[] | null;
};

// biome-ignore lint/correctness/noUndeclaredVariables: Global in runtime
export const s3 = new Bun.S3Client({
	accessKeyId: env.AWS_ACCESS_KEY_ID,
	secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	endpoint: env.AWS_ENDPOINT,
});

export type { SessionData };
