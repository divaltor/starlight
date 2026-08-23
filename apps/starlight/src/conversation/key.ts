import { Schema } from "effect";

export const Value = Schema.Struct({
	assistantId: Schema.Int,
	chatId: Schema.Int,
	threadKey: Schema.Int,
});

export type Value = typeof Value.Type;

export async function affinity(key: Value, secret: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		new TextEncoder().encode(`v1/${key.assistantId}/${key.chatId}/${key.threadKey}`),
	);

	return Buffer.from(signature).toString("hex").slice(0, 32);
}
