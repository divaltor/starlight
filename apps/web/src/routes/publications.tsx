import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Calendar } from "lucide-react";
import { useEffect } from "react";
import { SlotCard } from "@/components/slot-card";
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
		<div className="flex h-full items-center justify-center">
			<div className="alert alert-warning mx-auto max-w-md shadow-lg">
				<AlertTriangle className="h-6 w-6 shrink-0 stroke-current" />
				<span className="font-medium text-lg">
					No Posting Channels Available
				</span>
				<div>
					<p className="text-sm">
						You need to add at least one posting channel before you can create
						and schedule publications. Please configure your channels using
						/connect command in chat.
					</p>
				</div>
			</div>
		</div>
	);

	const renderEmptyState = (error?: string | null) => (
		<div className="flex h-full items-center justify-center">
			<div className="mx-auto max-w-md text-center">
				<Calendar className="mx-auto mb-4 h-12 w-12 text-base-content/50" />
				<h3 className="mb-2 font-medium text-base-content/70 text-lg">
					No scheduled publications
				</h3>
				<p className="text-base-content/50 text-sm">
					Create your first scheduled slot to get started
				</p>
				{error && <p className="mt-2 text-error text-sm">{error}</p>}
			</div>
		</div>
	);

	if (slot && !isPending) {
		return (
			<div className="min-h-screen bg-base-100 p-4">
				<div className="mx-auto max-w-4xl">
					<SlotCard slot={slot} tweets={tweets} />
				</div>
			</div>
		);
	}

	const isEmptyState = !(slot || isPending || isError);

	return (
		<div
			className={
				isEmptyState || isPending
					? "h-screen bg-base-100 p-4"
					: "min-h-screen bg-base-100 p-4"
			}
		>
			<div className="mx-auto h-full max-w-4xl">
				{/* No Channels State */}
				{isError && renderNoChannelsState()}

				{/* Empty State */}
				{!(isPending || isError || slot) &&
					renderEmptyState(createSlotMutation.error?.message)}

				{/* Loading */}
				{isPending && (
					<div className="flex h-full items-center justify-center">
						<div className="text-center">
							<span className="loading loading-spinner mx-auto text-primary" />
							<p className="mt-2 text-base-content/50">
								Loading publications...
							</p>
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
