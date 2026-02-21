import type { ProfileResult } from "@starlight/api/routers/index";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, Cookie, Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TextField } from "@/components/ui/text-field";
import { useTelegramContext } from "@/providers/telegram-buttons-provider";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/settings")({
	component: RouteComponent,
	loader: async ({ context: { queryClient } }) => {
		if (import.meta.env.SSR) {
			return;
		}

		const profileOptions = orpc.profiles.get.queryOptions({
			queryKey: ["profile"],
			enabled: true,
			staleTime: 5 * 60 * 1000,
			gcTime: 30 * 60 * 1000,
			retry: 1,
		});

		await queryClient.fetchQuery(profileOptions);
	},
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
					<h1 className="font-semibold text-2xl text-base-content">Settings</h1>
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
		visibilityMutation.isPending;

	return (
		<main className="container mx-auto max-w-2xl px-4 py-10">
			<Card className="card-border">
				<CardContent className="mt-4 space-y-6 pt-2 pb-2">
					{/* Cookie Management Section */}
					<section className="space-y-4">
						<h2 className="font-semibold text-base-content text-sm uppercase tracking-wide">
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
							<Alert className="alert-horizontal">
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
										<AlertCircle className="h-4 w-4" />
										<AlertDescription>
											Connect your Twitter account by adding authentication
											cookies
										</AlertDescription>
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

					{/* Profile Visibility Section */}
					<section className="mb-2">
						<label className="label cursor-pointer gap-2 text-wrap">
							<input
								checked={profile?.user?.isPublic ?? false}
								className="toggle toggle-sm data-[theme=light]:toggle-neutral data-[theme=dark]:toggle-accent"
								onChange={(e) =>
									visibilityMutation.mutate({
										status: e.target.checked ? "public" : "private",
									})
								}
								type="checkbox"
							/>
							<span className="label-text w-full text-left">
								Make your profile visible to other people
							</span>
						</label>
					</section>
				</CardContent>
				{/* Profile Block - Shown when public */}
				{profile?.user?.isPublic && (
					<div className="w-full bg-base-200 p-4">
						<div className="flex items-center">
							<p className="text-base-content/70 text-sm">
								Link to your profile:{" "}
								<Link
									className="link text-sm"
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
