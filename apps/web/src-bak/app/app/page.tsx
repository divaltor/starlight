"use client";

import { Link } from "apps/web/src-bak/components/Link/Link";
import { Page } from "apps/web/src-bak/components/Page";
import { Button } from "apps/web/src-bak/components/ui/button";
import { Card, CardContent } from "apps/web/src-bak/components/ui/card";
import { Input } from "apps/web/src-bak/components/ui/input";
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
			<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30 p-4">
				<div className="w-full max-w-4xl space-y-6">
					<div className="py-12 text-center">
						<div className="animate-pulse">
							<ImageIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
							<p className="text-muted-foreground">Loading...</p>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<Page back={false}>
			<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30 p-4">
				<div className="w-full max-w-4xl space-y-6">
					{/* Search Bar */}
					<Card className="border-primary/20 shadow-lg">
						<CardContent className="p-3">
							<div className="relative">
								<Search className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 transform text-muted-foreground" />
								<Input
									placeholder="Search photos... (coming soon)"
									value={searchQuery}
									onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
										setSearchQuery(e.target.value)
									}
									className="h-9 pl-10"
									disabled
								/>
							</div>
						</CardContent>
					</Card>

					{/* Gallery Section */}
					<Card className="border-primary/20 shadow-lg">
						<CardContent className="pt-6">
							{/* Empty State */}
							<div className="rounded-lg border-2 border-muted border-dashed py-12 text-center">
								<ImageIcon className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
								<h3 className="mb-2 font-medium text-foreground text-lg">
									No Photos Yet
								</h3>
								<p className="mb-6 text-muted-foreground">
									Your photo gallery is empty. Connect your Twitter account to
									start viewing photos.
								</p>
								{!hasCookies && (
									<Link href={{ href: "/cookies", query: { back: true } }}>
										<Button
											size="lg"
											className="mx-auto flex items-center gap-2"
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
