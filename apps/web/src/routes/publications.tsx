import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Calendar } from "lucide-react";
import { useEffect } from "react";
import { SlotCard } from "@/components/slot-card";
import { Card, CardContent } from "@/components/ui/card";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import { orpc } from "@/utils/orpc";

function PublicationsPage() {
	const queryClient = useQueryClient();
	const { rawInitData, updateButtons } = useTelegramContext();

	const {
		data: publicationSlot,
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

	const deleteSlotMutation = useMutation(
		orpc.scheduling.slots.delete.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	useEffect(() => {
		if (isPending || !publicationSlot) {
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
		} else if (!isPending && publicationSlot) {
			// Has publications - show "Publish" and "Add tweet" buttons
			updateButtons({
				mainButton: {
					text: "Publish",
					state: "visible",
					isEnabled: !!publicationSlot,
					hasShineEffect: true,
					action: {
						type: "callback",
						payload: () => {
							orpc.respond.send.call({ slotId: publicationSlot.id });
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
							if (publicationSlot && !isPending) {
								orpc.scheduling.tweets.add.call({
									slotId: publicationSlot.id,
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
	}, [publicationSlot, updateButtons, isPending, createSlotMutation]);

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

	return (
		<div className="min-h-screen bg-gray-50 p-2 sm:p-4">
			<div className="mx-auto max-w-4xl">
				{/* No Channels State */}
				{isError && renderNoChannelsState()}

				{/* Create Slot Error State */}
				{(createSlotMutation.isError ||
					(createSlotMutation.isSuccess && createSlotMutation.data?.error)) && (
					<div className="mb-6">
						<Card className="border-red-200 bg-red-50">
							<CardContent className="py-4">
								<div className="flex items-center gap-2">
									<div className="h-2 w-2 rounded-full bg-red-500" />
									<p className="font-medium text-red-800 text-sm">
										Failed to create slot
									</p>
								</div>
								<p className="mt-2 text-red-700 text-sm">
									An unexpected error occurred
								</p>
							</CardContent>
						</Card>
					</div>
				)}

				{/* Empty State */}
				{!(isPending || isError || publicationSlot) &&
					renderEmptyState(createSlotMutation.data?.error)}

				{/* Publications List */}
				{!isPending && publicationSlot && (
					<SlotCard
						onDelete={() =>
							deleteSlotMutation.mutate({ slotId: publicationSlot.id })
						}
						slot={publicationSlot}
					/>
				)}
			</div>
		</div>
	);
}

export const Route = createFileRoute("/publications")({
	component: PublicationsPage,
});
