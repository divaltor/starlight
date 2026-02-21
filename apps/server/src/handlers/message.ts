import { Composer } from "grammy";
import type { Context } from "@/bot";
import { shouldReplyToMessage } from "@/utils/message";

const composer = new Composer<Context>();

const groupChat = composer.chatType(["group", "supergroup"]);

groupChat.on("message").filter((ctx) => shouldReplyToMessage(ctx, ctx.message));
