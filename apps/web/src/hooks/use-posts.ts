import type { PostData, PostsPageResult } from "@starlight/api/src/types/posts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { orpc } from "@/utils/orpc";

const EMPTY_POSTS: PostData[] = [];

interface UsePostsOptions {
	limit?: number;
	username?: string;
}

export function usePosts(options: UsePostsOptions = {}) {
	const { username, limit = 30 } = options;

	const { data, error, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, status } =
		useInfiniteQuery(
			orpc.posts.list.infiniteOptions({
				input: (pageParam: string | undefined) => ({
					username,
					cursor: pageParam,
					limit,
				}),
				queryKey: ["posts", { username }],
				initialPageParam: undefined,
				getNextPageParam: (lastPage: PostsPageResult) => lastPage.nextCursor ?? undefined,
				retry: false,
				gcTime: 10 * 60 * 1000,
			}),
		);
	const posts = useMemo(
		() => data?.pages.flatMap((page) => page.posts) ?? EMPTY_POSTS,
		[data?.pages],
	);

	return {
		posts,
		isLoading: status === "pending",
		isFetching,
		isFetchingNextPage,
		hasNextPage,
		error,
		fetchNextPage,
	};
}
