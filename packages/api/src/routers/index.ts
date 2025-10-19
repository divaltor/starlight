import type {
	InferRouterInputs,
	InferRouterOutputs,
	RouterClient,
} from "@orpc/server";
import { respondToWebAppData } from "./bot";
import { deletePostingChannel } from "./channels";
import { deleteCookies, saveCookies } from "./cookies";
import { changeProfileVisibility, getUserProfile } from "./profiles";
import {
	addTweetToSlot,
	createScheduledSlot,
	deleteScheduledSlot,
	getScheduledSlot,
	scheduledSlotRemovePhoto,
	shuffleTweet,
} from "./scheduling";
import { listUserTweets } from "./tweets";

export const appRouter = {
	respond: {
		send: respondToWebAppData,
	},
	profiles: {
		visibility: changeProfileVisibility,
		get: getUserProfile,
	},
	cookies: {
		save: saveCookies,
		delete: deleteCookies,
	},
	channels: {
		disconnect: deletePostingChannel,
	},
	tweets: {
		list: listUserTweets,
	},
	scheduling: {
		photos: {
			remove: scheduledSlotRemovePhoto,
		},
		slots: {
			get: getScheduledSlot,
			create: createScheduledSlot,
			delete: deleteScheduledSlot,
		},
		tweets: {
			add: addTweetToSlot,
			shuffle: shuffleTweet,
		},
	},
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;

export type Inputs = InferRouterInputs<typeof appRouter>;
export type Outputs = InferRouterOutputs<typeof appRouter>;

export type ProfileResult = Outputs["profiles"]["get"];
export type PostingChannelResult = ProfileResult["postingChannel"];
