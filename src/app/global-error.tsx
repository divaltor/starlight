"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect } from "react";

interface GlobalErrorProps {
	error: Error & { digest?: string };
	reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
	useEffect(() => {
		console.error("Global error:", error);
	}, [error]);

	return (
		<html lang="en">
			<body>
				<div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
					<div className="max-w-md w-full">
						<Card className="shadow-lg border-destructive/20">
							<CardHeader className="text-center">
								<div className="mx-auto mb-4 h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
									<AlertTriangle className="h-8 w-8 text-destructive" />
								</div>
								<CardTitle className="text-2xl">Something went wrong</CardTitle>
								<CardDescription>
									An unexpected error occurred while loading the application.
								</CardDescription>
							</CardHeader>
							<CardContent className="text-center space-y-4">
								<Alert variant="destructive">
									<AlertTriangle className="h-4 w-4" />
									<AlertTitle>Error Details</AlertTitle>
									<AlertDescription>
										{error.message || "An unknown error occurred"}
									</AlertDescription>
								</Alert>
								<div className="flex flex-col gap-2">
									<Button onClick={reset} className="w-full" variant="default">
										<RefreshCw className="h-4 w-4 mr-2" />
										Try Again
									</Button>
									<Button
										onClick={() => window.location.reload()}
										className="w-full"
										variant="outline"
									>
										Reload Page
									</Button>
								</div>
							</CardContent>
						</Card>
					</div>
				</div>
			</body>
		</html>
	);
}
