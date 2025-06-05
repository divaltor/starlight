"use client";

import { Page } from "@/components/Page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";

export default function NotFound() {
	return (
		<Page back={true}>
			<div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
				<div className="max-w-md w-full">
					<Card className="shadow-lg border-primary/20">
						<CardHeader className="text-center">
							<div className="mx-auto mb-4 h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
								<AlertTriangle className="h-8 w-8 text-destructive" />
							</div>
							<CardTitle className="text-2xl">404 - Page Not Found</CardTitle>
							<CardDescription>
								The page you&apos;re looking for doesn&apos;t exist or has been
								moved.
							</CardDescription>
						</CardHeader>
						<CardContent className="text-center space-y-4">
							<Alert>
								<AlertTriangle className="h-4 w-4" />
								<AlertTitle>Oops!</AlertTitle>
								<AlertDescription>
									We couldn&apos;t find what you were looking for.
								</AlertDescription>
							</Alert>
							<Button
								onClick={() => window.history.back()}
								className="w-full"
								variant="default"
							>
								Go Back
							</Button>
						</CardContent>
					</Card>
				</div>
			</div>
		</Page>
	);
}
