import { Ghost } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";

type ActionConfig = {
	label: string;
	onClick?: () => void;
	href?: string;
	variant?: ComponentProps<typeof Button>["variant"];
};

type NotFoundProps = {
	title?: string;
	description?: string;
	icon?: ReactNode;
	primaryAction?: ActionConfig;
	secondaryAction?: ActionConfig;
	className?: string;
};

export function NotFound({
	title = "Page not found",
	description = "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.",
	icon,
	primaryAction,
	secondaryAction,
	className = "",
}: NotFoundProps) {
	return (
		<div
			className={`flex min-h-screen items-center justify-center p-4 ${className}`}
		>
			<div className="mx-auto max-w-md text-center">
				<div className="mb-6 inline-flex size-20 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800">
					{icon ?? <Ghost className="size-10 text-gray-400" />}
				</div>
				<h1 className="font-semibold text-3xl text-gray-900">{title}</h1>
				{description && <p className="mt-3 text-gray-600">{description}</p>}
				{(primaryAction || secondaryAction) && (
					<div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
						{primaryAction && (
							<Button
								asChild={!!primaryAction.href}
								onClick={primaryAction.onClick}
								variant={primaryAction.variant}
							>
								{primaryAction.href ? (
									<a href={primaryAction.href}>{primaryAction.label}</a>
								) : (
									primaryAction.label
								)}
							</Button>
						)}
						{secondaryAction && (
							<Button
								asChild={!!secondaryAction.href}
								onClick={secondaryAction.onClick}
								variant={secondaryAction.variant ?? "outline"}
							>
								{secondaryAction.href ? (
									<a href={secondaryAction.href}>{secondaryAction.label}</a>
								) : (
									secondaryAction.label
								)}
							</Button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

export default NotFound;
