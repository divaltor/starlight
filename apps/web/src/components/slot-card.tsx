import type { TweetData } from "@starlight/api/src/types/tweets";
import type { ScheduledSlot } from "@starlight/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Card, CardContent } from "@/components/ui/card";
import { orpc } from "@/utils/orpc";

type SlotCardProps = {
	tweets: TweetData[];
	slot?: ScheduledSlot;
};

export function SlotCard({ tweets, slot }: SlotCardProps) {
	const queryClient = useQueryClient();
	const showActions = slot?.status === "WAITING";

	const deletePhotoMutation = useMutation(
		orpc.scheduling.photos.remove.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const shuffleTweetMutation = useMutation(
		orpc.scheduling.tweets.shuffle.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const handleDeleteImage = (photoId: string) => {
		if (slot) {
			deletePhotoMutation.mutate({ slotId: slot.id, photoId });
		}
	};

	const handleShuffleTweet = (tweetId: string) => {
		if (slot?.id) {
			shuffleTweetMutation.mutate({ slotId: slot.id, tweetId });
		}
	};

	return (
		<Card className="overflow-hidden shadow-sm">
			<CardContent className="p-0">
				{tweets.map((tweet) => (
					<TweetImageGrid
						key={tweet.id}
						onDeleteImage={(photoId) => handleDeleteImage(photoId)}
						onShuffleTweet={(tweetId) => handleShuffleTweet(tweetId)}
						showActions={showActions}
						slot={slot}
						tweet={tweet}
					/>
				))}
			</CardContent>
		</Card>
	);
}
