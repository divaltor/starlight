import { z } from "zod";

const reactionEmojiSchema = z.enum([
	"😁",
	"🤮",
	"🤡",
	"🤔",
	"😭",
	"🥰",
	"😡",
	"🔥",
	"👏",
	"👌",
	"👎",
	"👍",
	"💔",
	"💯",
]);

const nullableMessageIdSchema = z
	.union([
		z.number().int(),
		z.null(),
		z.string().transform((val) => {
			if (val === "" || val === "null") return null;
			const parsed = Number(val);
			if (Number.isNaN(parsed)) return null;
			return parsed;
		}),
	])
	.pipe(z.number().int().nullable());

export const chatResponseSchema = z.object({
	replies: z
		.array(
			z.discriminatedUnion("type", [
				z.object({
					type: z.literal(["text", "message"]),
					text: z.string().min(1).describe("Response text in character"),
					reply_to: nullableMessageIdSchema
						.describe(
							"How this message attaches in chat. Omit (undefined) to send as a plain chat message with no quote — this is the default and what most replies should do, so it lands naturally in the conversation flow. Use null only when the message needs to attach directly to the message that triggered you (a pointed direct response). Use a specific message #id only when reaching back to a different earlier message",
						)
						.optional(),
				}),
				z.object({
					type: z.literal("reaction"),
					message_id: nullableMessageIdSchema
						.pipe(z.number().int())
						.describe("Message #id to react to"),
					emoji: reactionEmojiSchema.describe("Emoji reaction to send"),
				}),
			]),
		)
		.min(0)
		.max(3),
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;
