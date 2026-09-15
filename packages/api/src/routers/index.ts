import type { InferRouterInputs, InferRouterOutputs, RouterClient } from "@orpc/server";
import { deleteCookies, saveCookies } from "./cookies";
import { changeProfileVisibility, getUserProfile } from "./profiles";
import { deletePixivCredential, savePixivCredential, setPixivPrivateBookmarks } from "./pixiv";
import { randomImages, searchImages } from "./search";
import { deleteMedia, listUserPosts } from "./posts";

export const appRouter = {
	profiles: {
		visibility: changeProfileVisibility,
		get: getUserProfile,
	},
	cookies: {
		save: saveCookies,
		delete: deleteCookies,
	},
	pixiv: {
		save: savePixivCredential,
		delete: deletePixivCredential,
		privateBookmarks: setPixivPrivateBookmarks,
	},
	posts: {
		list: listUserPosts,
		search: searchImages,
		random: randomImages,
	},
	media: {
		delete: deleteMedia,
	},
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;

export type Inputs = InferRouterInputs<typeof appRouter>;
export type Outputs = InferRouterOutputs<typeof appRouter>;

export type ProfileResult = Outputs["profiles"]["get"];
export type PostingChannelResult = ProfileResult["postingChannel"];
