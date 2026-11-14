import type { InferRouterInputs, InferRouterOutputs, RouterClient } from "@orpc/server";
import { deleteCookies, saveCookies } from "./cookies";
import { changeProfileVisibility, getUserProfile } from "./profiles";
import { randomImages, searchArtists, searchImages } from "./search";
import { deletePhoto, listArtistTweets, listUserTweets } from "./tweets";

export const appRouter = {
  profiles: {
    visibility: changeProfileVisibility,
    get: getUserProfile,
  },
  artists: {
    search: searchArtists,
  },
  cookies: {
    save: saveCookies,
    delete: deleteCookies,
  },
  tweets: {
    list: listUserTweets,
    byArtist: listArtistTweets,
    delete: deletePhoto,
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
