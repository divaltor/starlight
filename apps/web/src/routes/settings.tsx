import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Cookie, Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { decodeCookies } from "@/lib/utils";
import { useTelegramContext } from "@/providers/TelegramButtonsProvider";
import {
	deleteCookies,
	saveCookies,
	verifyCookies,
} from "@/routes/api/cookies";

export const Route = createFileRoute("/settings")({
	component: RouteComponent,
});

function RouteComponent() {
	const [newCookies, setNewCookies] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [showCookieInput, setShowCookieInput] = useState(false);

	const { rawInitData } = useTelegramContext();
	const queryClient = useQueryClient();

	// Query for cookie status with caching and background validation
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
		staleTime: 10 * 60 * 1000, // 10 minutes - consider data fresh
		gcTime: 30 * 60 * 1000, // 30 minutes - keep in cache
		refetchOnWindowFocus: true, // Validate when user returns to page
		refetchInterval: 5 * 60 * 1000, // Background validation every 5 minutes
		retry: 2,
	});

	// Derive state from query data
	const cookiesStored = cookieStatus?.hasValidCookies ?? false;
	const twitterId = cookieStatus?.twitterId ?? null;

	// Show cookie input if no cookies stored or user explicitly wants to update
	const shouldShowCookieInput = !cookiesStored || showCookieInput;

	// Mutation for saving cookies with optimistic updates
	const saveCookiesMutation = useMutation({
		mutationFn: async (cookiesData: { cookies: string }) => {
			return await saveCookies({
				headers: { Authorization: rawInitData ?? "" },
				data: cookiesData,
			});
		},
		onMutate: async () => {
			// Cancel any outgoing refetches
			await queryClient.cancelQueries({ queryKey: ["cookie-status"] });

			// Return context for rollback
			const previousStatus = queryClient.getQueryData(["cookie-status"]);
			return { previousStatus };
		},
		onSuccess: async (result, _variables, _context) => {
			if (result.error) {
				setError(result.error);
				return;
			}

			// Verify the cookies were saved correctly
			const verifyResult = await verifyCookies({
				headers: { Authorization: rawInitData ?? "" },
			});

			// Update cache with fresh data
			queryClient.setQueryData(["cookie-status"], verifyResult);

			if (verifyResult.hasValidCookies) {
				setShowCookieInput(false);
				setNewCookies("");
				setError(null);
			}
		},
		onError: (_error, _variables, context) => {
			// Rollback on error
			if (context?.previousStatus) {
				queryClient.setQueryData(["cookie-status"], context.previousStatus);
			}
			setError(
				"An error occurred while saving your cookies. Please try again.",
			);
		},
		onSettled: () => {
			// Always refetch to ensure consistency
			queryClient.invalidateQueries({ queryKey: ["cookie-status"] });
		},
	});

	// Mutation for deleting cookies with optimistic updates
	const deleteCookiesMutation = useMutation({
		mutationFn: async () => {
			return await deleteCookies({
				headers: { Authorization: rawInitData ?? "" },
			});
		},
		onMutate: async () => {
			// Cancel any outgoing refetches
			await queryClient.cancelQueries({ queryKey: ["cookie-status"] });

			// Optimistically update to show no cookies
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
				// Rollback on server error
				if (context?.previousStatus) {
					queryClient.setQueryData(["cookie-status"], context.previousStatus);
				}
				setError("Failed to delete cookies. Please try again.");
			}
		},
		onError: (_error, _variables, context) => {
			// Rollback on error
			if (context?.previousStatus) {
				queryClient.setQueryData(["cookie-status"], context.previousStatus);
			}
			setError("An error occurred while deleting cookies. Please try again.");
		},
		onSettled: () => {
			// Always refetch to ensure consistency
			queryClient.invalidateQueries({ queryKey: ["cookie-status"] });
		},
	});

	const handleSaveCookies = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);

		try {
			// Validate cookies using the decodeCookies function from utils
			const decodedCookies = decodeCookies(newCookies);

			if (!decodedCookies || decodedCookies.length === 0) {
				setError(
					"Invalid cookies format. Please check your cookies and try again.",
				);
				return;
			}

			// Check if we have the required cookies
			const requiredCookies = ["auth_token", "ct0", "kdt", "twid"];
			const cookieNames = decodedCookies.map((cookie) => cookie.key);
			const missingCookies = requiredCookies.filter(
				(name) => !cookieNames.includes(name),
			);

			if (missingCookies.length > 0) {
				setError(
					`Missing required cookies: ${missingCookies.join(", ")}. Please ensure you have all necessary Twitter authentication cookies.`,
				);
				return;
			}

			// Convert cookies to base64 for transmission
			const cookiesBase64 = btoa(newCookies);

			// Execute mutation
			saveCookiesMutation.mutate({ cookies: cookiesBase64 });
		} catch {
			setError(
				"An error occurred while processing your cookies. Please try again.",
			);
		}
	};

	const handleDeleteCookies = async () => {
		deleteCookiesMutation.mutate();
	};

	// Show skeleton only on initial load, not on subsequent visits due to caching
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

	// Show error state if query failed
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
									variant="outline"
									size="sm"
									onClick={() => refetchCookieStatus()}
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
		saveCookiesMutation.isPending || deleteCookiesMutation.isPending;

	return (
		<main className="container mx-auto max-w-2xl px-4 py-10">
			<div className="mb-8 flex items-center justify-between">
				<h1 className="font-semibold text-2xl text-gray-900">Settings</h1>
			</div>

			<Card className="border-0 bg-white/50 shadow-md backdrop-blur-sm">
				<CardHeader className="pb-1">
					<CardTitle className="font-medium text-gray-900 text-lg">
						Account
					</CardTitle>
					<CardDescription className="text-gray-500">
						Manage your Twitter authentication and account information
					</CardDescription>
				</CardHeader>

				<CardContent className="space-y-6">
					{/* User Information Section */}
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<span className="font-medium text-gray-700 text-sm">
								Twitter ID
							</span>
							{twitterId && <Badge variant="secondary">Connected</Badge>}
						</div>
						<div className="rounded-lg border-0 bg-gray-50 px-3 py-2">
							<p className="font-mono text-gray-900 text-sm">
								{twitterId || (
									<span className="text-gray-400 italic">Not connected</span>
								)}
							</p>
						</div>
					</div>

					{/* Cookie Management Section */}
					<div className="space-y-4">
						{cookiesStored && !shouldShowCookieInput ? (
							<Alert>
								<AlertTitle className="flex w-full items-center justify-between">
									<span className="flex items-center gap-2">
										<Cookie className="h-4 w-4" />
										Authentication cookies are saved.
									</span>
									<Button
										variant="ghost"
										size="sm"
										onClick={handleDeleteCookies}
										disabled={isSubmitting}
										className="text-red-600 hover:bg-red-50 hover:text-red-700"
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

								<form onSubmit={handleSaveCookies} className="space-y-4">
									<div className="space-y-2">
										<textarea
											id="new-cookies"
											value={newCookies}
											onChange={(e) => {
												setNewCookies(e.target.value);
												if (error) setError(null);
											}}
											className={`min-h-[100px] w-full rounded-lg border bg-white p-3 text-sm transition-colors focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${
												error
													? "border-red-300 focus:border-red-400 focus:ring-red-500/20"
													: "border-gray-200"
											}`}
											placeholder="Required format: auth_token=xxx; ct0=xxx; ..."
											disabled={isSubmitting}
										/>
										{error && (
											<p className="mt-1 text-red-500 text-xs">{error}</p>
										)}
									</div>

									<div className="flex gap-2">
										<Button type="submit" size="sm" disabled={isSubmitting}>
											{saveCookiesMutation.isPending
												? "Connecting..."
												: "Connect Account"}
										</Button>
										{cookiesStored && (
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => setShowCookieInput(false)}
												disabled={isSubmitting}
											>
												Cancel
											</Button>
										)}
									</div>
								</form>
							</div>
						)}
					</div>
				</CardContent>
			</Card>
		</main>
	);
}
