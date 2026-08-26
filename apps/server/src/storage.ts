import { RedisClient } from "bun";
import { env } from "@starlight/utils";
import { createBunRedisClient } from "bullmq";
import { Schema, SchemaGetter } from "effect";
import { Cookie } from "tough-cookie";

export const redis = createBunRedisClient(new RedisClient(env.REDIS_URL));

export const RFC6265Cookie = Schema.Struct({
  domain: Schema.String,
  key: Schema.String,
  value: Schema.String,
});
export type RFC6265Cookie = typeof RFC6265Cookie.Type;

const FirefoxCookieRecord = Schema.Struct({
  "Content raw": Schema.String,
  "Host raw": Schema.String,
  "Name raw": Schema.String,
}).pipe(
  Schema.decodeTo(RFC6265Cookie, {
    decode: SchemaGetter.transform((cookie) => ({
      domain: cookie["Host raw"].match(DOMAIN_REGEX)?.groups?.domain ?? "x.com",
      key: cookie["Name raw"],
      value: cookie["Content raw"],
    })),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
);
const FirefoxCookiesFromJson = Schema.fromJsonString(Schema.Array(FirefoxCookieRecord));

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
    const parsed = Schema.decodeSync(FirefoxCookiesFromJson)(data);

    return new Cookies(parsed.map((cookie) => new Cookie(cookie)));
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
