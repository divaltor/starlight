import type { PostData, PostsPageResult } from "@starlight/api/types/posts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "@/utils/orpc";

const EMPTY_POSTS: PostData[] = [];

interface UsePostsOptions {
  limit?: number;
  username?: string;
}

export function usePosts(options: UsePostsOptions = {}) {
  const { username, limit = 30 } = options;

  const { data, error, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, status } = useInfiniteQuery(
    orpc.posts.list.infiniteOptions({
      input: (pageParam: string | null) => ({
        username,
        cursor: pageParam ?? undefined,
        limit,
      }),
      queryKey: ["posts", { username }],
      initialPageParam: null,
      getNextPageParam: (lastPage: PostsPageResult) => lastPage.nextCursor ?? null,
      retry: false,
      gcTime: 10 * 60 * 1000,
    }),
  );
  const posts = data?.pages.flatMap((page) => page.posts) ?? EMPTY_POSTS;

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
