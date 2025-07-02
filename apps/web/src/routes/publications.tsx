import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	AlertTriangle,
	Calendar,
	CalendarDays,
	CheckCircle2,
	Clock,
} from "lucide-react";
import { useEffect, useState } from "react";
import { SlotCard } from "@/components/slot-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import { respondToWebAppData } from "@/routes/api/bot";
import { getPostingChannels } from "@/routes/api/posting-channels";
import {
	addTweetToSlot,
	createScheduledSlot,
	deleteScheduledSlot,
	getScheduledSlots,
	type ScheduledSlot,
	shuffleTweet,
} from "@/routes/api/scheduled-slots";
import { deletePhoto } from "@/routes/api/scheduled-slots/photos";

interface PublicationSections {
	today: ScheduledSlot[];
	tomorrow: ScheduledSlot[];
	upcoming: ScheduledSlot[];
	completed: ScheduledSlot[];
}

function PublicationsPage() {
	const [selectedPostingChannelId, setSelectedPostingChannelId] = useState<
		number | undefined
	>(undefined); // Default posting channel ID
	const queryClient = useQueryClient();

	const { rawInitData, updateButtons } = useTelegramContext();

	const {
		data: publications = [],
		isLoading,
		error,
		refetch: loadPublications,
	} = useQuery({
		queryKey: ["scheduled-slots", selectedPostingChannelId],
		queryFn: async () => {
			return await getScheduledSlots({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					postingChannelId: selectedPostingChannelId,
				},
			});
		},
		enabled: !!rawInitData,
	});

	const availablePostingChannels = useQuery({
		queryKey: ["available-posting-channels"],
		queryFn: async () => {
			return await getPostingChannels({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		enabled: !!rawInitData,
	});

	// Set default posting channel when data loads (only once)
	useEffect(() => {
		if (
			selectedPostingChannelId === undefined &&
			availablePostingChannels.data?.postingChannels &&
			availablePostingChannels.data.postingChannels.length > 0
		) {
			setSelectedPostingChannelId(
				Number(availablePostingChannels.data.postingChannels[0].chat.id),
			);
		}
	}, [availablePostingChannels.data, selectedPostingChannelId]); // Remove selectedPostingChannelId from deps

	const createSlotMutation = useMutation({
		mutationFn: async () => {
			// Calculate next available slot time (9 AM - 11 PM)
			const nextSlotTime = getNextAvailableSlotTime();

			return await createScheduledSlot({
				type: "dynamic",
				headers: { Authorization: rawInitData ?? "" },
				data: {
					postingChannelId: selectedPostingChannelId,
					scheduledFor: nextSlotTime.toISOString(),
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots", selectedPostingChannelId],
			});
		},
	});

	const deleteSlotMutation = useMutation({
		mutationFn: async (slotId: string) => {
			return await deleteScheduledSlot({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					postingChannelId: selectedPostingChannelId,
					slotId,
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots", selectedPostingChannelId],
			});
		},
	});

	const handleDeleteSlot = (slotId: string) => {
		deleteSlotMutation.mutate(slotId);
	};

	const deletePhotoMutation = useMutation({
		mutationFn: async ({
			slotId,
			photoId,
		}: {
			slotId: string;
			photoId: string;
		}) => {
			return await deletePhoto({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					slotId,
					photoId,
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots", selectedPostingChannelId],
			});
		},
	});

	const handleDeleteImage = (slotId: string, photoId: string) => {
		deletePhotoMutation.mutate({ slotId, photoId });
	};

	const shuffleTweetMutation = useMutation({
		mutationFn: async ({
			slotId,
			tweetId,
		}: {
			slotId: string;
			tweetId: string;
		}) => {
			return await shuffleTweet({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					slotId,
					tweetId,
					postingChannelId: selectedPostingChannelId,
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots", selectedPostingChannelId],
			});
		},
	});

	const handleShuffleTweet = (slotId: string, tweetId: string) => {
		shuffleTweetMutation.mutate({ slotId, tweetId });
	};

	const addTweetMutation = useMutation({
		mutationFn: async ({ slotId }: { slotId: string }) => {
			return await addTweetToSlot({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					slotId,
					postingChannelId: selectedPostingChannelId,
				},
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["scheduled-slots", selectedPostingChannelId],
			});
		},
	});

	const handleAddTweet = (slotId: string) => {
		addTweetMutation.mutate({ slotId });
	};

	// Simple effect that only runs when we have meaningful data
	useEffect(() => {
		console.log("Updating buttons for:", {
			channelId: selectedPostingChannelId,
			publicationsCount: publications.length,
		});

		if (publications.length === 0) {
			// No publications - show "Add slot" button
			updateButtons({
				mainButton: {
					state: "visible",
					text: "Add slot",
					hasShineEffect: true,
					isEnabled: selectedPostingChannelId !== undefined,
					action: {
						type: "callback",
						payload: () => createSlotMutation.mutate(),
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
					text: "Add tweet",
					state: "visible",
					isEnabled: true,
					action: {
						type: "callback",
						payload: () =>
							addTweetMutation.mutate({ slotId: publications[0].id }),
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
		selectedPostingChannelId,
		publications,
		addTweetMutation.mutate,
		createSlotMutation.mutate,
		rawInitData,
		updateButtons,
	]);

	const getNextAvailableSlotTime = () => {
		const today = new Date();
		// Random time between 9 AM and 11 PM
		today.setHours(
			9 + Math.floor(Math.random() * 14),
			Math.floor(Math.random() * 60),
			0,
			0,
		);

		// Check if today is already taken
		const todaySlots = publications.filter((slot) => {
			const slotDate = new Date(slot.scheduledFor);
			return slotDate.toDateString() === today.toDateString();
		});

		if (todaySlots.length === 0) {
			return today;
		}

		// Find next available day
		const nextDay = new Date(today);
		let attempts = 0;
		while (attempts < 30) {
			nextDay.setDate(nextDay.getDate() + 1);
			const daySlots = publications.filter((slot) => {
				const slotDate = new Date(slot.scheduledFor);
				return slotDate.toDateString() === nextDay.toDateString();
			});
			if (daySlots.length === 0) {
				return nextDay;
			}
			attempts++;
		}

		return nextDay;
	};

	const canAddMoreTweets = (slot: ScheduledSlot) => {
		return slot.scheduledSlotTweets.length < 10 && slot.status === "WAITING"; // Allow up to 5 tweets per slot
	};

	const organizePublications = (pubs: ScheduledSlot[]): PublicationSections => {
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate() + 1);

		return pubs.reduce(
			(sections, pub) => {
				const pubDate = new Date(pub.scheduledFor);
				const pubDay = new Date(
					pubDate.getFullYear(),
					pubDate.getMonth(),
					pubDate.getDate(),
				);

				if (pub.status === "PUBLISHED") {
					sections.completed.push(pub);
				} else if (pubDay.getTime() === today.getTime()) {
					sections.today.push(pub);
				} else if (pubDay.getTime() === tomorrow.getTime()) {
					sections.tomorrow.push(pub);
				} else {
					sections.upcoming.push(pub);
				}

				return sections;
			},
			{
				today: [],
				tomorrow: [],
				upcoming: [],
				completed: [],
			} as PublicationSections,
		);
	};

	const sections = organizePublications(publications);

	const hasPostingChannels =
		!availablePostingChannels.isLoading &&
		availablePostingChannels.data?.postingChannels &&
		availablePostingChannels.data.postingChannels.length > 0;

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

	const renderSection = (
		title: string,
		icon: React.ReactNode,
		slots: ScheduledSlot[],
		_emptyMessage: string,
	) => {
		if (slots.length === 0) return null;

		return (
			<div className="space-y-3">
				<div className="flex items-center gap-2 border-gray-200 border-b pb-2">
					{icon}
					<h2 className="font-semibold text-lg sm:text-xl">
						{title} ({slots.length})
					</h2>
				</div>
				<div className="space-y-3">
					{slots.map((slot) => (
						<SlotCard
							key={slot.id}
							id={slot.id}
							scheduledFor={slot.scheduledFor}
							status={slot.status}
							scheduledSlotTweets={slot.scheduledSlotTweets}
							onDelete={handleDeleteSlot}
							onAddTweet={canAddMoreTweets(slot) ? handleAddTweet : undefined}
							onDeleteImage={handleDeleteImage}
							onShuffleTweet={handleShuffleTweet}
						/>
					))}
				</div>
			</div>
		);
	};

	const renderEmptyState = () => (
		<div className="flex min-h-[50vh] items-center justify-center">
			<div className="text-center">
				<Calendar className="mx-auto mb-4 h-12 w-12 text-gray-400" />
				<p className="mb-2 text-gray-500 text-lg">No scheduled publications</p>
				<p className="text-gray-400 text-sm">
					Create your first scheduled slot to get started
				</p>
			</div>
		</div>
	);

	return (
		<div className="min-h-screen bg-gray-50 p-2 sm:p-4">
			<div className="mx-auto max-w-4xl">
				{/* Chat Selector and Create New Slot Button */}
				{hasPostingChannels && publications.length > 0 && (
					<div className="mb-6 space-y-4 sm:mb-8">
						<div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
							{/* Only show channel selector if there are more than 1 channels */}
							{availablePostingChannels.data?.postingChannels &&
								availablePostingChannels.data.postingChannels.length > 1 && (
									<div className="flex flex-col gap-2">
										<label
											htmlFor="channel-selector"
											className="font-medium text-gray-700 text-sm"
										>
											Target Channel:
										</label>
										<Select
											value={selectedPostingChannelId?.toString()}
											onValueChange={(value) => {
												setSelectedPostingChannelId(Number(value));
											}}
										>
											<SelectTrigger className="w-full md:w-[280px]">
												<SelectValue placeholder="Select a channel" />
											</SelectTrigger>
											<SelectContent>
												{availablePostingChannels.data?.postingChannels.map(
													(channel) => (
														<SelectItem
															key={channel.chat.id}
															value={channel.chat.id.toString()}
														>
															{channel.chat.title}
														</SelectItem>
													),
												)}
											</SelectContent>
										</Select>
									</div>
								)}
						</div>
					</div>
				)}

				{/* Error State */}
				{error?.message && (
					<Card className="border-red-200 bg-red-50">
						<CardContent className="py-4">
							<p className="text-red-800 text-sm">{error.message}</p>
							<Button
								variant="outline"
								size="sm"
								className="mt-2"
								onClick={() => {
									loadPublications();
								}}
							>
								Retry
							</Button>
						</CardContent>
					</Card>
				)}

				{/* No Channels State */}
				{!availablePostingChannels.isLoading &&
					!availablePostingChannels.error &&
					availablePostingChannels.data &&
					(!availablePostingChannels.data.postingChannels ||
						availablePostingChannels.data.postingChannels.length === 0) &&
					renderNoChannelsState()}

				{/* Empty State */}
				{!isLoading &&
					!error &&
					hasPostingChannels &&
					publications.length === 0 &&
					renderEmptyState()}

				{/* Publications Sections */}
				{!isLoading && hasPostingChannels && publications.length > 0 && (
					<div className="space-y-6 sm:space-y-8">
						{/* Today's Publications */}
						{renderSection(
							"Today",
							<Clock className="h-5 w-5 text-blue-600" />,
							sections.today,
							"No publications scheduled for today",
						)}

						{/* Tomorrow's Publications */}
						{renderSection(
							"Tomorrow",
							<CalendarDays className="h-5 w-5 text-green-600" />,
							sections.tomorrow,
							"No publications scheduled for tomorrow",
						)}

						{/* Upcoming Publications */}
						{renderSection(
							"Upcoming",
							<Calendar className="h-5 w-5 text-orange-600" />,
							sections.upcoming,
							"No upcoming publications scheduled",
						)}

						{/* Completed Publications */}
						{renderSection(
							"Completed",
							<CheckCircle2 className="h-5 w-5 text-gray-600" />,
							sections.completed,
							"No completed publications",
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export const Route = createFileRoute("/publications")({
	component: PublicationsPage,
});
