import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "motion/react";
import type * as React from "react";
import type { Ref } from "react";
import { useButton } from "react-aria";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"btn", // DaisyUI base
	{
		variants: {
			variant: {
				default: "btn-primary",
				destructive: "btn-error",
				outline: "btn-outline",
				secondary: "btn-secondary",
				ghost: "btn-ghost",
				link: "btn-link",
			},
			size: {
				default: "btn-md",
				sm: "btn-sm",
				lg: "btn-lg",
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
	}
);

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
		})
	);

	return (
		<motion.button
			{...(buttonProps as any)}
			animate={{
				scale: isPressed ? 0.98 : 1,
			}}
			className={classes}
			data-pressed={isPressed || undefined}
			id={id}
			ref={ref}
			transition={{
				duration: 0.1,
				ease: "easeInOut",
			}}
		>
			{children}
		</motion.button>
	);
}

Button.displayName = "Button";

export { Button, buttonVariants };
