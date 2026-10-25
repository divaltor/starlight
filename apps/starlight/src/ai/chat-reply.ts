import { z } from "zod";
import { TelegramDelivery } from "@/conversation/delivery";
import personaPromptText from "@/ai/persona-prompt.txt";
import systemPromptText from "@/ai/system-prompt.txt";

export namespace ChatReply {
  export const systemPrompt = `${personaPromptText}\n\n${systemPromptText}`;
  export const maxOutputTokens = 4096;
  export const maxToolOutputBytes = 16 * 1024;
  export const maxToolCalls = 3;
  export const groupReplyLimit = 3;
  export const privateReplyLimit = 5;

  const reactionEmojiSchema = z.enum(TelegramDelivery.reactionEmojis);

  export const actionSchema = z.union([
    z.object({ type: z.enum(["ignore"]).describe("Stay silent") }),
    z.object({
      replyTo: z.number().int().nullable().optional().describe("LIVE MESSAGE ID to reply to, or null"),
      text: z.string().min(1).describe("Plain-text Telegram reply without Markdown"),
      type: z.enum(["text"]),
    }),
    z.object({
      emoji: reactionEmojiSchema.describe("Telegram reaction emoji"),
      messageId: z.number().int().describe("LIVE MESSAGE ID to react to"),
      type: z.enum(["reaction"]),
    }),
  ]);

  // The widest limit; final_output narrows it to the chat's limit per run.
  export const responseSchema = z.object({
    replies: z.array(actionSchema).min(1).max(privateReplyLimit),
  });

  export type Response = z.infer<typeof responseSchema>;
}
