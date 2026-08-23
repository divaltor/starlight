import type { ProfileResult } from "@starlight/api/routers/index";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, Cookie, KeyRound, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
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
	const [pixivToken, setPixivToken] = useState("");
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
		}),
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
		}),
	);

	const deleteCookiesMutation = useMutation(
		orpc.cookies.delete.mutationOptions({
			onSuccess: () => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					hasValidCookies: false,
				}));
			},
		}),
	);

	const visibilityMutation = useMutation(
		orpc.profiles.visibility.mutationOptions({
			onSuccess: (_data: { success: boolean }, variables: { status: "public" | "private" }) => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					user: {
						...old.user,
						isPublic: variables.status === "public",
					},
				}));
			},
		}),
	);

	const savePixivMutation = useMutation(
		orpc.pixiv.save.mutationOptions({
			onSuccess: () => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					hasPixivCredential: true,
				}));
				setPixivToken("");
			},
		}),
	);
	const deletePixivMutation = useMutation(
		orpc.pixiv.delete.mutationOptions({
			onSuccess: () => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					hasPixivCredential: false,
				}));
			},
		}),
	);
	const pixivPrivateMutation = useMutation(
		orpc.pixiv.privateBookmarks.mutationOptions({
			onSuccess: (_data, variables) => {
				queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
					...old,
					pixivIncludePrivate: variables.enabled,
				}));
			},
		}),
	);

	if (isLoading && !profile) {
		return <SettingsPageSkeleton />;
	}

	if (cookieError && !profile) {
		return <SettingsLoadError onRetry={() => refetchProfile()} />;
	}

	const isSubmitting =
		saveCookiesMutation.isPending ||
		deleteCookiesMutation.isPending ||
		visibilityMutation.isPending ||
		savePixivMutation.isPending ||
		deletePixivMutation.isPending ||
		pixivPrivateMutation.isPending;
	const pixivError = profile?.hasPixivCredential
		? (deletePixivMutation.error?.message ?? pixivPrivateMutation.error?.message)
		: savePixivMutation.error?.message;

	return (
		<main className="container mx-auto max-w-2xl px-4 py-10">
			<Card className="card-border">
				<CardContent className="mt-4 space-y-6 pt-2 pb-2">
					<CookiesSection
						cookieError={cookieError}
						displayError={displayError}
						isSubmitting={isSubmitting}
						newCookies={newCookies}
						onDelete={() => deleteCookiesMutation.mutate({})}
						onDismissSaved={() =>
							queryClient.setQueryData(["profile"], (old: ProfileResult) => ({
								...old,
								hasValidCookies: false,
							}))
						}
						onSave={(cookies) => saveCookiesMutation.mutate({ cookies })}
						profile={profile}
						setDisplayError={setDisplayError}
						setNewCookies={setNewCookies}
					/>

					<section className="space-y-4">
						<h2 className="font-semibold text-base-content text-sm uppercase tracking-wide">
							Pixiv
						</h2>
						{pixivError && (
							<Alert variant="destructive">
								<AlertCircle className="h-4 w-4" />
								<span>{pixivError}</span>
							</Alert>
						)}
						{profile?.hasPixivCredential ? (
							<>
								<Alert className="alert-horizontal">
									<KeyRound className="h-4 w-4 shrink-0" />
									<span>Pixiv is connected.</span>
									<Button
										disabled={isSubmitting}
										onClick={() => deletePixivMutation.mutate({})}
										size="sm"
										variant="destructive"
									>
										<Trash2 className="h-4 w-4" /> Remove
									</Button>
								</Alert>
								<label className="label cursor-pointer gap-2 text-wrap">
									<input
										checked={profile.pixivIncludePrivate}
										className="toggle toggle-sm"
										onChange={(event) =>
											pixivPrivateMutation.mutate({ enabled: event.target.checked })
										}
										type="checkbox"
									/>
									<span className="label-text w-full text-left">Sync private bookmarks</span>
								</label>
							</>
						) : (
							<form
								className="space-y-3"
								onSubmit={(event) => {
									event.preventDefault();
									savePixivMutation.mutate({ refreshToken: pixivToken });
								}}
							>
								<TextField
									id="pixiv-refresh-token"
									label="Pixiv refresh token"
									onChange={setPixivToken}
									placeholder="Pixiv refresh token"
									value={pixivToken}
								/>
								<Button
									disabled={isSubmitting || pixivToken.trim().length < 20}
									size="sm"
									type="submit"
								>
									Connect Pixiv
								</Button>
							</form>
						)}
					</section>

					{/* Profile Visibility Section */}
					<VisibilitySection
						isPublic={profile?.user?.isPublic ?? false}
						onToggle={(status) => visibilityMutation.mutate({ status })}
					/>
				</CardContent>
				{/* Profile Block - Shown when public */}
				{profile?.user?.isPublic && <ProfileLinkBlock username={profile.user.username} />}
			</Card>
		</main>
	);
}

