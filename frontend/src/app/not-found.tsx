import { AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function NotFound() {
	return (
		<div className="min-h-screen bg-gradient-to-br from-background to-secondary/30 p-4 flex items-center justify-center">
			<div className="max-w-2xl w-full space-y-6">
				{/* Header */}
				<div className="text-center space-y-2">
					<div className="flex items-center justify-center gap-2">
						<AlertTriangle className="h-8 w-8 text-destructive" />
						<h1 className="text-3xl font-bold text-foreground">
							Access Restricted
						</h1>
					</div>
					<p className="text-muted-foreground">
						This application must be opened within Telegram
					</p>
				</div>

				{/* Main Error Card */}
				<Card className="shadow-lg border-destructive/20">
					<CardHeader className="text-center">
						<CardTitle className="flex items-center justify-center gap-2 text-destructive">
							<AlertTriangle className="h-5 w-5" />
							Telegram Mini App Only
						</CardTitle>
						<CardDescription>
							This application is designed to work exclusively within the
							Telegram ecosystem
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<Alert variant="destructive">
							<AlertTriangle className="h-4 w-4" />
							<AlertTitle>Unable to Launch</AlertTitle>
							<AlertDescription>
								Launch parameters could not be retrieved. The app was likely
								opened outside of Telegram.
							</AlertDescription>
						</Alert>

						<div className="space-y-4">
							<h3 className="font-medium text-foreground">
								To access this application:
							</h3>
							<ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
								<li>Open Telegram on your device</li>
								<li>Navigate to the bot or channel that hosts this Mini App</li>
								<li>Launch the application from within Telegram</li>
							</ol>
						</div>

						<div className="pt-4">
							<Button
								variant="outline"
								className="w-full flex items-center gap-2"
								onClick={() => window.close()}
							>
								<ExternalLink className="h-4 w-4" />
								Close This Window
							</Button>
						</div>
					</CardContent>
				</Card>

				{/* Info Card */}
				<Card className="shadow-lg border-primary/20">
					<CardContent className="pt-6">
						<div className="text-center space-y-3">
							<h3 className="font-medium text-foreground">
								What are Telegram Mini Apps?
							</h3>
							<p className="text-sm text-muted-foreground">
								Telegram Mini Apps are web applications that run within the
								Telegram environment, providing seamless integration with
								Telegram's features and user authentication.
							</p>
							<Button
								variant="ghost"
								size="sm"
								className="flex items-center gap-2"
								onClick={() =>
									window.open("https://docs.telegram-mini-apps.com/", "_blank")
								}
							>
								<ExternalLink className="h-3 w-3" />
								Learn More
							</Button>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
} 