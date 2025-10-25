import type { TweetData } from "@starlight/api/src/types/tweets";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Masonry } from "masonic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LayoutManager } from "@/utils/layout";
import { orpc } from "@/utils/orpc";

const examples = [
	"girls on the beach",
	"white elf on pastel background",
	"miku & teto",
	"photographer with camera",
	"sunrise winter landscape",
	"hololive girls",
	"sketch lineart",
];

export default function DiscoverPage() {
	const [query, setQuery] = useState("");
	const [inputPosition, setInputPosition] = useState<"initial" | "bottom">(
		"initial"
	);
	const [showExamples, setShowExamples] = useState(true);
	const [isLargeScreen, setIsLargeScreen] = useState(false);
	const [visibleIndices, setVisibleIndices] = useState<number[]>([]);

	useEffect(() => {
		const updateScreen = () => {
			setIsLargeScreen(window.innerWidth > 1024);
		};
		updateScreen();
		window.addEventListener("resize", updateScreen);
		return () => window.removeEventListener("resize", updateScreen);
	}, []);

	const searchMutation = useMutation(
		orpc.tweets.search.mutationOptions({ retry: false })
	);

	const randomQuery = useQuery({
		...orpc.tweets.random.queryOptions({ retry: false }),
		enabled: true,
	});

	const randomImages: TweetData[] = randomQuery.data || [];

	const singleImageTweets = useMemo(
		() => randomImages.filter((tweet) => tweet.photos.length === 1),
		[randomImages]
	);

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		if (query.trim()) {
			setInputPosition("bottom");
			setShowExamples(false);
			searchMutation.mutate({ query });
		}
	};

	const handleExampleClick = (example: string) => {
		setQuery(example);
		setInputPosition("bottom");
		setShowExamples(false);
		searchMutation.mutate({ query: example });
	};

	const renderMasonryItem = useCallback(
		({ data, width }: { data: any; width: number }) => (
			<div className="mb-1" style={{ width }}>
				<TweetImageGrid tweet={data} />
			</div>
		),
		[]
	);

	const results = searchMutation.data || [];

	// Generate non-overlapping positions for random images
	const placedData = useMemo(() => {
		if (singleImageTweets.length === 0 || typeof window === "undefined") {
			return [];
		}

		const layout = new LayoutManager(100, 100);
		return layout.placeTweets(singleImageTweets);
	}, [singleImageTweets]);

	useEffect(() => {
		if (
			placedData.length > 0 &&
			randomQuery.isSuccess &&
			!searchMutation.isPending &&
			results.length === 0
		) {
			const timeouts: NodeJS.Timeout[] = [];
			for (let i = 0; i < placedData.length; i++) {
				const item = placedData[i];
				const timer = setTimeout(() => {
					setVisibleIndices((prev) => [...prev, item.index]);
				}, i * 500);
				timeouts.push(timer);
			}
			return () => {
				for (const timeout of timeouts) {
					clearTimeout(timeout);
				}
			};
		}
	}, [
		placedData,
		randomQuery.isSuccess,
		searchMutation.isPending,
		results.length,
	]);

	return (
		<div className="flex min-h-screen flex-col bg-base-100">
			{/* Main Content */}
			<div className="flex flex-1 flex-col items-center justify-center p-4">
				{results.length > 0 ? (
					// Results
					<div className="w-full max-w-7xl">
						<Masonry
							columnGutter={16}
							items={results}
							render={renderMasonryItem}
						/>
					</div>
				) : (
					// Hero Section with centered search and floating images on large screen
					<section className="hero hero-center relative w-full max-w-7xl">
						<div className="hero-content relative z-10 text-center">
							<div className="max-w-2xl">
								{searchMutation.isPending ? (
									<div className="flex justify-center py-6">
										<img
											alt="Searching for cute anime girls..."
											className="mx-auto h-auto w-64"
											src="/suisei-hq.gif"
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
												: "fixed inset-x-0 bottom-0 p-4"
										)}
									>
										<div
											className={cn(
												inputPosition === "bottom" ? "mx-auto max-w-lg" : "p-0"
											)}
										>
											<div className="join flex w-full">
												<Input
													className="input input-bordered join-item flex-1"
													onChange={(e) => setQuery(e.target.value)}
													placeholder="Search for images..."
													type="text"
													value={query}
												/>
												<Button
													className={cn(
														"btn btn-primary join-item",
														searchMutation.isPending && "btn-disabled"
													)}
													disabled={searchMutation.isPending}
													type="submit"
												>
													{searchMutation.isPending ? (
														<span className="loading loading-spinner h-4 w-4" />
													) : (
														<Search className="h-4 w-4" />
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
										showExamples ? "opacity-100" : "opacity-0"
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
			{isLargeScreen &&
				randomQuery.isSuccess &&
				placedData.length > 0 &&
				!searchMutation.isPending &&
				results.length === 0 && (
					<div className="pointer-events-none absolute inset-0 overflow-hidden">
						{placedData.map(({ position, index }) => {
							const tweet = singleImageTweets[index];
							const isVisible = visibleIndices.includes(index);
							return (
								<div
									className={cn(
										"pointer-events-auto absolute transition-opacity duration-700 ease-in-out",
										isVisible ? "opacity-85" : "opacity-0"
									)}
									key={tweet.id}
									style={{
										top: `${position.top}%`,
										left: `${position.left}%`,
										width: "250px",
										height: "auto",
										transform: "translate(-50%, -50%)",
										zIndex: 1,
									}}
								>
									<TweetImageGrid showArtistOnHover tweet={tweet} />
								</div>
							);
						})}
					</div>
				)}

			{/* Sticky Search Bar - only when results */}
			{results.length > 0 && (
				<div className="sticky bottom-0 z-10 p-4">
					<div className="mx-auto max-w-lg">
						<form className="form-control" onSubmit={handleSearch}>
							<div className="join w-full">
								<Input
									className="input input-bordered join-item flex-1"
									onChange={(e) => setQuery(e.target.value)}
									placeholder="Search for images..."
									type="text"
									value={query}
								/>
								<Button
									className={cn(
										"btn btn-primary join-item",
										searchMutation.isPending && "btn-disabled"
									)}
									disabled={searchMutation.isPending}
									type="submit"
								>
									{searchMutation.isPending ? (
										<span className="loading loading-spinner h-4 w-4" />
									) : (
										<Search className="h-4 w-4" />
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
	component: DiscoverPage,
});
