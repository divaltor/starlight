import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const alertVariants = cva(
	"alert",
	{
		variants: {
			variant: {
				default: "",
				destructive: "alert-error",
				amber: "alert-warning",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

function Alert({
	className,
	variant,
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
	return (
		<div
			className={cn(alertVariants({ variant }), className)}
			role="alert"
			{...props}
		/>
	);
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"font-medium tracking-tight",
				className
			)}
			{...props}
		/>
	);
}

function AlertDescription({
	className,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"text-sm",
				className
			)}
			{...props}
		/>
	);
}

export { Alert, AlertTitle, AlertDescription };