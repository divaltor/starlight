import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import type { Ref } from "react";
import { useButton } from "react-aria";

import { cn } from "@/lib/utils";

const buttonVariants = cva("btn transition-all duration-150 ease-in-out", {
	variants: {
		variant: {
			default: "btn-primary",
			destructive: "btn-error",
			outline: "btn-outline",
			secondary: "btn-secondary",
			ghost: "btn-ghost",
			link: "btn-link",
			accent: "btn-accent",
			neutral: "btn-neutral",
			active: "btn-active",
		},
		size: {
			default: "btn-md",
			sm: "btn-sm",
			lg: "btn-lg",
			xs: "btn-xs",
			xl: "btn-xl",
			icon: "btn-circle size-9",
		},
		pressed: {
			true: "btn-active",
		},
		isSoft: {
			true: "btn-soft",
		},
	},
	defaultVariants: {
		variant: "default",
		size: "default",
	},
});

function Button({
	className,
	variant,
	size,
	isSoft,
	ref,
	children,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		ref?: Ref<HTMLButtonElement>;
	}) {
	const options = { ...props } as any;
	const {
		buttonProps: { id, ...buttonProps },
		isPressed,
	} = useButton(options, ref as any);

	const classes = cn(
		buttonVariants({
			variant,
			size,
			pressed: isPressed,
			isSoft,
			className,
		}),
		isPressed ? "scale-98" : "scale-100"
	);

	return (
		<button
			{...(buttonProps as any)}
			className={classes}
			data-pressed={isPressed || undefined}
			id={id}
			ref={ref}
		>
			{children}
		</button>
	);
}

Button.displayName = "Button";

export { Button, buttonVariants };
