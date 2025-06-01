import { decodeCookies } from "@/lib/utils";
import { parse, validate } from "@telegram-apps/init-data-node";
import Redis from "ioredis";
import { type NextRequest, NextResponse } from "next/server";
interface CookiesRequest {
	// base64
	cookies: string;
}

// biome-ignore lint/style/noNonNullAssertion: <explanation>
const redis = new Redis(process.env.REDIS_URI!);

export async function POST(request: NextRequest) {
	const auth = request.headers.get("Authorization");

	if (!auth) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		// biome-ignore lint/style/noNonNullAssertion: <explanation>
		const initData = validate(auth, process.env.BOT_TOKEN!);
	} catch (error) {
		return NextResponse.json({ error: "Invalid init data" }, { status: 400 });
	}

	const parsedData = parse(auth);

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

	await redis.set(`user-cookies-${parsedData.user.id}`, cookies);

	return NextResponse.json({ success: true });
}
