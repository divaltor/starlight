import { os } from "@orpc/server";
import type { Context } from "./context";

export const o = os.$context<Context>();
export const no = os.$context();

export const publicProcedure = o;
