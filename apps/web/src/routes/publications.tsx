import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { isTMA } from "@telegram-apps/sdk-react";
import { AlertTriangle, Calendar, Plus } from "lucide-react";
import { useCallback, useEffect } from "react";
import { SlotCard } from "@/components/slot-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import { respondToWebAppData } from "@/routes/api/bot";
import {
	addTweetToSlot,
	createScheduledSlot,
	deleteScheduledSlot,
	getScheduledSlots,
} from "@/routes/api/scheduled-slots";

function PublicationsPage() {
	const queryClient = useQueryClient();

	const { rawInitData, updateButtons } = useTelegramContext();

	const isDevWithMockedTGA = isTMA() && process.env.ENVIRONMENT === "dev";

	const {
		data: publications = [],
		isPending,
		isError,
	} = useQuery({
		queryKey: ["scheduled-slots"],
		queryFn: async () => {
			return await getScheduledSlots({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					status: "WAITING",
				},
			});
		},
		enabled: !!rawInitData,
	});

	const createSlotMutation = useMutation({
		mutationFn: async () => {
			return await createScheduledSlot({
				headers: { Authorization: rawInitData ?? "" },
				data: {},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots"],
			});
		},
	});

	const deleteSlotMutation = useMutation({
		mutationFn: async (slotId: string) => {
			return await deleteScheduledSlot({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					slotId,
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots"],
			});
		},
	});

	const addTweetMutation = useMutation({
		mutationFn: async (slotId: string) => {
			return await addTweetToSlot({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					slotId,
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots"],
			});
		},
	});

	const handleDeleteSlot = (slotId: string) => {
		deleteSlotMutation.mutate(slotId);
	};

	const handleAddTweet = useCallback(() => {
		if (publications.length > 0) {
			addTweetMutation.mutate(publications[0].id);
		}
	}, [addTweetMutation.mutate, publications]);

	const handleCreateSlot = useCallback(() => {
		createSlotMutation.mutate();
	}, [createSlotMutation.mutate]);

	useEffect(() => {
		console.log("publications", publications);

		if (publications.filter((pub) => pub.status === "WAITING").length === 0) {
			// No publications - show "Add slot" button
			updateButtons({
				mainButton: {
					state: "visible",
					text: "Add slot",
					hasShineEffect: true,
					isEnabled: true,
					action: {
						type: "callback",
						payload: handleCreateSlot,
					},
				},
				secondaryButton: {
					state: "hidden",
				},
			});
		} else {
			// Has publications - show "Publish" and "Add slot" buttons
			const hasWaitingPubs = publications.some(
				(pub) => pub.status === "WAITING",
			);
			updateButtons({
				mainButton: {
					text: "Publish",
					state: "visible",
					isEnabled: hasWaitingPubs,
					hasShineEffect: true,
					action: {
						type: "callback",
						payload: () => {
							respondToWebAppData({
								headers: { Authorization: rawInitData ?? "" },
								data: {
									slotId: publications[0].id,
								},
							});
						},
					},
				},
				secondaryButton: {
					state: "visible",
					text: "Add tweet",
					isEnabled: true,
					action: {
						type: "callback",
						payload: handleAddTweet,
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
		publications,
		handleCreateSlot,
		handleAddTweet,
		rawInitData,
		updateButtons,
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

	return (
		<div className="min-h-screen bg-gray-50 p-2 sm:p-4">
			<div className="mx-auto max-w-4xl">
				{/* Dev Environment Testing Buttons */}
				{isDevWithMockedTGA && (
					<div className="mb-6 space-y-4 sm:mb-8">
						<Card className="border-blue-200 bg-blue-50">
							<CardContent className="py-4">
								<div className="mb-3 flex items-center gap-2">
									<div className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
									<p className="font-medium text-blue-800 text-sm">
										Dev Environment - Local Testing
									</p>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={handleCreateSlot}
										disabled={createSlotMutation.isPending}
										className="border-blue-300 bg-white hover:bg-blue-50"
									>
										<Plus className="mr-2 h-4 w-4" />
										{createSlotMutation.isPending ? "Creating..." : "Add Slot"}
									</Button>
									{publications.length > 0 && (
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												respondToWebAppData({
													headers: { Authorization: rawInitData ?? "" },
													data: {
														slotId: publications[0].id,
													},
												});
											}}
											disabled={
												!publications.some((pub) => pub.status === "WAITING")
											}
											className="border-green-300 bg-white hover:bg-green-50"
										>
											Publish First Slot
										</Button>
									)}
								</div>
							</CardContent>
						</Card>
					</div>
				)}

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
				{!isPending &&
					publications.length === 0 &&
					renderEmptyState(createSlotMutation.data?.error)}

				{/* Publications List */}
				{!isPending && publications.length > 0 && (
					<div className="mx-auto max-w-4xl space-y-6">
						{publications.map((data) => (
							<div key={data.id} className="space-y-4">
								<SlotCard
									id={data.id}
									status={data.status}
									scheduledSlotTweets={data.scheduledSlotTweets}
									onDelete={handleDeleteSlot}
								/>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export const Route = createFileRoute("/publications")({
	component: PublicationsPage,
});
