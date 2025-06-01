import env from "@/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { Cookie } from "tough-cookie";

const redis = new Redis(env.REDIS_URI, {
	connectTimeout: 3,
	enableReadyCheck: true,
});

class Cookies {
	constructor(private cookies: Cookie[]) {}

	toString() {
		return this.cookies
			.map((cookie) => `${cookie.key}=${cookie.value}`)
			.join("; ");
	}

	toJSON() {
		return this.cookies.map((cookie) => cookie.toJSON());
	}

	static fromJSON(data: string): Cookies {
		const cookies = data
			.split(";")
			.map((cookie) => Cookie.parse(cookie))
			.filter((cookie): cookie is Cookie => cookie !== undefined);
		return new Cookies(cookies);
	}

	getCookies(): Cookie[] {
		return this.cookies;
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
	cookies: Cookies | null;
}

const scrapperQueue = new Queue("scrapper", { connection: redis });

export { redis, Cookies, type SessionData };
