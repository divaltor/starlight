import { env, getPrismaClient } from "@repo/utils";
import { S3Client } from "bun";
import type { StorageAdapter } from "grammy";
import Redis from "ioredis";
import { Cookie } from "tough-cookie";

export const redis = new Redis(env.REDIS_URL, {
	connectTimeout: 3,
	enableReadyCheck: true,
	maxRetriesPerRequest: null,
});

export const prisma = getPrismaClient();

export class RedisAdapter<T> implements StorageAdapter<T> {
	private redis: Redis;
	private readonly ttl?: number;
	private readonly parseJSON?: boolean;
	/**
	 * @constructor
	 * @param {opts} Constructor options
	 * @param {opts.ttl} ttl - Session time to life in SECONDS.
	 * @param {opts.instance} instance - Instance of redis.
	 * @param {opts.autoParseDates} autoParseDates - set to true to convert string in the json date format to date object
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
			return undefined;
		}

		if (this.parseJSON) {
			return JSON.parse(session) as unknown as T;
		}

		return session as unknown as T;
	}

	async write(key: string, value: T) {
		await this.redis.set(key, JSON.stringify(value));
		if (this.ttl) {
			this.redis.expire(key, this.ttl);
		}
	}

	async delete(key: string) {
		await this.redis.del(key);
	}
}

export interface RFC6265Cookie {
	key: string;
	value: string;
	domain: string;
}

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
		const parsed = JSON.parse(data);

		return new Cookies(
			parsed.map((cookie: RFC6265Cookie) => new Cookie(cookie)),
		);
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
	cookies: RFC6265Cookie[] | null;
}

export const s3 = new S3Client({
	accessKeyId: env.AWS_ACCESS_KEY_ID,
	secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
	endpoint: env.AWS_ENDPOINT,
});

export type { SessionData };
