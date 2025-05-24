"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTelegramApp } from "@/hooks/useTelegramApp";
import {
	Search,
	ImageIcon,
	User,
	Settings,
	LogOut,
	Plus,
	Images,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Link } from "@/components/Link/Link";
import { Page } from "@/components/Page";

// Extend Window interface for Telegram WebApp
declare global {
	interface Window {
		Telegram?: {
			WebApp?: {
				CloudStorage?: {
					getItem: (
						key: string,
						callback: (error: Error | null, value: string | null) => void,
					) => void;
					setItem: (key: string, value: string) => void;
				};
				initDataUnsafe?: {
					user?: {
						id: number;
						first_name: string;
						last_name?: string;
						username?: string;
					};
				};
			};
		};
	}
}

export default function AppPage() {
	const router = useRouter();
	const isTelegramApp = useTelegramApp(true); // Enable validation with redirect
	const [searchQuery, setSearchQuery] = useState("");
	const [hasCookies, setHasCookies] = useState(false);
	const [isLoading, setIsLoading] = useState(true);
	const [userInfo, setUserInfo] = useState<{
		id: number;
		name: string;
		username?: string;
	} | null>(null);

	// Check for cookies and user info on component mount
	useEffect(() => {
		const checkCookiesAndUser = async () => {
			try {
				setIsLoading(true);

				// Get user info from Telegram
				if (
					typeof window !== "undefined" &&
					window.Telegram?.WebApp?.initDataUnsafe?.user
				) {
					const user = window.Telegram.WebApp.initDataUnsafe.user;
					setUserInfo({
						id: user.id,
						name: `${user.first_name}${user.last_name ? ` ${user.last_name}` : ""}`,
						username: user.username,
					});
				}

				// Check for cookies in storage
				let cookiesFound = false;

				// Check cloud storage first
				if (
					typeof window !== "undefined" &&
					window.Telegram?.WebApp?.CloudStorage
				) {
					try {
						window.Telegram.WebApp.CloudStorage.getItem(
							"user_cookies",
							(error, value) => {
								if (!error && value) {
									cookiesFound = true;
								}
								setHasCookies(cookiesFound);
								setIsLoading(false);
							},
						);
						return;
					} catch (error) {
						// Fall through to localStorage check
					}
				}

				// Check localStorage as fallback
				if (typeof window !== "undefined" && window.localStorage) {
					try {
						const localCookies = window.localStorage.getItem("user_cookies");
						cookiesFound = !!localCookies;
					} catch (error) {
						// localStorage not available
					}
				}

				setHasCookies(cookiesFound);
				setIsLoading(false);
			} catch (error) {
				console.error("Error initializing app:", error);
				setIsLoading(false);
			}
		};

		// Only initialize if we're in Telegram
		if (isTelegramApp) {
			checkCookiesAndUser();
		}
	}, [isTelegramApp]);

	const handleEraseCookies = async () => {
		try {
			// Clear from cloud storage
			if (
				typeof window !== "undefined" &&
				window.Telegram?.WebApp?.CloudStorage
			) {
				window.Telegram.WebApp.CloudStorage.getItem(
					"user_cookies",
					(error, value) => {
						if (!error && value) {
							// Note: CloudStorage doesn't have removeItem, so we set empty value
							// This would need to be handled by the backend
						}
					},
				);
			}

			// Clear from localStorage
			if (typeof window !== "undefined" && window.localStorage) {
				window.localStorage.removeItem("user_cookies");
			}

			setHasCookies(false);
		} catch (error) {
			console.error("Failed to erase cookies:", error);
		}
	};

	if (isLoading || !isTelegramApp) {
		return (
			<div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
				<div className="max-w-4xl w-full space-y-6">
					<div className="text-center py-12">
						<div className="animate-pulse">
							<ImageIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
							<p className="text-muted-foreground">Loading...</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<Page back={false}>
			<div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
				<div className="max-w-4xl w-full space-y-6">
					{/* Search Bar */}
					<Card className="shadow-lg border-primary/20">
						<CardContent className="p-3">
							<div className="relative">
								<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
								<Input
									placeholder="Search photos... (coming soon)"
									value={searchQuery}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setSearchQuery(e.target.value)
									}
									className="pl-10 h-9"
									disabled
								/>
							</div>
						</CardContent>
					</Card>

					{/* Gallery Section */}
					<Card className="shadow-lg border-primary/20">
						<CardContent className="pt-6">
							{/* Empty State */}
							<div className="text-center py-12 border-2 border-dashed border-muted rounded-lg">
								<ImageIcon className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
								<h3 className="text-lg font-medium text-foreground mb-2">
									No Photos Yet
								</h3>
								<p className="text-muted-foreground mb-6">
									Your photo gallery is empty. Connect your Twitter account to
									start viewing photos.
								</p>
								{!hasCookies && (
									<Link href="/cookies">
										<Button
											size="lg"
											className="flex items-center gap-2 mx-auto"
										>
											<Settings className="h-4 w-4" />
											Setup Integration
										</Button>
									</Link>
								)}
							</div>
						</CardContent>
					</Card>
				</div>
			</div>
		</Page>
	);
} 