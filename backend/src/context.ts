import type { Logger } from "@/logger";
import type { SessionData } from "@/storage";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { Context as BaseContext } from "grammy";
import type { SessionFlavor } from "grammy";

export interface ExtendedContext {
	logger: Logger;
}

type Context = HydrateFlavor<
	BaseContext & ExtendedContext & SessionFlavor<SessionData>
>;

export type { Context };