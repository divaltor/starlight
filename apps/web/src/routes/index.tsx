import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

function HomeComponent() {
	return (
		<div className="container mx-auto max-w-3xl px-4 py-2">
			<div className="grid gap-6">
				<section className="rounded-lg border p-4">
					<h2 className="mb-2 font-medium">Telegram Mini App</h2>
					<p className="mb-4 text-muted-foreground text-sm">
						Access the Telegram Mini App version of Starlight. When launched
						from Telegram, you'll be automatically redirected to the app.
					</p>
					<div className="space-y-2">
						<Link
							to="/app"
							className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
						>
							Open App
						</Link>
						<p className="text-muted-foreground text-xs">
							💡 In development mode, TMA environment is automatically mocked
						</p>
					</div>
				</section>

				<section className="rounded-lg border p-4">
					<h2 className="mb-2 font-medium">Your saved images</h2>
					<p className="mb-4 text-muted-foreground text-sm">
						Browse your collected Twitter art images with filtering and search
						capabilities.
					</p>
					<div className="space-y-2">
						<Link
							to="/app"
							className="inline-flex items-center justify-center rounded-md bg-secondary px-4 py-2 font-medium text-secondary-foreground text-sm transition-colors hover:bg-secondary/90"
						>
							View Images
						</Link>
					</div>
				</section>
			</div>
		</div>
	);
}
