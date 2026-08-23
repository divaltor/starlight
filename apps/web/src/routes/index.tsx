import type { PostData } from "@starlight/api/src/types/posts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Masonry, useInfiniteLoader } from "masonic";
import { parseAsString, useQueryState } from "nuqs";
import { useEffect, useState, lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSearch } from "@/hooks/use-search";
import { cn } from "@/lib/utils";
import { LayoutManager } from "@/utils/layout";
import { orpc } from "@/utils/orpc";

const PostMediaGrid = lazy(() =>
	import("@/components/post-media-grid").then((m) => ({ default: m.PostMediaGrid })),
);

const MASONRY_ITEM_HEIGHT_ESTIMATE = 360;
const MASONRY_OVERSCAN_BY = 1.25;

const renderMasonryItem = ({ data, width }: { data: PostData; width: number }) => (
	<div className="mb-1" style={{ width }}>
		<PostMediaGrid post={data} />
	</div>
);

// Generate non-overlapping positions for random posts; skipped during SSR.
function placeRandomPosts(posts: PostData[]) {
	if (posts.length === 0 || typeof window === "undefined") {
		return [];
	}

	return new LayoutManager(100, 100).placePosts(posts);
}

const examples = [
	"mumei",
	"hololive girls",
	"green knight",
	"white elf",
	"miku & teto",
	"mint maid",
	"gremlin",
	"sketch lineart",
];

export default function DiscoverPage() {
	const [urlQuery, setUrlQuery] = useQueryState("q", parseAsString.withDefault(""));
	const [inputValue, setInputValue] = useState(urlQuery);
	const [isLargeScreen, setIsLargeScreen] = useState(false);

	const inputPosition: "initial" | "bottom" = urlQuery ? "bottom" : "initial";
	const showExamples = !urlQuery;

	useEffect(() => {
		const observer = new ResizeObserver(() => {
			setIsLargeScreen(window.innerWidth > 1024);
		});
		observer.observe(document.documentElement);
		return () => observer.disconnect();
	}, []);

	const { results, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useSearch({
		query: urlQuery,
	});

	const randomQuery = useQuery({
		...orpc.posts.random.queryOptions({ retry: false }),
		queryKey: ["posts-random"],
		enabled: true,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmedQuery = inputValue.trim();
		if (trimmedQuery) {
			setUrlQuery(trimmedQuery, { history: "push" });
		}
	};

	const handleExampleClick = (example: string) => {
		setInputValue(example);
		setUrlQuery(example, { history: "push" });
	};

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

	const randomPosts = randomQuery.data || [];
	const placedData = placeRandomPosts(randomPosts);

	const isHomeIdle = !isLoading && results.length === 0;
	const showHeroCollage =
		isLargeScreen && randomQuery.isSuccess && placedData.length > 0 && isHomeIdle;

	return (
		<div className="flex min-h-dvh flex-col bg-base-100">
			{/* Main Content */}
			<div className="flex flex-1 flex-col items-center justify-center p-4">
				{results.length > 0 ? (
					// Results
					<div className="w-full max-w-7xl">
						<Suspense fallback={null}>
							<Masonry
								columnGutter={16}
								itemHeightEstimate={MASONRY_ITEM_HEIGHT_ESTIMATE}
								itemKey={(post) => post.id}
								items={results}
								onRender={infiniteLoader}
								overscanBy={MASONRY_OVERSCAN_BY}
								render={renderMasonryItem}
							/>
						</Suspense>
					</div>
				) : (
					// Hero Section with centered search and floating media on large screen
					<section className="hero hero-center relative w-full max-w-7xl">
						<div className="hero-content relative z-10 text-center">
							<div className="max-w-2xl">
								{isLoading && urlQuery ? (
									<div className="flex justify-center py-6">
										{/** biome-ignore lint/correctness/useImageSize: animated loader uses CSS sizing intentionally */}
										<img
										alt="Searching for cute anime girls…"
											className="mx-auto h-auto w-64"
											src="/suisei-hq.webp"
										/>
									</div>
								) : (
									<p className="py-6 text-2xl text-base-content/80">
										Find cute anime girls using natural language
									</p>
								)}
								<form className="form-control" onSubmit={handleSearch}>
									<div
										className={cn(
											"z-20 transition-all duration-500 ease-in-out",
											inputPosition === "initial"
												? "relative mx-auto w-full max-w-lg"
												: "fixed inset-x-0 bottom-0 p-4",
										)}
									>
										<div className={cn(inputPosition === "bottom" ? "mx-auto max-w-lg" : "p-0")}>
											<div className="join flex w-full">
												<Input
													className="input input-bordered join-item flex-1"
													onChange={(e) => setInputValue(e.target.value)}
											placeholder="Search for images…"
													type="text"
													value={inputValue}
												/>
												<Button
													className={cn("btn btn-primary join-item", isLoading && "btn-disabled")}
													disabled={isLoading}
													type="submit"
												>
													{isLoading ? (
												<span className="loading loading-spinner size-4" />
													) : (
												<Search className="size-4" />
													)}
													<span className="hidden sm:inline">Search</span>
												</Button>
											</div>
										</div>
									</div>
								</form>
								{/* Examples */}
								<div
									className={cn(
										"py-6 text-center transition-opacity duration-300 ease-in-out",
										showExamples ? "opacity-100" : "opacity-0",
									)}
								>
									<div className="flex flex-wrap justify-center gap-2">
										{examples.map((example) => (
											<Button
												key={example}
												onClick={() => handleExampleClick(example)}
												size="sm"
												variant="outline"
											>
												{example}
											</Button>
										))}
									</div>
								</div>
							</div>
						</div>
					</section>
				)}
			</div>
			{showHeroCollage && (
				<Suspense fallback={null}>
					<div className="pointer-events-none absolute inset-0 overflow-hidden">
						{placedData.map(({ position, index }, i) => {
							const post = randomPosts[index];
							return (
								<div
									className="pointer-events-auto absolute motion-safe:animate-fade-in opacity-85"
									key={post.id}
									style={{
										animationDelay: `${i * 500}ms`,
										top: `${position.top}%`,
										left: `${position.left}%`,
										width: "250px",
										height: "auto",
										transform: "translate(-50%, -50%)",
										zIndex: 1,
									}}
								>
									<PostMediaGrid showArtistOnHover post={post} />
								</div>
							);
						})}
					</div>
				</Suspense>
			)}

			{/* Sticky Search Bar - only when results */}
			{results.length > 0 && (
				<div className="sticky bottom-0 z-10 p-4">
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
									className={cn("btn btn-primary join-item", isLoading && "btn-disabled")}
									disabled={isLoading}
									type="submit"
								>
									{isLoading ? (
										<span className="loading loading-spinner size-4" />
									) : (
										<Search className="size-4" />
									)}
									<span className="hidden sm:inline">Search</span>
								</Button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute("/")({
	loader: ({ context: { queryClient } }) => {
		queryClient.prefetchQuery({
			...orpc.posts.random.queryOptions({ retry: false }),
			queryKey: ["posts-random"],
		});
	},
	component: DiscoverPage,
});
