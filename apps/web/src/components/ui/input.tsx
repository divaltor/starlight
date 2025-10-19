import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "motion/react";
import type * as React from "react";
import type { Ref } from "react";
import { Input as AriaInput } from "react-aria-components";

import { cn } from "@/lib/utils";

const MotionInput = motion.create(AriaInput);

const inputVariants = cva("input", {
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
});

interface InputProps
	extends Omit<
			React.ComponentProps<typeof AriaInput>,
			"className" | "color" | "size"
		>,
		VariantProps<typeof inputVariants> {
	className?: string;
	ref?: Ref<HTMLInputElement>;
}

function Input({ className, variant, color, size, ref, ...props }: InputProps) {
	const classes = cn(
		inputVariants({
			variant,
			color,
			size,
			className,
		})
	);

	return (
		<MotionInput
			{...props}
			className={classes}
			ref={ref}
			transition={{
				duration: 0.2,
				ease: "easeInOut",
			}}
			whileFocus={{
				boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.2)",
			}}
		/>
	);
}

Input.displayName = "Input";

export { Input, inputVariants };
