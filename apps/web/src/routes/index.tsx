import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Masonry } from "masonic";
import { useCallback, useState } from "react";
import { TweetImageGrid } from "@/components/tweet-image-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { orpc } from "@/utils/orpc";

const examples = [
	"sunset over mountains",
	"abstract art in blue tones",
	"vintage car photography",
	"nature landscape with river",
];

export default function DiscoverPage() {
	const [query, setQuery] = useState("");

	const searchMutation = useMutation(
		orpc.tweets.search.mutationOptions({ retry: false })
	);

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		if (query.trim()) {
			searchMutation.mutate({ query });
		}
	};

	const handleExampleClick = (example: string) => {
		setQuery(example);
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
							<div className="max-w-lg">
								<p className="py-6 text-2xl text-base-content/80">
									Find inspiring images with natural language
								</p>
								<form className="form-control" onSubmit={handleSearch}>
									<div className="join mx-auto max-w-lg">
										<Input
											className="input input-bordered join-item"
											onChange={(e) => setQuery(e.target.value)}
											placeholder="Search for images..."
											type="text"
											value={query}
										/>
										<Button
											className="btn btn-primary join-item"
											disabled={searchMutation.isPending}
											type="submit"
										>
											<Search className="h-4 w-4" />
											<span>Search</span>
										</Button>
									</div>
								</form>
								{/* Examples */}
								<div className="py-6 text-center">
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
				<div className="sticky bottom-0 z-10 border-base-200 border-t bg-base-100 p-4">
					<div className="mx-auto max-w-lg">
						<form className="form-control" onSubmit={handleSearch}>
							<div className="join mx-auto w-full max-w-lg">
								<Input
									className="input input-bordered join-item flex-1"
									onChange={(e) => setQuery(e.target.value)}
									placeholder="Search for images..."
									type="text"
									value={query}
								/>
								<Button
									className="btn btn-primary join-item"
									disabled={searchMutation.isPending}
									type="submit"
								>
									<Search className="h-4 w-4" />
									<span>Search</span>
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
