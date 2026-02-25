import { Ghost } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface ActionConfig {
	href?: string;
	label: string;
	onClick?: () => void;
	onMouseEnter?: () => void;
	variant?: ComponentProps<typeof Button>["variant"];
}

interface NotFoundProps {
	className?: string;
	description?: string;
	icon?: ReactNode;
	primaryAction?: ActionConfig;
	secondaryAction?: ActionConfig;
	title?: string;
}

export function NotFound({
	title = "Page not found",
	description = "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.",
	icon,
	primaryAction,
	secondaryAction,
	className = "",
}: NotFoundProps) {
	return (
		<div className={`flex h-full items-center justify-center p-4 ${className}`}>
			<div className="mx-auto max-w-lg text-center">
				<div className="mb-6 inline-flex size-20 items-center justify-center rounded-full bg-base-200">
					{icon ?? <Ghost className="size-10 text-base-content/20" />}
				</div>
				<h1 className="font-semibold text-3xl text-base-content">{title}</h1>
				{description && <p className="mt-3 text-base-content/60">{description}</p>}
				{(primaryAction || secondaryAction) && (
					<div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
						{primaryAction && (
							<Button
								onClick={primaryAction.onClick}
								onMouseEnter={primaryAction.onMouseEnter}
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
								onClick={secondaryAction.onClick}
								onMouseEnter={secondaryAction.onMouseEnter}
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
