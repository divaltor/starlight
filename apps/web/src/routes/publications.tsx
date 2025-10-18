import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	AlertTriangle,
	Calendar,
	MessageSquare,
	MoreVertical,
	Trash2,
} from "lucide-react";
import { useEffect } from "react";
import { SlotCard } from "@/components/slot-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

	const deleteSlotMutation = useMutation(
		orpc.scheduling.slots.delete.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: ["scheduled-slots"],
				});
			},
		})
	);

	const handleDeleteSlot = () => {
		if (slot) {
			deleteSlotMutation.mutate({ slotId: slot.id });
		}
	};

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
							orpc.respond.send.call({ slotId: slot.id });
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
								orpc.scheduling.tweets.add.call({
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
	}, [slot, updateButtons, isPending, createSlotMutation]);

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
		const uniqueAuthors = [...new Set(tweets.map((tweet) => tweet.artist))];

		return (
			<div className="min-h-screen bg-gray-50 p-2 sm:p-4">
				<div className="mx-auto max-w-4xl">
					{/* No Channels State */}
					{isError && renderNoChannelsState()}

					{/* Empty State */}
					{!(isPending || isError || slot) &&
						renderEmptyState(createSlotMutation.error?.message)}

					{/* Publications Header */}
					{slot && (
						<>
							<Card className="mb-4 shadow-sm">
								<CardHeader className="pb-3">
									<div className="flex items-start justify-between gap-3">
										<div className="flex flex-col gap-2">
											{/* Summary */}
											<div className="flex flex-wrap items-center gap-2">
												{slot.postingChannel.chat.title && (
													<Badge className="text-xs" variant="outline">
														📢 {slot.postingChannel.chat.title}
													</Badge>
												)}
												<div className="flex items-center gap-1">
													<MessageSquare className="h-3 w-3 text-gray-500" />
													<span className="text-gray-500 text-xs">
														{slot.scheduledSlotTweets.length} tweet
														{slot.scheduledSlotTweets.length !== 1 ? "s" : ""}
													</span>
												</div>
												{uniqueAuthors.length > 0 && (
													<span className="text-gray-400 text-xs">
														@{uniqueAuthors.slice(0, 2).join(", @")}
														{uniqueAuthors.length > 2 &&
															` +${uniqueAuthors.length - 2}`}
													</span>
												)}
											</div>
										</div>

										{/* Mobile dropdown menu */}
										<div className="md:hidden">
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														className="h-8 w-8 p-0"
														size="sm"
														variant="ghost"
													>
														<MoreVertical className="h-4 w-4" />
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="w-40">
													{slot.status === "WAITING" && (
														<DropdownMenuItem
															className="gap-2 text-red-600 focus:text-red-600"
															onClick={handleDeleteSlot}
														>
															<Trash2 className="h-4 w-4" />
															Delete
														</DropdownMenuItem>
													)}
												</DropdownMenuContent>
											</DropdownMenu>
										</div>

										{/* Desktop controls */}
										<div className="hidden items-center gap-1 md:flex">
											{slot.status === "WAITING" && (
												<Button
													className="gap-1 text-red-600 text-xs hover:bg-red-50 hover:text-red-700"
													onClick={handleDeleteSlot}
													size="sm"
													variant="outline"
												>
													<Trash2 className="h-3 w-3" />
													Delete
												</Button>
											)}
										</div>
									</div>
								</CardHeader>
							</Card>

							{/* Tweets list */}
							<div className="space-y-4">
								{tweets.map((tweet) => (
									<SlotCard key={tweet.id} slot={slot} tweets={tweets} />
								))}
							</div>
						</>
					)}
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
						<div className="text-center">
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
