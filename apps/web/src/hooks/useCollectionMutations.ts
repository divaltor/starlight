import type { CollectionShare, CollectionShareVisibility } from "@repo/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import {
	addTweetToCollectionShare,
	createCollectionShare,
} from "@/routes/api/share-collections";

interface CreateCollectionInput {
	name?: string;
	visibility?: CollectionShareVisibility;
	initialTweetId?: string; // optional tweet to add immediately
}

interface AddTweetInput {
	collectionId?: string; // if omitted will auto-create / infer
	tweetId: string;
	nameIfCreate?: string; // name if auto-create
	visibilityIfCreate?: CollectionShareVisibility;
}

export function useCollectionMutations() {
	const queryClient = useQueryClient();
	const { rawInitData } = useTelegramContext();

	const createMutation = useMutation({
		mutationFn: async (data: CreateCollectionInput) => {
			const result = await createCollectionShare({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					name: data.name,
					visibility: data.visibility,
					tweetIds: data.initialTweetId ? [data.initialTweetId] : undefined,
				},
			});
			return result;
		},
		onSuccess: (result) => {
			// Prepend new collection to cache
			queryClient.setQueryData<CollectionShare[]>(
				["collections", { scope: "user" }],
				(old) => {
					if (!old) return [result];
					return [result, ...old];
				},
			);
			toast.success("Collection created", { position: "bottom-center" });
		},
		onError: (err: any) => {
			toast.error(err?.message || "Failed to create collection", {
				position: "bottom-center",
			});
		},
	});

	const addTweetMutation = useMutation({
		mutationFn: async (data: AddTweetInput) => {
			const result = await addTweetToCollectionShare({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					collectionId: data.collectionId,
					tweetId: data.tweetId,
					name: data.nameIfCreate,
					visibility: data.visibilityIfCreate,
				},
			});
			return { ...result, tweetId: data.tweetId };
		},
		onSuccess: () => {
			toast.success("Saved to collection", { position: "bottom-center" });
			// Invalidate counts
			queryClient.invalidateQueries({
				queryKey: ["collections", { scope: "user" }],
			});
		},
		onError: (err: any) => {
			toast.error(err?.message || "Failed to save", {
				position: "bottom-center",
			});
		},
	});

	return {
		createCollection: createMutation.mutate,
		createCollectionAsync: createMutation.mutateAsync,
		creating: createMutation.isPending,
		addTweet: addTweetMutation.mutate,
		addTweetAsync: addTweetMutation.mutateAsync,
		adding: addTweetMutation.isPending,
	};
}
