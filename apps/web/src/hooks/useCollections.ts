import { useQuery } from "@tanstack/react-query";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import {
	type CollectionShare,
	getCollectionShares,
} from "@/routes/api/share-collections";

export function useCollections() {
	const { rawInitData } = useTelegramContext();

	const { data, error, isLoading, refetch, isFetching } = useQuery<
		CollectionShare[]
	>({
		queryKey: ["collections", { scope: "user" }],
		queryFn: async () => {
			return await getCollectionShares({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		staleTime: 5 * 60 * 1000,
		gcTime: 10 * 60 * 1000,
	});

	return {
		collections: data ?? [],
		isLoading,
		isFetching,
		error,
		refetch,
	};
}
