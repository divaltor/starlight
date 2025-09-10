import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Masonry } from "masonic";
import { useCallback, useEffect, useState } from "react";
import { CollectionCard } from "@/components/collection-card";
import { CollectionCreateDialog } from "@/components/collection-create-dialog";
import { Button } from "@/components/ui/button";
import { useCollections } from "@/hooks/useCollections";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import type { CollectionShare } from "@/routes/api/share-collections";

function CollectionsPage() {
	const { collections, isLoading, error } = useCollections();
	const [openCreate, setOpenCreate] = useState(false);
	const navigate = useNavigate();
	const { updateButtons } = useTelegramContext();

	useEffect(() => {
		updateButtons({
			mainButton: {
				state: "visible",
				text: "New Collection",
				action: { type: "callback", payload: () => setOpenCreate(true) },
			},
			secondaryButton: {
				state: "visible",
				text: "Back",
				action: { type: "navigate", payload: "/app" },
			},
		});
		return () => {
			updateButtons({
				mainButton: { state: "hidden" },
				secondaryButton: { state: "hidden" },
			});
		};
	}, [updateButtons]);

	const renderItem = useCallback(
		({ data, width }: { data: CollectionShare; width: number }) => {
			return (
				<div style={{ width }} className="mb-2">
					<CollectionCard
						collection={data}
						tweets={data.tweets}
						// For now no preview images API; could extend later
						onClick={() =>
							navigate({ to: "/collections/$id", params: { id: data.id } })
						}
					/>
				</div>
			);
		},
		[navigate],
	);

	if (error) {
		return (
			<div className="flex min-h-screen items-center justify-center">
				<div className="text-center">
					<h2 className="font-semibold text-gray-900 text-xl">
						Failed to load collections
					</h2>
					<p className="mt-2 text-gray-600">
						{error instanceof Error ? error.message : "An error occurred"}
					</p>
					<Link to="/app" className="text-blue-600 text-sm underline">
						Go back
					</Link>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 p-4">
			<CollectionCreateDialog open={openCreate} onOpenChange={setOpenCreate} />

			{!isLoading && collections.length === 0 && (
				<div className="flex flex-col items-center justify-center py-20 text-center">
					<h3 className="mb-2 font-medium text-gray-900 text-xl">
						No collections yet
					</h3>
					<p className="max-w-md text-gray-600 text-sm">
						Create a collection from tweets to see it appear here.
					</p>
					{process.env.NODE_ENV === "development" && (
						<Button className="mt-4" onClick={() => setOpenCreate(true)}>
							Create Collection
						</Button>
					)}
				</div>
			)}

			{collections.length > 0 && (
				<div className="mx-auto max-w-6xl">
					<Masonry items={collections} columnGutter={12} render={renderItem} />
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute("/collections")({
	component: CollectionsPage,
});
