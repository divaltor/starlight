import type { ScheduledSlotStatus } from "@repo/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Tweet } from "@the-convocation/twitter-scraper";
import {
	AlertTriangle,
	Calendar,
	CalendarDays,
	CheckCircle2,
	Clock,
	Plus,
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
import { getPostingChannels } from "@/routes/api/posting-channels";
import {
	createScheduledSlot,
	deleteScheduledSlot,
	getScheduledSlots,
} from "@/routes/api/scheduled-slots";
import { deletePhoto } from "@/routes/api/scheduled-slots/photos";

interface ScheduledSlotPhoto {
	id: string;
	photo: {
		id: string;
		s3Path: string | null;
		originalUrl: string;
	};
}

interface ScheduledSlotTweet {
	id: string;
	tweet: {
		id: string;
		tweetData: Tweet;
	};
	scheduledSlotPhotos: ScheduledSlotPhoto[];
}

interface ScheduledSlot {
	id: string;
	scheduledFor: Date;
	createdAt: Date;
	status: ScheduledSlotStatus;
	scheduledSlotTweets: ScheduledSlotTweet[];
}

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

	const { rawInitData, setMainButton } = useTelegramContext();
	const router = useRouter();

	const {
		data: publicationsData,
		isLoading,
		error,
		refetch: loadPublications,
	} = useQuery({
		queryKey: ["scheduled-slots", selectedPostingChannelId],
		queryFn: async () => {
			return await getScheduledSlots({
				data: {
					initData: rawInitData,
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
				data: { initData: rawInitData },
			});
		},
		enabled: !!rawInitData,
	});

	useEffect(() => {
		setMainButton("Gallery", true, () => {
			router.navigate({ to: "/app" });
		});
	}, [setMainButton, router]);

	// Set default posting channel when data loads
	useEffect(() => {
		if (
			!selectedPostingChannelId &&
			availablePostingChannels.data?.postingChannels &&
			availablePostingChannels.data.postingChannels.length > 0
		) {
			console.log(
				"availablePostingChannels.data.postingChannels",
				availablePostingChannels.data.postingChannels,
			);
			setSelectedPostingChannelId(
				Number(availablePostingChannels.data.postingChannels[0].chat.id),
			);
			console.log(
				"availablePostingChannels.data.postingChannels[0].chat.id",
				availablePostingChannels.data.postingChannels[0].chat.id,
			);
		}
	}, [availablePostingChannels.data, selectedPostingChannelId]);

	const publications = publicationsData
		? publicationsData.map((slot) => ({
				id: slot.id,
				scheduledFor: new Date(slot.scheduledFor),
				createdAt: new Date(slot.createdAt),
				status: slot.status,
				scheduledSlotTweets: slot.scheduledSlotTweets || [],
			}))
		: [];

	const createSlotMutation = useMutation({
		mutationFn: async () => {
			// Calculate next available slot time (9 AM - 11 PM)
			const nextSlotTime = getNextAvailableSlotTime();

			return await createScheduledSlot({
				data: {
					initData: rawInitData,
					postingChannelId: selectedPostingChannelId!,
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

	const handleCreateNewSlot = () => {
		createSlotMutation.mutate();
	};

	const deleteSlotMutation = useMutation({
		mutationFn: async (slotId: string) => {
			return await deleteScheduledSlot({
				data: {
					initData: rawInitData,
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

	const handleReshuffleSlot = (_slotId: string) => {
		// For now, just reload - reshuffling logic would need backend implementation
		loadPublications();
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
				data: {
					initData: rawInitData,
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

	const handleReshuffleImage = (slotId: string, photoId: string) => {
		// TODO: Implement backend API for reshuffling specific images in slots
		console.log("Reshuffling photo:", photoId, "in slot:", slotId);
	};

	const handleAddImage = (slotId: string) => {
		// TODO: Implement backend API for adding specific images to slots
		console.log("Adding image to slot:", slotId);
	};

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

	const getAllPhotosFromSlot = (slot: ScheduledSlot) => {
		return slot.scheduledSlotTweets.flatMap((tweet) =>
			tweet.scheduledSlotPhotos.map((sp) => ({
				id: sp.photo.id,
				url: sp.photo.s3Path || sp.photo.originalUrl || "/placeholder.svg",
				tweetId: tweet.tweet.id,
				author: tweet.tweet.tweetData?.username || "unknown",
			})),
		);
	};

	const canAddMoreImages = (slot: ScheduledSlot) => {
		const totalPhotos = getAllPhotosFromSlot(slot).length;
		return totalPhotos < 15 && slot.status === "WAITING"; // Allow up to 15 photos per slot
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
			<Card className="border-orange-200 bg-orange-50 max-w-md mx-auto">
				<CardContent className="py-12 text-center">
					<AlertTriangle className="mx-auto mb-4 h-12 w-12 text-orange-500" />
					<p className="mb-2 text-orange-800 text-lg font-medium">
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
							createdAt={slot.createdAt}
							status={slot.status}
							scheduledSlotTweets={slot.scheduledSlotTweets}
							onDelete={handleDeleteSlot}
							onReshuffle={handleReshuffleSlot}
							onAddTweet={canAddMoreImages(slot) ? handleAddImage : undefined}
							onDeleteImage={handleDeleteImage}
							onReshuffleImage={handleReshuffleImage}
						/>
					))}
				</div>
			</div>
		);
	};

	const renderEmptyState = () => (
		<div className="flex min-h-[50vh] items-center justify-center">
			<Card className="max-w-md mx-auto">
				<CardContent className="py-12 text-center">
					<Calendar className="mx-auto mb-4 h-12 w-12 text-gray-400" />
					<p className="mb-2 text-gray-500 text-lg">
						No scheduled publications
					</p>
					<p className="mb-4 text-gray-400 text-sm">
						Create your first scheduled slot to get started
					</p>
					<Button
						onClick={handleCreateNewSlot}
						disabled={createSlotMutation.isPending}
					>
						<Calendar className="mr-2 h-4 w-4" />
						{createSlotMutation.isPending ? "Creating..." : "Create first slot"}
					</Button>
				</CardContent>
			</Card>
		</div>
	);

	return (
		<div className="min-h-screen bg-gray-50 p-2 sm:p-4">
			<div className="mx-auto max-w-4xl">
				{/* Header */}
				<div className="mb-6 sm:mb-8">
					<h1 className="mb-2 font-bold text-2xl text-gray-900 sm:text-3xl">
						Publication Scheduler
					</h1>
					<p className="text-gray-600 text-sm sm:text-base">
						Schedule and manage your social media publications
					</p>
				</div>

				{/* Chat Selector and Create New Slot Button */}
				{hasPostingChannels && publications.length > 0 && (
					<div className="mb-6 space-y-4 sm:mb-8">
						<div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
							<div className="flex flex-col gap-2">
								<label className="font-medium text-gray-700 text-sm">
									Target Channel:
								</label>
								<Select
									value={selectedPostingChannelId?.toString()}
									onValueChange={(value) => {
										setSelectedPostingChannelId(Number(value));
									}}
								>
									<SelectTrigger className="w-full lg:w-[280px]">
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
							<div className="flex justify-center lg:justify-end">
								<Button
									onClick={handleCreateNewSlot}
									disabled={createSlotMutation.isPending}
									className="gap-2 w-[70%] lg:w-auto"
									size="lg"
								>
									<Plus className="h-4 w-4" />
									{createSlotMutation.isPending
										? "Creating..."
										: "Create New Slot"}
								</Button>
							</div>
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
