import { getUserTweets } from "@/routes/api/tweets";
import { useQuery } from "@tanstack/react-query";
import { initData, useSignal } from "@telegram-apps/sdk-react";

export function useTweets() {
	const initDataUser = useSignal(initData.user);

	return useQuery({
		queryKey: ["tweets", initDataUser?.id],
		queryFn: async () => {
			if (!initDataUser?.id) {
				return [];
			}

			const result = await getUserTweets({
				data: { telegramId: initDataUser.id },
			});

			if (!result.success) {
				throw new Error(result.error || "Failed to fetch tweets");
			}

			return result.tweets;
		},
		retry: false,
		enabled: !!initDataUser?.id,
		staleTime: 5 * 60 * 1000, // 5 minutes
		gcTime: 10 * 60 * 1000, // 10 minutes
	});
}