function SettingsPageSkeleton() {
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

function SettingsLoadError({ onRetry }: { onRetry: () => void }) {
	return (
		<main className="container mx-auto max-w-2xl px-4 py-10">
			<Card>
				<CardContent className="py-8">
					<Alert variant="destructive">
						<AlertCircle className="size-4" />
						<AlertTitle>Failed to load settings</AlertTitle>
						<div className="mt-2">
							<Button onClick={onRetry} size="sm" variant="outline">
								Retry
							</Button>
						</div>
					</Alert>
				</CardContent>
			</Card>
		</main>
	);
}

function CookiesSection({
	cookieError,
	displayError,
	isSubmitting,
	newCookies,
	onDelete,
	onDismissSaved,
	onSave,
	profile,
	setDisplayError,
	setNewCookies,
}: {
	cookieError: { message: string } | null;
	displayError: string | null;
	isSubmitting: boolean;
	newCookies: string;
	onDelete: () => void;
	onDismissSaved: () => void;
	onSave: (cookies: string) => void;
	profile: ProfileResult | undefined;
	setDisplayError: (error: string | null) => void;
	setNewCookies: (cookies: string) => void;
}) {
	return (
		<section className="space-y-4">
			<h2 className="font-semibold text-base-content text-sm uppercase tracking-wide">
				Authentication Cookies
			</h2>
			{cookieError && (
				<Alert variant="destructive">
					<AlertCircle className="size-4" />
					<span>{cookieError.message}</span>
				</Alert>
			)}
			{profile?.hasValidCookies ? (
				<Alert className="alert-horizontal">
					<Cookie className="size-4 shrink-0" />
					<span>Authentication cookies are saved.</span>
					<div>
						<Button disabled={isSubmitting} isSoft={true} onClick={onDelete} size="sm" variant="destructive">
							<Trash2 className="size-4" /> Remove
						</Button>
					</div>
				</Alert>
			) : (
				<div className="space-y-4">
					<Alert variant="default">
						<AlertCircle className="size-4" />
						<AlertDescription>
							Connect your Twitter account by adding authentication cookies
						</AlertDescription>
					</Alert>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							onSave(newCookies);
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
							{displayError && <p className="text-error text-sm">{displayError}</p>}
						</div>
						<div className="flex gap-2">
							<Button disabled={isSubmitting} size="sm" type="submit">
								Save cookies
							</Button>
							{profile?.hasValidCookies && (
								<Button
									disabled={isSubmitting}
									onClick={onDismissSaved}
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
	);
}

function VisibilitySection({
	isPublic,
	onToggle,
}: {
	isPublic: boolean;
	onToggle: (status: "public" | "private") => void;
}) {
	return (
		<section className="mb-2">
			<label className="label cursor-pointer gap-2 text-wrap">
				<input
					checked={isPublic}
					className="toggle toggle-sm data-[theme=light]:toggle-neutral data-[theme=dark]:toggle-accent"
					onChange={(event) => onToggle(event.target.checked ? "public" : "private")}
					type="checkbox"
				/>
				<span className="label-text w-full text-left">Make your profile visible to other people</span>
			</label>
		</section>
	);
}

function subscribeToOrigin() {
	return () => {};
}

function ProfileLinkBlock({ username }: { username: string }) {
	const origin = useSyncExternalStore(
		subscribeToOrigin,
		() => window.location.origin,
		() => "",
	);

	return (
		<div className="w-full bg-base-200 p-4">
			<div className="flex items-center">
				<p className="text-base-content/70 text-sm">
					Link to your profile:{" "}
					<Link className="link text-sm" params={{ slug: username }} to="/profile/$slug">
						{`${origin}/profile/${username}`}
					</Link>
				</p>
			</div>
		</div>
	);
}
