import type { TweetData, TweetsPageResult } from "@starlight/api/types/tweets";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Masonry, useInfiniteLoader } from "masonic";
import { lazy, Suspense } from "react";
import { NotFound } from "@/components/not-found";
import { buttonVariants } from "@/components/ui/button";
import { orpc } from "@/utils/orpc";

const TweetImageGrid = lazy(
  async () => await import("@/components/tweet-image-grid").then((m) => ({ default: m.TweetImageGrid })),
);

const MASONRY_ITEM_HEIGHT_ESTIMATE = 360;
const MASONRY_OVERSCAN_BY = 1.25;

const renderMasonryItem = ({ data, width }: { data: TweetData; width: number }) => (
  <div className="mb-1" style={{ width }}>
    <TweetImageGrid tweet={data} />
  </div>
);

function ArtistViewer() {
  const { username } = Route.useParams();

  const { data, status, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    orpc.tweets.byArtist.infiniteOptions({
      input: (pageParam: string | null | undefined) => ({
        username,
        cursor: pageParam ?? undefined,
        limit: 30,
      }),
      initialPageParam: null,
      getNextPageParam: (lastPage: TweetsPageResult) => lastPage.nextCursor ?? undefined,
      retry: false,
      gcTime: 10 * 60 * 1000,
    }),
  );

  const tweets = data?.pages.flatMap((page) => page.tweets) ?? [];

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

  if (status === "error") {
    return (
      <div className="h-dvh bg-background p-4">
        <NotFound
          description="An error occurred while loading this artist. Please try again later."
          title="Failed to load arts (｡•́︿•̀｡)"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background p-4">
      <header className="mx-auto mb-4 flex w-full max-w-7xl items-center justify-between gap-4">
        <h1 className="truncate font-semibold text-2xl text-foreground">@{username}</h1>
        <a
          className={buttonVariants({ variant: "outline", size: "sm" })}
          href={`https://x.com/${username}`}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open on X
        </a>
      </header>

      {status === "pending" && (
        <div className="flex flex-1 items-center justify-center">
          {/** biome-ignore lint/correctness/useImageSize: animated loader uses CSS sizing intentionally */}
          <img alt="Searching for cute anime girls…" className="mx-auto h-auto w-64" src="/suisei-hq.webp" />
        </div>
      )}

      {status === "success" && tweets.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <NotFound description="No public profile has saved arts from this artist yet." title="No arts found" />
        </div>
      )}

      {tweets.length > 0 && (
        <div className="flex-1">
          <div className="mx-auto max-w-7xl">
            <Suspense fallback={null}>
              <Masonry
                columnGutter={16}
                itemHeightEstimate={MASONRY_ITEM_HEIGHT_ESTIMATE}
                itemKey={(tweet) => tweet.id}
                items={tweets}
                onRender={(...args) => {
                  infiniteLoader(...args);
                }}
                overscanBy={MASONRY_OVERSCAN_BY}
                render={renderMasonryItem}
              />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/artist/@{$username}")({
  component: ArtistViewer,
});
