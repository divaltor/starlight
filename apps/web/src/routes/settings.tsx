import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Cookie, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
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
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [cookiesStored, setCookiesStored] = useState(false);
	const [showCookieInput, setShowCookieInput] = useState(false);
	const [twitterId, setTwitterId] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);

	const { rawInitData } = useTelegramContext();

	// Verify cookies on page load
	useEffect(() => {
		const checkCookieStatus = async () => {
			try {
				const result = await verifyCookies({
					headers: { Authorization: rawInitData ?? "" },
				});

				if (result.hasValidCookies && result.twitterId) {
					setCookiesStored(true);
					setTwitterId(result.twitterId);
					setShowCookieInput(false);
				} else {
					setCookiesStored(false);
					setTwitterId(null);
					setShowCookieInput(true);
				}
			} catch (error) {
				console.error("Error checking cookie status:", error);
				setCookiesStored(false);
				setTwitterId(null);
				setShowCookieInput(true);
			} finally {
				setIsLoading(false);
			}
		};

		checkCookieStatus();
	}, [rawInitData]);

	// Back button is now handled globally by TelegramButtonsProvider
	// No need for manual button setup here

	const handleSaveCookies = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setIsSubmitting(true);
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

			// Call the save cookies API with proper authorization
			const result = await saveCookies({
				headers: { Authorization: rawInitData ?? "" },
				data: {
					cookies: cookiesBase64,
				},
			});

			if (result.error) {
				setError(result.error);
				return;
			}

			// Success - verify cookies were saved by checking server status
			const verifyResult = await verifyCookies({
				headers: { Authorization: rawInitData ?? "" },
			});
			if (verifyResult.hasValidCookies && verifyResult.twitterId) {
				setCookiesStored(true);
				setShowCookieInput(false);
				setNewCookies("");
				setTwitterId(verifyResult.twitterId);
			}
		} catch (error) {
			console.error("Error submitting cookies:", error);
			setError(
				"An error occurred while saving your cookies. Please try again.",
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleDeleteCookies = async () => {
		try {
			setIsSubmitting(true);

			const result = await deleteCookies({
				headers: { Authorization: rawInitData ?? "" },
			});

			if (result.success) {
				setCookiesStored(false);
				setTwitterId(null);
				setShowCookieInput(true);
			} else {
				setError("Failed to delete cookies. Please try again.");
			}
		} catch (error) {
			console.error("Error deleting cookies:", error);
			setError("An error occurred while deleting cookies. Please try again.");
		} finally {
			setIsSubmitting(false);
		}
	};

	if (isLoading) {
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
						{cookiesStored && !showCookieInput ? (
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
											{isSubmitting ? "Connecting..." : "Connect Account"}
										</Button>
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
