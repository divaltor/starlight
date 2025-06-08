"use client";

import { Page } from "apps/web/src-bak/components/Page";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "apps/web/src-bak/components/ui/alert";
import { Button } from "apps/web/src-bak/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "apps/web/src-bak/components/ui/card";
import { AlertTriangle } from "lucide-react";

export default function NotFound() {
	return (
		<Page back={true}>
			<div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-background to-secondary/30 p-4">
				<div className="w-full max-w-md">
					<Card className="border-primary/20 shadow-lg">
						<CardHeader className="text-center">
							<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
								<AlertTriangle className="h-8 w-8 text-destructive" />
							</div>
							<CardTitle className="text-2xl">404 - Page Not Found</CardTitle>
							<CardDescription>
								The page you&apos;re looking for doesn&apos;t exist or has been
								moved.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4 text-center">
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
