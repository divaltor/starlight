import type { InferRouterInputs, InferRouterOutputs, RouterClient } from "@orpc/server";
import { deleteCookies, saveCookies } from "./cookies";
import { changeProfileVisibility, getUserProfile } from "./profiles";
import { randomImages, searchImages } from "./search";
import { listUserTweets } from "./tweets";

export const appRouter = {
	profiles: {
		visibility: changeProfileVisibility,
		get: getUserProfile,
	},
	cookies: {
		save: saveCookies,
		delete: deleteCookies,
	},
	tweets: {
		list: listUserTweets,
		search: searchImages,
		random: randomImages,
	},
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;

export type Inputs = InferRouterInputs<typeof appRouter>;
export type Outputs = InferRouterOutputs<typeof appRouter>;

export type ProfileResult = Outputs["profiles"]["get"];
export type PostingChannelResult = ProfileResult["postingChannel"];
