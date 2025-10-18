import type { RouterClient } from "@orpc/server";
import { respondToWebAppData } from "./bot";
import { deletePostingChannel, getPostingChannel } from "./channels";
import { deleteCookies, saveCookies, verifyCookies } from "./cookies";
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
		verify: verifyCookies,
		delete: deleteCookies,
	},
	channels: {
		get: getPostingChannel,
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
