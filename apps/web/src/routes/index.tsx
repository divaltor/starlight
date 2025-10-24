import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Masonry } from "masonic";
import { useCallback, useState } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { orpc } from "@/utils/orpc";

const examples = [
	"furina genshin impact",
	"white elf on pastel background",
	"hollow knight",
	"photographer with camera",
	"sunrise winter landscape",
	"sketch lineart",
];

export default function DiscoverPage() {
	const [query, setQuery] = useState("");
	const [inputPosition, setInputPosition] = useState<"initial" | "bottom">(
		"initial"
	);
	const [showExamples, setShowExamples] = useState(true);

	const searchMutation = useMutation(
		orpc.tweets.search.mutationOptions({ retry: false })
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
					// Hero Section with centered search
					<section className="hero hero-center">
						<div className="hero-content text-center">
							<div className="max-w-2xl">
								{searchMutation.isPending ? (
									<div className="flex justify-center py-6">
										<img
											alt="Searching for cute anime girls..."
											className="mx-auto h-auto w-64"
											src="/suisei.gif"
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
