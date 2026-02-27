import { z } from "zod";

export const chatResponseSchema = z.object({
	replies: z
		.array(
			z.object({
				text: z.string().min(1).describe("Response text in character"),
				reply_to: z
					.number()
					.int()
					.nullable()
					.describe("Message #id to reply to, null to reply to the triggering message"),
			}),
		)
		.min(1)
		.max(3),
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;
