import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import type { Ref, RefObject } from "react";
import { useButton } from "react-aria/useButton";
import type { AriaButtonOptions } from "react-aria/useButton";

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
	type = "button",
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		ref?: Ref<HTMLButtonElement>;
	}) {
	const options = { ...props } as AriaButtonOptions<"button">;
	const {
		buttonProps: { id, ...buttonProps },
		isPressed,
	} = useButton(options, ref as RefObject<HTMLButtonElement | null>);

	const classes = cn(
		buttonVariants({
			variant,
			size,
			pressed: isPressed,
			isSoft,
			className,
		}),
		isPressed ? "scale-98" : "scale-100",
	);

	return (
		<button
			{...buttonProps}
			className={classes}
			data-pressed={isPressed || undefined}
			id={id}
			ref={ref}
			type="button"
			// Consumers may override the default type (e.g. type="submit" in forms).
			{...(type === "button" ? {} : { type })}
		>
			{children}
		</button>
	);
}

Button.displayName = "Button";

export { Button, buttonVariants };
