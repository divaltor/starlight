import { decodeCookies } from "@/lib/utils";
import { parse, validate } from "@telegram-apps/init-data-node";
import { Bot } from "grammy";
import Redis from "ioredis";
import { type NextRequest, NextResponse } from "next/server";
interface CookiesRequest {
	// base64
	cookies: string;
}

interface Config {
	BOT_TOKEN: string;
	REDIS_URL: string;
}

declare global {
	namespace NodeJS {
		interface ProcessEnv extends Config {}
	}
}

const redis = new Redis(process.env.REDIS_URL);
const bot = new Bot(process.env.BOT_TOKEN);

export async function POST(request: NextRequest) {
	const auth = request.headers.get("Authorization");

	if (!auth || !auth.startsWith("tma ")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const initData = auth.slice(4);

	try {
		validate(initData, process.env.BOT_TOKEN);
	} catch (error) {
		return NextResponse.json({ error: "Invalid init data" }, { status: 400 });
	}

	const parsedData = parse(initData);

	if (!parsedData.user) {
		return NextResponse.json({ error: "Invalid init data" }, { status: 400 });
	}

	const { cookies }: CookiesRequest = await request.json();

	if (!cookies) {
		return NextResponse.json({ error: "No cookies provided" }, { status: 400 });
	}

	const decodedCookies = decodeCookies(cookies);

	if (!decodedCookies) {
		return NextResponse.json({ error: "Invalid cookies" }, { status: 400 });
	}

	await redis.set(`user-cookies-${parsedData.user.id}`, JSON.stringify(cookies));

	await bot.api.sendMessage(
		parsedData.user.id,
		"Beep boop, cookies are saved. You can now enable daily parsing using /queue command",
		{
			reply_markup: {
				remove_keyboard: true,
			},
		},
	);

	return NextResponse.json({ success: true });
}
