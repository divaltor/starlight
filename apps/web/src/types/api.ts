import type { orpc } from "@/utils/orpc";

export type ScheduledSlotWithTweets = NonNullable<
	Awaited<ReturnType<typeof orpc.scheduling.slots.get.call>>
>;

export type TweetWithPhotos = NonNullable<
	Awaited<ReturnType<typeof orpc.scheduling.slots.get.call>>
>["scheduledSlotTweets"][number];
