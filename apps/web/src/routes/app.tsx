import type { ProfileResult } from "@starlight/api/routers/index";
import type { TweetData, TweetsPageResult } from "@starlight/api/types/tweets";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import TriangleAlertIcon from "@hugeicons/core-free-icons/TriangleAlertIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Masonry, useInfiniteLoader } from "masonic";
import { parseAsString, useQueryState } from "nuqs";
import { useEffect, useState, lazy, Suspense } from "react";
import { NotFound } from "@/components/not-found";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSearch } from "@/hooks/use-search";
import { useTweets } from "@/hooks/use-tweets";
import { cn } from "@/lib/utils";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { client, orpc } from "@/utils/orpc";

const TweetImageGrid = lazy(() => import("@/components/tweet-image-grid").then((m) => ({ default: m.TweetImageGrid })));

const MASONRY_ITEM_HEIGHT_ESTIMATE = 360;
const MASONRY_OVERSCAN_BY = 1.25;

function TwitterArtViewer() {
  const { updateButtons, rawInitData } = useTelegramContext();
  const queryClient = useQueryClient();

  // Search state with URL params and history support
  const [urlQuery, setUrlQuery] = useQueryState("q", parseAsString.withDefault(""));
  const [inputValue, setInputValue] = useState(urlQuery);

  const { data: profile } = useQuery<ProfileResult>(
    orpc.profiles.get.queryOptions({
      queryKey: ["profile"],
      enabled: !!rawInitData,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
    }),
  );

  useEffect(() => {
    if (profile && !profile.hasValidCookies) {
      updateButtons({
        mainButton: {
          state: "visible" as const,
          text: "Setup cookies" as const,
          color: "#ffd6a7" as const,
          textColor: "#9f2d00" as const,
          action: {
            type: "navigate" as const,
            payload: "/settings" as const,
          },
        },
      });
    }

    return () => {
      updateButtons({
        mainButton: { state: "hidden" },
        secondaryButton: { state: "hidden" },
      });
    };
  }, [updateButtons, profile]);

  // Search hook - search only own tweets in TMA
  const {
    results: searchResults,
    isLoading: isSearchLoading,
    isFetchingNextPage: isSearchFetchingNextPage,
    hasNextPage: hasSearchNextPage,
    fetchNextPage: fetchSearchNextPage,
  } = useSearch({ query: urlQuery, ownOnly: true });

  const isSearchActive = urlQuery.trim().length > 0;

  const { tweets, isLoading, isFetchingNextPage, hasNextPage, error, fetchNextPage } = useTweets();

  const { mutate: deletePhoto } = useMutation({
    mutationFn: (photoId: string) => client.tweets.delete({ photoId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tweets"] });
    },
  });

  const handleDeleteImage = (photoId: string) => {
    deletePhoto(photoId);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = inputValue.trim();
    setUrlQuery(trimmedQuery || null, { history: "push" });
  };

  // Infinite loader for regular tweets
  const infiniteLoader = useInfiniteLoader(
    async (_startIndex, _stopIndex, _items) => {
      if (hasNextPage && !isFetchingNextPage) {
        await fetchNextPage();
      }
    },
    {
      isItemLoaded: (index, items) => !!items[index],
      minimumBatchSize: 30,
      threshold: 5,
    },
  );

  // Infinite loader for search results
  const searchInfiniteLoader = useInfiniteLoader(
    async (_startIndex, _stopIndex, _items) => {
      if (hasSearchNextPage && !isSearchFetchingNextPage) {
        await fetchSearchNextPage();
      }
    },
    {
      isItemLoaded: (index, items) => !!items[index],
      minimumBatchSize: 30,
      threshold: 5,
    },
  );

  const renderMasonryItem = ({ data, width }: { data: TweetData; width: number }) => (
    <div className="mb-1" style={{ width }}>
      <TweetImageGrid tweet={data} showActions onDeleteImage={handleDeleteImage} />
    </div>
  );

  // Show error state
  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <NotFound
          description="An error occurred while loading tweets. Please try again later."
          icon={<HugeiconsIcon className="size-10 text-base-content/20" icon={TriangleAlertIcon} />}
          title="Failed to load tweets (｡•́︿•̀｡)"
        />
      </div>
    );
  }

  // Determine which data to display
  const displayItems = isSearchActive ? searchResults : tweets;
  const displayLoading = isSearchActive ? isSearchLoading : isLoading;
  const currentInfiniteLoader = isSearchActive ? searchInfiniteLoader : infiniteLoader;

  return (
    <div className="flex min-h-dvh flex-col p-4">
      {/* Loading State */}
      {displayLoading && (
        <div className="flex flex-1 items-center justify-center">
          {/** biome-ignore lint/correctness/useImageSize: animated loader uses CSS sizing intentionally */}
          <img alt="Searching for cute anime girls…" className="mx-auto h-auto w-64" src="/suisei-hq.webp" />
        </div>
      )}

      {!displayLoading && displayItems.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <NotFound
            description={
              isSearchActive
                ? "No results found for your search. Try different keywords."
                : "Did you setup cookies? Try again later."
            }
            title={isSearchActive ? "No search results" : "No photos found"}
          />
        </div>
      )}

      {/* Masonry Grid */}
      {displayItems.length > 0 && (
        <div className="flex-1">
          <div className="mx-auto max-w-7xl">
            <Suspense fallback={null}>
              <Masonry
                columnGutter={16}
                itemHeightEstimate={MASONRY_ITEM_HEIGHT_ESTIMATE}
                itemKey={(tweet) => tweet.id}
                items={displayItems}
                onRender={currentInfiniteLoader}
                overscanBy={MASONRY_OVERSCAN_BY}
                render={renderMasonryItem}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* Sticky Search Bar at Bottom */}
      <div className="sticky bottom-0 z-10 py-4">
        <div className="mx-auto max-w-lg">
          <form className="form-control" onSubmit={handleSearch}>
            <div className="join w-full">
              <Input
                className="input input-bordered join-item flex-1"
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Search for images…"
                type="text"
                value={inputValue}
              />
              <Button
                className={cn("btn btn-primary join-item", displayLoading && "btn-disabled")}
                disabled={displayLoading}
                type="submit"
              >
                {displayLoading ? (
                  <span className="loading loading-spinner size-4" />
                ) : (
                  <HugeiconsIcon className="size-4" icon={Search01Icon} />
                )}
                <span className="hidden sm:inline">Search</span>
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/app")({
  loader: async ({ context: { queryClient } }) => {
    // Skip prefetch on server to avoid context errors for user-specific data in TMA
    if (import.meta.env.SSR) {
      return;
    }

    const profileOptions = orpc.profiles.get.queryOptions({
      queryKey: ["profile"],
      enabled: true,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
    });

    await Promise.all([
      queryClient.fetchQuery(profileOptions),
      queryClient.fetchInfiniteQuery(
        orpc.tweets.list.infiniteOptions({
          input: (pageParam: string | null | undefined) => ({
            cursor: pageParam ?? undefined,
            limit: 30,
          }),
          queryKey: ["tweets", { username: null }],
          initialPageParam: null,
          getNextPageParam: (lastPage: TweetsPageResult) => lastPage.nextCursor ?? undefined,
          retry: false,
          gcTime: 10 * 60 * 1000,
        }),
      ),
    ]);
  },
  component: TwitterArtViewer,
});
