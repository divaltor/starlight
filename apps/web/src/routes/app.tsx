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
import { ButtonGroup } from "@/components/ui/button-group";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useSearch } from "@/hooks/use-search";
import { useTweets } from "@/hooks/use-tweets";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { client, orpc } from "@/utils/orpc";

const TweetImageGrid = lazy(
  async () => await import("@/components/tweet-image-grid").then((m) => ({ default: m.TweetImageGrid })),
);

const MASONRY_ITEM_HEIGHT_ESTIMATE = 360;
const MASONRY_OVERSCAN_BY = 1.25;

function TwitterArtViewer() {
  const { updateButtons, rawInitData } = useTelegramContext();
  const queryClient = useQueryClient();

  // Search state with URL params and history support
  const [urlQuery, setUrlQuery] = useQueryState("q", parseAsString.withDefault(""));
  const [inputValue, setInputValue] = useState(urlQuery);

  const { data: profile, error: profileError } = useQuery<ProfileResult>(
    orpc.profiles.get.queryOptions({
      queryKey: ["profile"],
      enabled: (rawInitData?.length ?? 0) > 0,
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
    error: searchError,
  } = useSearch({ query: urlQuery, ownOnly: true });

  const isSearchActive = urlQuery.trim().length > 0;

  const { tweets, isLoading, isFetchingNextPage, hasNextPage, error, fetchNextPage } = useTweets();

  const { mutate: deletePhoto, error: deleteError } = useMutation({
    mutationFn: async (photoId: string) => await client.tweets.delete({ photoId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tweets"] });
    },
  });

  const handleDeleteImage = (photoId: string) => {
    deletePhoto(photoId);
  };

  const handleSearch = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmedQuery = inputValue.trim();
    void setUrlQuery(trimmedQuery || null, { history: "push" });
  };

  // Infinite loader for regular tweets
  const infiniteLoader = useInfiniteLoader(
    async (_startIndex, _stopIndex, _items) => {
      if (hasNextPage && !isFetchingNextPage) {
        await fetchNextPage();
      }
    },
    {
      isItemLoaded: (index, items) => items[index] !== undefined,
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
      isItemLoaded: (index, items) => items[index] !== undefined,
      minimumBatchSize: 30,
      threshold: 5,
    },
  );

  const renderMasonryItem = ({ data, width }: { data: TweetData; width: number }) => (
    <div className="mb-1" style={{ width }}>
      <TweetImageGrid tweet={data} showActions onDeleteImage={handleDeleteImage} />
    </div>
  );

  const activeQuery = isSearchActive
    ? { items: searchResults, isLoading: isSearchLoading, error: searchError, loadMore: searchInfiniteLoader }
    : { items: tweets, isLoading, error, loadMore: infiniteLoader };

  const viewState = (() => {
    if (activeQuery.error) return "error";

    if (activeQuery.isLoading) return "loading";

    return activeQuery.items.length === 0 ? "empty" : "ready";
  })();

  const emptyFeedDescription =
    profile?.hasValidCookies === false
      ? "Set up your authentication cookies in Settings to start collecting photos."
      : "Your feed is empty. New photos will appear here after your likes are synced.";

  return (
    <div className="flex min-h-dvh flex-col p-4">
      {profileError && (
        <Alert variant="destructive">
          <AlertTitle>{profileError.message}</AlertTitle>
        </Alert>
      )}
      {deleteError && (
        <Alert variant="destructive">
          <AlertTitle>{deleteError.message}</AlertTitle>
        </Alert>
      )}
      {viewState === "error" && (
        <div className="flex flex-1 items-center justify-center" role="alert">
          <NotFound
            description={activeQuery.error?.message}
            icon={<HugeiconsIcon className="size-10 text-muted-foreground/40" icon={TriangleAlertIcon} />}
            title={isSearchActive ? "Search failed" : "Failed to load tweets (｡•́︿•̀｡)"}
          />
        </div>
      )}
      {/* Loading State */}
      {viewState === "loading" && (
        <div className="flex flex-1 items-center justify-center">
          {/** biome-ignore lint/correctness/useImageSize: animated loader uses CSS sizing intentionally */}
          <img alt="Searching for cute anime girls…" className="mx-auto h-auto w-64" src="/suisei-hq.webp" />
        </div>
      )}

      {viewState === "empty" && (
        <div className="flex flex-1 items-center justify-center">
          <NotFound
            description={
              isSearchActive ? "No results found for your search. Try different keywords." : emptyFeedDescription
            }
            title={isSearchActive ? "No search results" : "No photos found"}
          />
        </div>
      )}

      {/* Masonry Grid */}
      {viewState === "ready" && (
        <div className="flex-1">
          <div className="mx-auto max-w-7xl">
            <Suspense fallback={null}>
              <Masonry
                columnGutter={16}
                itemHeightEstimate={MASONRY_ITEM_HEIGHT_ESTIMATE}
                itemKey={(tweet) => tweet.id}
                items={activeQuery.items}
                onRender={(...args) => {
                  activeQuery.loadMore(...args);
                }}
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
          <form onSubmit={handleSearch}>
            <ButtonGroup className="w-full">
              <Input
                className="bg-background"
                aria-label="Search for images"
                onChange={(e) => {
                  setInputValue(e.target.value);
                }}
                placeholder="Search for images…"
                type="text"
                value={inputValue}
              />
              <Button aria-label="Search" disabled={viewState === "loading"} type="submit">
                {viewState === "loading" ? <Spinner /> : <HugeiconsIcon className="size-4" icon={Search01Icon} />}
                <span className="hidden sm:inline">Search</span>
              </Button>
            </ButtonGroup>
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
      queryClient.query(profileOptions),
      queryClient.infiniteQuery(
        orpc.tweets.list.infiniteOptions({
          input: (pageParam: string | null | undefined) => ({
            cursor: pageParam ?? undefined,
            limit: 30,
          }),
          queryKey: ["tweets", {}],
          initialPageParam: null,
          getNextPageParam: (lastPage: TweetsPageResult) => lastPage.nextCursor ?? undefined,
          retry: false,
          gcTime: 10 * 60 * 1000,
        }),
      ),
    ]).catch(() => {
      // Query consumers render failures without replacing the route.
    });
  },
  component: TwitterArtViewer,
});
