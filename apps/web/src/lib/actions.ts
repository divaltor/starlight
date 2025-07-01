"use server";

import { CookieEncryption } from "@repo/crypto";
import { env } from "@repo/utils";
import { Bot } from "grammy";
import Redis from "ioredis";

export const redis = new Redis(env.REDIS_URL);
export const bot = new Bot(env.BOT_TOKEN);
export const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);
