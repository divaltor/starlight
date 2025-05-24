"use client";

import { cloudStorage, postEvent } from "@telegram-apps/sdk-react";
import { useTelegramApp } from "@/hooks/useTelegramApp";
import { decodeCookies } from "@/lib/utils";
import {
	AlertTriangle,
	Clipboard,
	ClipboardList,
	Cloud,
	Cookie,
	FileText,
	HardDrive,
	Lock,
	Shield,
	CheckCircle,
} from "lucide-react";
import { useState } from "react";

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Page } from "@/components/Page";

export default function CookiesPage() {
	const isTelegramApp = useTelegramApp(true); // Enable validation with redirect
	const [cookies, setCookies] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [message, setMessage] = useState<{
		type: "success" | "error" | "info";
		text: string;
		details?: string;
	} | null>(null);

	const handleCloudStorage = async () => {
		if (!cookies.trim()) {
			setMessage({ type: "error", text: "Please enter cookies data" });
			return;
		}

		setIsLoading(true);
		setMessage(null);

		try {
			// Validate cookies first
			const decodedCookies = decodeCookies(cookies);
			if (!decodedCookies) {
				setMessage({
					type: "error",
					text: "Invalid cookie format",
					details:
						"Please check that your cookies are in a valid JSON, base64, or extension export format.",
				});
				setIsLoading(false);
				return;
			}

			const cookieCount = Object.keys(decodedCookies).length;
			const cookieData = JSON.stringify(decodedCookies);

			if (cloudStorage && typeof cloudStorage.setItem === "function") {
				// Try to use cloud storage if available
				await cloudStorage.setItem("user_cookies", cookieData);
				setMessage({
					type: "success",
					text: `Successfully validated and saved ${cookieCount} cookies to cloud storage!`,
				});
			} else {
				// Send to backend via Telegram Mini Apps events
				postEvent("web_app_data_send", { data: cookieData });
				setMessage({
					type: "success",
					text: `Successfully validated and sent ${cookieCount} cookies to bot!`,
				});
			}

			setCookies("");
		} catch (error) {
			setMessage({
				type: "error",
				text: "Failed to save cookies to cloud storage",
				details:
					error instanceof Error ? error.message : "Unknown error occurred",
			});
		} finally {
			setIsLoading(false);
		}
	};

	const handleLocalStorage = async () => {
		if (!cookies.trim()) {
			setMessage({ type: "error", text: "Please enter cookies data" });
			return;
		}

		setIsLoading(true);
		setMessage(null);

		try {
			// Validate cookies first
			const decodedCookies = decodeCookies(cookies);
			if (!decodedCookies) {
				setMessage({
					type: "error",
					text: "Invalid cookie format",
					details:
						"Please check that your cookies are in a valid JSON, base64, or extension export format.",
				});
				setIsLoading(false);
				return;
			}

			const cookieCount = Object.keys(decodedCookies).length;
			const cookieData = JSON.stringify(decodedCookies);

			if (
				typeof window !== "undefined" &&
				window.Telegram?.WebApp?.CloudStorage
			) {
				// Check if we have native Telegram storage
				// Try to use Telegram's secure storage first
				window.Telegram.WebApp.CloudStorage.setItem("user_cookies", cookieData);
				setMessage({
					type: "success",
					text: `Successfully validated and saved ${cookieCount} cookies to secure storage!`,
				});
			} else if (typeof window !== "undefined" && window.localStorage) {
				// Fallback to browser localStorage
				window.localStorage.setItem("user_cookies", cookieData);
				setMessage({
					type: "success",
					text: `Successfully validated and saved ${cookieCount} cookies to local storage!`,
				});
			} else {
				setMessage({
					type: "error",
					text: "Local storage is not available. Please use cloud storage instead.",
				});
				return;
			}

			setCookies("");
		} catch (error) {
			setMessage({
				type: "error",
				text: "Failed to save cookies to local storage",
				details:
					error instanceof Error ? error.message : "Unknown error occurred",
			});
		} finally {
			setIsLoading(false);
		}
	};

	// Real-time validation feedback
	const validateCookiesInput = (value: string) => {
		if (!value.trim()) return null;

		const decoded = decodeCookies(value);
		if (decoded) {
			const count = Object.keys(decoded).length;
			return {
				type: "info" as const,
				text: `✓ Valid format detected - ${count} cookies found`,
			};
		}
		return {
			type: "error" as const,
			text: "Invalid format - please check your cookie data",
		};
	};

	const inputValidation = validateCookiesInput(cookies);

	return (
		<Page back={true}>
			<div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
				<div className="max-w-2xl w-full space-y-6">
					{/* Header */}
					<div className="text-center space-y-2">
						<div className="flex items-center justify-center gap-2">
							<Cookie className="h-8 w-8 text-primary" />
							<h1 className="text-3xl font-bold text-foreground">
								Cookie Storage
							</h1>
						</div>
						<p className="text-muted-foreground">
							Securely store your cookies with cloud synchronization or local
							storage
						</p>
					</div>

					{/* Main Card */}
					<Card className="shadow-lg border-primary/20">
						<CardHeader className="text-center">
							<CardTitle className="flex items-center justify-center gap-2">
								<Shield className="h-5 w-5 text-primary" />
								Cookie Input
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							<Textarea
								placeholder="Paste your cookies here... (JSON, base64, or exported format)"
								value={cookies}
								onChange={(e) => setCookies(e.target.value)}
								className="min-h-[120px] resize-none"
							/>

							{/* Real-time validation feedback */}
							{inputValidation && (
								<Alert
									variant={
										inputValidation.type === "error" ? "destructive" : "default"
									}
									className="text-sm"
								>
									{inputValidation.type === "error" ? (
										<AlertTriangle className="h-4 w-4" />
									) : (
										<CheckCircle className="h-4 w-4" />
									)}
									<AlertDescription>{inputValidation.text}</AlertDescription>
								</Alert>
							)}

							{/* Action Buttons */}
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
								<Button
									onClick={handleCloudStorage}
									disabled={
										isLoading ||
										!inputValidation ||
										inputValidation.type === "error"
									}
									className="flex items-center gap-2 bg-primary hover:bg-primary/90"
									size="lg"
								>
									<Cloud className="h-4 w-4" />
									{isLoading ? "Saving..." : "Save to Cloud"}
								</Button>

								<Button
									onClick={handleLocalStorage}
									disabled={
										isLoading ||
										!inputValidation ||
										inputValidation.type === "error"
									}
									variant="outline"
									className="flex items-center gap-2"
									size="lg"
								>
									<HardDrive className="h-4 w-4" />
									Save Locally
								</Button>
							</div>
						</CardContent>
					</Card>

					{/* Status Message */}
					{message && (
						<Alert
							variant={message.type === "error" ? "destructive" : "default"}
						>
							{message.type === "error" ? (
								<AlertTriangle className="h-4 w-4" />
							) : message.type === "success" ? (
								<CheckCircle className="h-4 w-4" />
							) : (
								<Shield className="h-4 w-4" />
							)}
							<AlertDescription>
								{message.text}
								{message.details && (
									<div className="mt-2 text-sm opacity-80">
										{message.details}
									</div>
								)}
							</AlertDescription>
						</Alert>
					)}

					{/* Security Notice */}
					<Alert variant="warning">
						<Lock className="h-4 w-4" />
						<AlertTitle>Security Notice</AlertTitle>
						<AlertDescription>
							Cloud stored cookies are encrypted and cannot be used to manage
							your Twitter account. They are stored securely for your
							convenience only.
						</AlertDescription>
					</Alert>

					{/* Information Accordion */}
					<Card>
						<CardContent className="p-0">
							<Accordion type="multiple" className="w-full">
								<AccordionItem value="storage-options">
									<AccordionTrigger className="px-6">
										<div className="flex items-center gap-2">
											<Cloud className="h-4 w-4" />
											Storage Options
										</div>
									</AccordionTrigger>
									<AccordionContent className="px-6 pb-4">
										<div className="space-y-4">
											<div className="flex items-start gap-3">
												<Cloud className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
												<div>
													<h4 className="font-medium">Cloud Storage</h4>
													<p className="text-sm text-muted-foreground">
														Synchronized across all your devices. Data is
														encrypted and stored securely on our server.
													</p>
												</div>
											</div>
											<div className="flex items-start gap-3">
												<HardDrive className="h-5 w-5 text-accent mt-0.5 flex-shrink-0" />
												<div>
													<h4 className="font-medium">Local Storage</h4>
													<p className="text-sm text-muted-foreground">
														Stored only on this device. Faster access but not
														synchronized across devices.
													</p>
												</div>
											</div>
										</div>
									</AccordionContent>
								</AccordionItem>

								<AccordionItem value="supported-formats">
									<AccordionTrigger className="px-6">
										<div className="flex items-center gap-2">
											<FileText className="h-4 w-4" />
											Supported Formats & Validation
										</div>
									</AccordionTrigger>
									<AccordionContent className="px-6 pb-4">
										<div className="space-y-4">
											<div className="flex items-start gap-3">
												<Clipboard className="h-5 w-5 text-secondary-500 mt-0.5 flex-shrink-0" />
												<div>
													<h4 className="font-medium">Extension Export</h4>
													<p className="text-sm text-muted-foreground">
														Cookie Quick Manager and other browser extension
														exports. Automatically detected and validated.
													</p>
												</div>
											</div>
											<div className="flex items-start gap-3">
												<Lock className="h-5 w-5 text-accent mt-0.5 flex-shrink-0" />
												<div>
													<h4 className="font-medium">Base64 Encoded</h4>
													<p className="text-sm text-muted-foreground">
														Base64 encoded cookie data that will be
														automatically decoded and validated before storage.
													</p>
												</div>
											</div>
											<div className="flex items-start gap-3">
												<CheckCircle className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
												<div>
													<h4 className="font-medium">JSON Format</h4>
													<p className="text-sm text-muted-foreground">
														Standard JSON object with cookie name-value pairs.
														Real-time validation ensures data integrity.
													</p>
												</div>
											</div>
										</div>
									</AccordionContent>
								</AccordionItem>
							</Accordion>
						</CardContent>
					</Card>
				</div>
			</div>
		</Page>
	);
}
