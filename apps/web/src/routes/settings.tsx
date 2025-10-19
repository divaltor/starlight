import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Cookie, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { TextField } from "@/components/ui/text-field";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/settings")({
	component: RouteComponent,
});

function RouteComponent() {
	const [newCookies, setNewCookies] = useState("");
	const [showCookieInput, setShowCookieInput] = useState(false);
	const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
	const [displayError, setDisplayError] = useState<string | null>(null);

	const { rawInitData } = useTelegramContext();
	const queryClient = useQueryClient();

	const {
		data: cookieStatus,
		isLoading,
		error: cookieError,
		refetch: refetchCookieStatus,
	} = useQuery(
		orpc.cookies.verify.queryOptions({
			queryKey: ["cookie-status"],
			enabled: !!rawInitData,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: 1,
		})
	);

	// Query for posting channel
	const { data: postingChannel, isLoading: isPostingChannelLoading } = useQuery(
		orpc.channels.get.queryOptions({
			queryKey: ["posting-channel"],
			enabled: !!rawInitData,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: 1,
		})
	);

	// Derive state from query data
	const cookiesStored = cookieStatus?.hasValidCookies ?? false;

	const shouldShowCookieInput = !cookiesStored || showCookieInput;

	const saveCookiesMutation = useMutation(
		orpc.cookies.save.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["cookie-status"] });
				setShowCookieInput(false);
				setNewCookies("");
				setDisplayError(null);
			},
			onError: (error: Error) => {
				setDisplayError(error.message || "Failed to save cookies");
			},
		})
	);

	const deleteCookiesMutation = useMutation(
		orpc.cookies.delete.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["cookie-status"] });
				setShowCookieInput(true);
			},
		})
	);

	const disconnectChannelMutation = useMutation(
		orpc.channels.disconnect.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["posting-channel"] });
				setShowDisconnectDialog(false);
			},
		})
	);

	if (isLoading && !cookieStatus) {
		return (
			<main className="container mx-auto max-w-2xl px-4 py-10">
				<div className="mb-8 flex items-center justify-between">
					<h1 className="font-semibold text-2xl text-gray-900">Settings</h1>
				</div>
				<Card>
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
				<Card>
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

			<Card className="card-border">
				<CardHeader className="pt-4 pb-1">
					<CardTitle className="card-title">Account Settings</CardTitle>
					<CardDescription className="text-gray-500">
						Manage your account authentication, posting channel and sharing
						options
					</CardDescription>
				</CardHeader>

				<CardContent className="space-y-10 pt-4 pb-0">
					{/* Cookie Management Section */}
					<section className="space-y-4">
						<h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">
							Authentication Cookies
						</h2>

						{/* Cookie Success/Error Messages */}
						{cookieError && (
							<Alert variant="destructive">
								<AlertCircle className="h-4 w-4" />
								<span>{cookieError.message}</span>
							</Alert>
						)}
						{cookiesStored && !shouldShowCookieInput ? (
							<Alert className="alert-vertical sm:alert-horizontal">
								<Cookie className="h-4 w-4 shrink-0" />
								<span>Authentication cookies are saved.</span>
								<div>
									<Button
										disabled={isSubmitting}
										isSoft={true}
										onClick={() => deleteCookiesMutation.mutate({})}
										size="sm"
										variant="destructive"
									>
										<Trash2 className="h-4 w-4" /> Remove
									</Button>
								</div>
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

								<form
									className="space-y-4"
									onSubmit={(e) => {
										e.preventDefault();
										saveCookiesMutation.mutate({ cookies: newCookies });
									}}
								>
									<div className="space-y-2">
										<TextField
											className={displayError ? "textarea-error" : ""}
											id="new-cookies"
											multiline
											onChange={(value) => {
												setNewCookies(value);
												setDisplayError(null);
											}}
											placeholder="Paste your authentication cookies here"
											value={newCookies}
										/>
										{displayError && (
											<p className="text-error text-sm">{displayError}</p>
										)}
									</div>

									<div className="flex gap-2">
										<Button disabled={isSubmitting} size="sm" type="submit">
											Save cookies
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
						{isPostingChannelLoading && (
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
						)}

						{!isPostingChannelLoading && postingChannel && (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<div className="h-12 w-12 overflow-hidden rounded-full bg-gray-100">
										{postingChannel.chat.thumbnailUrl ? (
											// biome-ignore lint/nursery/useImageSize: Don't care
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
												onClick={() => disconnectChannelMutation.mutate({})}
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
						)}
					</section>
				</CardContent>
			</Card>
		</main>
	);
}
