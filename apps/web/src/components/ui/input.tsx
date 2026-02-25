import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Input as AriaInput } from "react-aria-components";

import { cn } from "@/lib/utils";

const inputVariants = cva(
	"input transition-shadow duration-200 ease-in-out focus:ring-2 focus:ring-blue-500/20",
	{
		variants: {
			variant: {
				default: "",
				ghost: "input-ghost",
				bordered: "",
			},
			color: {
				default: "",
				primary: "input-primary",
				secondary: "input-secondary",
				accent: "input-accent",
				info: "input-info",
				success: "input-success",
				warning: "input-warning",
				error: "input-error",
			},
			size: {
				default: "input-md",
				xs: "input-xs",
				sm: "input-sm",
				md: "input-md",
				lg: "input-lg",
				xl: "input-xl",
			},
		},
		defaultVariants: {
			variant: "default",
			color: "default",
			size: "default",
		},
	},
);

interface InputProps
	extends
		Omit<React.ComponentProps<typeof AriaInput>, "className" | "color" | "size">,
		VariantProps<typeof inputVariants> {
	className?: string;
}

function Input({ className, variant, color, size, ...props }: InputProps) {
	const classes = cn(
		inputVariants({
			variant,
			color,
			size,
			className,
		}),
	);

	return <AriaInput {...props} className={classes} />;
}

Input.displayName = "Input";

export { Input, inputVariants };
