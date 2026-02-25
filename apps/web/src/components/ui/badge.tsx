import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
	"badge", // DaisyUI base
	{
		variants: {
			variant: {
				default: "badge-primary",
				accent: "badge-accent",
				secondary: "badge-secondary",
				destructive: "badge-error",
				outline: "badge-outline",
				waiting: "badge-warning",
				published: "badge-info",
				done: "badge-success",
			},
			size: {
				default: "badge-md",
				xs: "badge-xs",
				sm: "badge-sm",
				lg: "badge-lg",
				xl: "badge-xl",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface BadgeProps
	extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
	return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
