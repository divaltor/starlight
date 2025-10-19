import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Calendar } from "lucide-react";
import { useEffect } from "react";
import { SlotCard } from "@/components/slot-card";
import { Card, CardContent } from "@/components/ui/card";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { orpc } from "@/utils/orpc";

function PublicationsPage() {
	const queryClient = useQueryClient();
	const { rawInitData, updateButtons } = useTelegramContext();

	const {
		data: { slot, tweets } = { slot: null, tweets: [] },
		isPending,
		isError,
	} = useQuery(
		orpc.scheduling.slots.get.queryOptions({
			queryKey: ["scheduled-slots"],
			enabled: !!rawInitData,
			retry: false,
			input: { status: "WAITING" },
		})
	);

	const createSlotMutation = useMutation(
		orpc.scheduling.slots.create.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const addTweetMutation = useMutation(
		orpc.scheduling.tweets.add.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const publishSlotMutation = useMutation(
		orpc.respond.send.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	useEffect(() => {
		if (isPending || !slot) {
			// No publications - show "Add slot" button
			updateButtons({
				mainButton: {
					state: "visible",
					text: "Add slot",
					hasShineEffect: true,
					isEnabled: !isPending,
					action: {
						type: "callback",
						payload: () => createSlotMutation.mutate({}),
					},
				},
				secondaryButton: {
					state: "hidden",
				},
			});
		} else if (!isPending && slot) {
			// Has publications - show "Publish" and "Add tweet" buttons
			updateButtons({
				mainButton: {
					text: "Publish",
					state: "visible",
					isEnabled: !!slot,
					hasShineEffect: true,
					action: {
						type: "callback",
						payload: () => {
							publishSlotMutation.mutate({ slotId: slot.id });
						},
					},
				},
				secondaryButton: {
					state: "visible",
					text: "Add tweet",
					isEnabled: true,
					action: {
						type: "callback",
						payload: () => {
							if (slot && !isPending) {
								addTweetMutation.mutate({
									slotId: slot.id,
								});
							}
						},
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
	}, [
		slot,
		updateButtons,
		isPending,
		createSlotMutation,
		addTweetMutation,
		publishSlotMutation,
	]);

	const renderNoChannelsState = () => (
		<div className="flex min-h-[50vh] items-center justify-center">
			<Card className="mx-auto max-w-md border-orange-200 bg-orange-50">
				<CardContent className="py-12 text-center">
					<AlertTriangle className="mx-auto mb-4 h-12 w-12 text-orange-500" />
					<p className="mb-2 font-medium text-lg text-orange-800">
						No Posting Channels Available
					</p>
					<p className="mb-4 text-orange-700 text-sm">
						You need to add at least one posting channel before you can create
						and schedule publications. Please configure your channels using
						/connect command in chat.
					</p>
				</CardContent>
			</Card>
		</div>
	);

	const renderEmptyState = (error?: string | null) => (
		<div className="flex min-h-[50vh] items-center justify-center">
			<div className="text-center">
				<Calendar className="mx-auto mb-4 h-12 w-12 text-gray-400" />
				<p className="mb-2 text-gray-500 text-lg">No scheduled publications</p>
				<p className="text-gray-400 text-sm">
					Create your first scheduled slot to get started
				</p>
				{error && <p className="text-red-500 text-sm">{error}</p>}
			</div>
		</div>
	);

	if (slot && !isPending) {
		return (
			<div className="min-h-screen bg-gray-50 p-2 sm:p-4">
				<div className="mx-auto max-w-4xl">
					<SlotCard slot={slot} tweets={tweets} />
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 p-2 sm:p-4">
			<div className="mx-auto max-w-4xl">
				{/* No Channels State */}
				{isError && renderNoChannelsState()}

				{/* Empty State */}
				{!(isPending || isError || slot) &&
					renderEmptyState(createSlotMutation.error?.message)}

				{/* Loading */}
				{isPending && (
					<div className="flex min-h-[50vh] items-center justify-center">
						<div className="prose text-center">
							<div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
							<p className="mt-2 text-gray-500">Loading publications...</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export const Route = createFileRoute("/publications")({
	component: PublicationsPage,
});
