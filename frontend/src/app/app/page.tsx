"use client";

import { Link } from "@/components/Link/Link";
import { Page } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ImageIcon, Search, Settings } from "lucide-react";
import { useEffect, useState } from "react";

export default function AppPage() {
	const [searchQuery, setSearchQuery] = useState("");
	const [hasCookies, setHasCookies] = useState(false);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		const checkCookiesAndUser = async () => {
			try {
				setIsLoading(true);

				let cookiesFound = false;

				if (typeof window !== "undefined" && window.localStorage) {
					try {
						const localCookies = window.localStorage.getItem("user_cookies");
						cookiesFound = !!localCookies;
					} catch (error) {
						console.error("Error checking cookies:", error);
					}
				}

				setHasCookies(cookiesFound);
				setIsLoading(false);
			} catch (error) {
				console.error("Error initializing app:", error);
				setIsLoading(false);
			}
		};

		checkCookiesAndUser();
	}, []);

	const handleEraseCookies = async () => {
		try {
			if (typeof window !== "undefined" && window.localStorage) {
				window.localStorage.removeItem("user_cookies");
			}

			setHasCookies(false);
		} catch (error) {
			console.error("Failed to erase cookies:", error);
		}
	};

	if (isLoading) {
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
									<Link href={{ href: "/cookies", query: { back: true } }}>
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
