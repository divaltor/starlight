import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Cookie, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProfileShareSection } from "@/components/profile-share-section";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { decodeCookies } from "@/lib/utils";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import {
	deleteCookies,
	saveCookies,
	verifyCookies,
} from "@/routes/api/cookies";
import {
	deletePostingChannel,
	getPostingChannel,
} from "@/routes/api/posting-channels";

export const Route = createFileRoute("/settings")({
	component: RouteComponent,
});

function RouteComponent() {
	const [newCookies, setNewCookies] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [showCookieInput, setShowCookieInput] = useState(false);
	const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

	const { rawInitData } = useTelegramContext();
	const queryClient = useQueryClient();

	const {
		data: cookieStatus,
		isLoading,
		error: cookieError,
		refetch: refetchCookieStatus,
	} = useQuery({
		queryKey: ["cookie-status"],
		queryFn: async () => {
			return await verifyCookies({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		enabled: !!rawInitData,
		staleTime: 10 * 60 * 1000,
		gcTime: 30 * 60 * 1000,
		refetchOnWindowFocus: true,
		retry: 2,
	});

	// Query for posting channel
	const { data: postingChannel, isLoading: isPostingChannelLoading } = useQuery(
		{
			queryKey: ["posting-channel"],
			queryFn: async () => {
				return await getPostingChannel({
					headers: { Authorization: rawInitData ?? "" },
				});
			},
			enabled: !!rawInitData,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
		}
	);

	// Derive state from query data
	const cookiesStored = cookieStatus?.hasValidCookies ?? false;
	const twitterId = cookieStatus?.twitterId ?? null;

	const shouldShowCookieInput = !cookiesStored || showCookieInput;

	const saveCookiesMutation = useMutation({
		mutationFn: async (cookiesData: { cookies: string }) => {
			return await saveCookies({
				headers: { Authorization: rawInitData ?? "" },
				data: cookiesData,
			});
		},
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey: ["cookie-status"] });

			const previousStatus = queryClient.getQueryData(["cookie-status"]);
			return { previousStatus };
		},
		onSuccess: async (result, _variables, _context) => {
			if (result.error) {
				setError(result.error);
				return;
			}

			const verifyResult = await verifyCookies({
				headers: { Authorization: rawInitData ?? "" },
			});

			queryClient.setQueryData(["cookie-status"], verifyResult);

			if (verifyResult.hasValidCookies) {
				setShowCookieInput(false);
				setNewCookies("");
				setError(null);
			}
		},
		onError: (_error, _variables, context) => {
			if (context?.previousStatus) {
				queryClient.setQueryData(["cookie-status"], context.previousStatus);
			}
			setError(
				"An error occurred while saving your cookies. Please try again."
			);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["cookie-status"] });
		},
	});

	const deleteCookiesMutation = useMutation({
		mutationFn: async () => {
			return await deleteCookies({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey: ["cookie-status"] });

			const previousStatus = queryClient.getQueryData(["cookie-status"]);
			queryClient.setQueryData(["cookie-status"], {
				hasValidCookies: false,
				twitterId: null,
			});

			return { previousStatus };
		},
		onSuccess: (result, _variables, context) => {
			if (result.success) {
				setShowCookieInput(true);
				setError(null);
			} else {
				if (context?.previousStatus) {
					queryClient.setQueryData(["cookie-status"], context.previousStatus);
				}
				setError("Failed to delete cookies. Please try again.");
			}
		},
		onError: (_error, _variables, context) => {
			if (context?.previousStatus) {
				queryClient.setQueryData(["cookie-status"], context.previousStatus);
			}
			setError("An error occurred while deleting cookies. Please try again.");
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["cookie-status"] });
		},
	});

	const disconnectChannelMutation = useMutation({
		mutationFn: async () => {
			return await deletePostingChannel({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		onSuccess: (result) => {
			if (result.success) {
				queryClient.invalidateQueries({ queryKey: ["posting-channel"] });
				toast.success("Channel successfully disconnected");
				setShowDisconnectDialog(false);
			} else {
				toast.error("Failed to disconnect channel");
			}
		},
		onError: () => {
			toast.error("An error occurred while disconnecting the channel");
		},
	});

	const handleSaveCookies = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);

		try {
			const decodedCookies = decodeCookies(newCookies);

			if (!decodedCookies || decodedCookies.length === 0) {
				setError(
					"Invalid cookies format. Please check your cookies and try again."
				);
				return;
			}

			const requiredCookies = ["auth_token", "ct0", "kdt", "twid"];
			const cookieNames = decodedCookies.map((cookie) => cookie.key);
			const missingCookies = requiredCookies.filter(
				(name) => !cookieNames.includes(name)
			);

			if (missingCookies.length > 0) {
				setError(
					`Missing required cookies: ${missingCookies.join(", ")}. Please ensure you have all necessary Twitter authentication cookies.`
				);
				return;
			}

			const cookiesBase64 = btoa(newCookies);

			saveCookiesMutation.mutate({ cookies: cookiesBase64 });
		} catch {
			setError(
				"An error occurred while processing your cookies. Please try again."
			);
		}
	};

	const handleDeleteCookies = async () => {
		deleteCookiesMutation.mutate();
	};

	const handleDisconnectChannel = () => {
		disconnectChannelMutation.mutate();
	};

	if (isLoading && !cookieStatus) {
		return (
			<main className="container mx-auto max-w-2xl px-4 py-10">
				<div className="mb-8 flex items-center justify-between">
					<h1 className="font-semibold text-2xl text-gray-900">Settings</h1>
				</div>
				<Card className="border-0 bg-white/50 shadow-md backdrop-blur-sm">
					<CardHeader className="pb-1">
						<Skeleton className="h-6 w-32" />
						<Skeleton className="h-4 w-64" />
					</CardHeader>
					<CardContent className="space-y-6">
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<Skeleton className="h-4 w-20" />
								<Skeleton className="h-6 w-16" />
							</div>
							<Skeleton className="h-10 w-full" />
						</div>
						<div className="space-y-4">
							<Skeleton className="h-12 w-full" />
							<div className="space-y-2">
								<Skeleton className="h-24 w-full" />
								<Skeleton className="h-8 w-32" />
							</div>
						</div>
					</CardContent>
				</Card>
			</main>
		);
	}

	if (cookieError && !cookieStatus) {
		return (
			<main className="container mx-auto max-w-2xl px-4 py-10">
				<div className="mb-8 flex items-center justify-between">
					<h1 className="font-semibold text-2xl text-gray-900">Settings</h1>
				</div>
				<Card className="border-0 bg-white/50 shadow-md backdrop-blur-sm">
					<CardContent className="py-8">
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>Failed to load settings</AlertTitle>
							<div className="mt-2">
								<Button
									onClick={() => refetchCookieStatus()}
									size="sm"
									variant="outline"
								>
									Retry
								</Button>
							</div>
						</Alert>
					</CardContent>
				</Card>
			</main>
		);
	}

	const isSubmitting =
		saveCookiesMutation.isPending ||
		deleteCookiesMutation.isPending ||
		disconnectChannelMutation.isPending;

	return (
		<main className="container mx-auto max-w-2xl px-4 py-10">
			<div className="mb-8 flex items-center justify-between">
				<h1 className="font-semibold text-2xl text-gray-900">Settings</h1>
			</div>

			<Card className="border-0 bg-white/50 shadow-md backdrop-blur-sm">
				<CardHeader className="pb-1">
					<CardTitle className="font-medium text-gray-900 text-lg">
						Account Settings
					</CardTitle>
					<CardDescription className="text-gray-500">
						Manage your account authentication, posting channel and sharing
						options
					</CardDescription>
				</CardHeader>

				<CardContent className="space-y-10">
					{/* User Information Section */}
					<section className="space-y-3">
						<h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">
							Account
						</h2>
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<span className="font-medium text-gray-700 text-sm">
									Twitter ID
								</span>
								{twitterId && (
									<span className="rounded bg-green-100 px-2 py-0.5 font-medium text-green-700 text-xs">
										Connected
									</span>
								)}
							</div>
							<div className="rounded-lg border-0 bg-gray-50 px-3 py-2">
								<p className="font-mono text-gray-900 text-sm">
									{twitterId || (
										<span className="text-gray-400 italic">Not connected</span>
									)}
								</p>
							</div>
						</div>
					</section>

					{/* Cookie Management Section */}
					<section className="space-y-4">
						<h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">
							Authentication Cookies
						</h2>
						{cookiesStored && !shouldShowCookieInput ? (
							<Alert>
								<AlertTitle className="flex w-full items-center justify-between">
									<span className="flex items-center gap-2">
										<Cookie className="h-4 w-4" />
										Authentication cookies are saved.
									</span>
									<Button
										className="text-red-600 hover:bg-red-50 hover:text-red-700"
										disabled={isSubmitting}
										onClick={handleDeleteCookies}
										size="sm"
										variant="ghost"
									>
										<Trash2 className="h-4 w-4" /> Remove
									</Button>
								</AlertTitle>
							</Alert>
						) : (
							<div className="space-y-4">
								{!cookiesStored && (
									<Alert variant="amber">
										<AlertCircle />
										<AlertTitle>
											Connect your Twitter account by adding authentication
											cookies
										</AlertTitle>
									</Alert>
								)}

								<form className="space-y-4" onSubmit={handleSaveCookies}>
									<div className="space-y-2">
										<textarea
											className={`min-h-[100px] w-full rounded-lg border bg-white p-3 text-sm transition-colors focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${error ? "border-red-300 focus:border-red-400 focus:ring-red-500/20" : "border-gray-200"}`}
											disabled={isSubmitting}
											id="new-cookies"
											onChange={(e) => {
												setNewCookies(e.target.value);
												if (error) setError(null);
											}}
											placeholder="Required format: auth_token=xxx; ct0=xxx; ..."
											value={newCookies}
										/>
										{error && (
											<p className="mt-1 text-red-500 text-xs">{error}</p>
										)}
									</div>

									<div className="flex gap-2">
										<Button disabled={isSubmitting} size="sm" type="submit">
											{saveCookiesMutation.isPending
												? "Connecting..."
												: "Connect Account"}
										</Button>
										{cookiesStored && (
											<Button
												disabled={isSubmitting}
												onClick={() => setShowCookieInput(false)}
												size="sm"
												type="button"
												variant="outline"
											>
												Cancel
											</Button>
										)}
									</div>
								</form>
							</div>
						)}
					</section>

					{/* Posting Channel Section */}
					<section className="space-y-4">
						<h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">
							Connected Channel
						</h2>
						{isPostingChannelLoading ? (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<Skeleton className="h-12 w-12 rounded-full" />
									<div className="space-y-2">
										<Skeleton className="h-4 w-24" />
										<Skeleton className="h-3 w-32" />
									</div>
								</div>
								<Skeleton className="h-9 w-24" />
							</div>
						) : postingChannel ? (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<div className="h-12 w-12 overflow-hidden rounded-full bg-gray-100">
										{postingChannel.chat.thumbnailUrl ? (
											<img
												alt={postingChannel.chat.title || "Channel"}
												className="h-full w-full object-cover"
												src={postingChannel.chat.thumbnailUrl}
											/>
										) : (
											<div className="flex h-full w-full items-center justify-center bg-gray-200 font-medium text-gray-500 text-sm">
												{postingChannel.chat.title?.charAt(0) || "C"}
											</div>
										)}
									</div>
									<div>
										<p className="font-medium text-gray-900 text-sm">
											{postingChannel.chat.title || "Unknown Channel"}
										</p>
										<p className="text-gray-500 text-xs">
											{postingChannel.chat.username
												? `@${postingChannel.chat.username}`
												: `ID: ${postingChannel.chat.id}`}
										</p>
									</div>
								</div>
								<Dialog
									onOpenChange={setShowDisconnectDialog}
									open={showDisconnectDialog}
								>
									<DialogTrigger asChild>
										<Button
											disabled={disconnectChannelMutation.isPending}
											size="sm"
											variant="destructive"
										>
											Disconnect
										</Button>
									</DialogTrigger>
									<DialogContent>
										<DialogHeader>
											<DialogTitle>Disconnect Channel</DialogTitle>
											<DialogDescription>
												Are you sure? You won't be able to send publications
												into this channel.
											</DialogDescription>
										</DialogHeader>
										<DialogFooter>
											<Button
												disabled={disconnectChannelMutation.isPending}
												onClick={() => setShowDisconnectDialog(false)}
												variant="outline"
											>
												No
											</Button>
											<Button
												disabled={disconnectChannelMutation.isPending}
												onClick={handleDisconnectChannel}
												variant="destructive"
											>
												{disconnectChannelMutation.isPending
													? "Disconnecting..."
													: "Sure"}
											</Button>
										</DialogFooter>
									</DialogContent>
								</Dialog>
							</div>
						) : (
							<div className="py-4 text-gray-500 text-sm">
								No posting channel connected
							</div>
						)}
					</section>

					{/* Profile Share Section */}
					<section>
						<ProfileShareSection embedded rawInitData={rawInitData} />
					</section>
				</CardContent>
			</Card>
		</main>
	);
}
