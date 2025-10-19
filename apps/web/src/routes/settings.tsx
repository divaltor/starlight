import type { ProfileResult } from "@starlight/api/routers/index";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
	const [displayError, setDisplayError] = useState<string | null>(null);

	const { rawInitData } = useTelegramContext();
	const queryClient = useQueryClient();

	const {
		data: profile,
		isLoading,
		error: cookieError,
		refetch: refetchProfile,
	} = useQuery(
		orpc.profiles.get.queryOptions({
			queryKey: ["profile"],
			enabled: !!rawInitData,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: 1,
		})
	);

	const saveCookiesMutation = useMutation(
		orpc.cookies.save.mutationOptions({
			onSuccess: () => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					hasValidCookies: true,
				}));
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
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					hasValidCookies: false,
				}));
			},
		})
	);

	const disconnectChannelMutation = useMutation(
		orpc.channels.disconnect.mutationOptions({
			onSuccess: () => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					postingChannel: undefined,
				}));
			},
		})
	);

	const visibilityMutation = useMutation(
		orpc.profiles.visibility.mutationOptions({
			onSuccess: (
				_data: { success: boolean },
				variables: { status: "public" | "private" }
			) => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					user: {
						...old.user,
						isPublic: variables.status === "public",
					},
				}));
			},
		})
	);

	if (isLoading && !profile) {
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

	if (cookieError && !profile) {
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
									onClick={() => refetchProfile()}
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
		disconnectChannelMutation.isPending ||
		visibilityMutation.isPending;

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

				<CardContent className="space-y-10 pt-4 pb-4">
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
						{profile?.hasValidCookies ? (
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
								{!profile?.hasValidCookies && (
									<Alert variant="default">
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
										{profile?.hasValidCookies && (
											<Button
												disabled={isSubmitting}
												onClick={() =>
													queryClient.setQueryData(
														["profile"],
														(old: ProfileResult) => ({
															...old,
															hasValidCookies: false,
														})
													)
												}
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

					<h2 className="font-semibold text-gray-800 text-sm uppercase tracking-wide">
						Advanced settings
					</h2>
					{/* Posting Channel Section */}
					<section>
						{profile?.postingChannel && (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-3">
									<div className="h-12 w-12 overflow-hidden rounded-full bg-gray-100">
										{profile?.postingChannel.photoThumbnail ? (
											// biome-ignore lint/nursery/useImageSize: Don't care
											<img
												alt={profile?.postingChannel.title || "Channel"}
												className="h-full w-full object-cover"
												src={profile?.postingChannel.photoThumbnail}
											/>
										) : (
											<div className="flex h-full w-full items-center justify-center bg-gray-200 font-medium text-gray-500 text-sm">
												{profile?.postingChannel.title?.charAt(0) || "C"}
											</div>
										)}
									</div>
									<div>
										<p className="font-medium text-gray-900 text-sm">
											{profile?.postingChannel.title || "Unknown Channel"}
										</p>
										<p className="prose prose-sm text-gray-500">
											{profile?.postingChannel.username
												? `@${profile?.postingChannel.username}`
												: `ID: ${profile?.postingChannel.id}`}
										</p>
									</div>
								</div>
								<DialogTrigger>
									<Button
										disabled={disconnectChannelMutation.isPending}
										size="sm"
										variant="destructive"
									>
										Disconnect
									</Button>
									<DialogContent>
										<DialogHeader>
											<DialogTitle>Disconnect Channel</DialogTitle>
											<DialogDescription>
												Are you sure? You won't be able to send publications
												into this channel.
											</DialogDescription>
										</DialogHeader>
										<DialogFooter className="pt-4">
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
								</DialogTrigger>
							</div>
						)}
					</section>

					{/* Profile Visibility Section */}
					<section>
						<label className="label cursor-pointer">
							<input
								checked={profile?.user?.isPublic ?? false}
								className="toggle toggle-sm toggle-primary"
								onChange={(e) =>
									visibilityMutation.mutate({
										status: e.target.checked ? "public" : "private",
									})
								}
								type="checkbox"
							/>
							<span className="label-text">
								Make your profile visible to other people
							</span>
						</label>
					</section>
				</CardContent>
				{/* Profile Block - Shown when public */}
				{profile?.user?.isPublic && (
					<div className="w-full bg-base-200 p-4">
						<div className="flex items-center">
							<p className="text-gray-600 text-sm">
								Link to your profile:{" "}
								<Link
									className="text-neutral text-sm underline"
									params={{ slug: profile.user.username }}
									to="/profile/$slug"
								>
									{`${window.location.origin}/profile/${profile.user.username}`}
								</Link>
							</p>
						</div>
					</div>
				)}
			</Card>
		</main>
	);
}
