import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "motion/react";
import type * as React from "react";
import type { Ref } from "react";
import {
	TextField as AriaTextField,
	FieldError,
	Label,
	Text,
	TextArea,
} from "react-aria-components";

import { cn } from "@/lib/utils";
import { Input } from "./input";

const MotionTextArea = motion.create(TextArea);

const textFieldVariants = cva("form-control", {
	variants: {
		size: {
			default: "",
			xs: "text-xs",
			sm: "text-sm",
			md: "text-base",
			lg: "text-lg",
			xl: "text-xl",
		},
	},
	defaultVariants: {
		size: "default",
	},
});

interface TextFieldProps
	extends Omit<React.ComponentProps<typeof AriaTextField>, "className">,
		VariantProps<typeof textFieldVariants> {
	label?: string;
	description?: string;
	placeholder?: string;
	className?: string;
	inputRef?: Ref<HTMLInputElement | HTMLTextAreaElement>;
	multiline?: boolean;
}

function TextField({
	label,
	description,
	placeholder,
	className,
	size,
	inputRef,
	multiline,
	...props
}: TextFieldProps) {
	const classes = cn(
		textFieldVariants({
			size,
			className,
		})
	);

	return (
		<AriaTextField {...props} className={classes}>
			{label && (
				<Label className="label">
					<span className="label-text">{label}</span>
				</Label>
			)}
			{multiline ? (
				<MotionTextArea
					className={cn(
						"textarea w-full",
						size === "default" || !size ? "textarea-md" : `textarea-${size}`,
						className
					)}
					placeholder={placeholder}
					ref={inputRef as Ref<HTMLTextAreaElement>}
					transition={{
						duration: 0.2,
						ease: "easeInOut",
					}}
					whileFocus={{
						boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.2)",
					}}
				/>
			) : (
				<Input
					placeholder={placeholder}
					ref={inputRef as Ref<HTMLInputElement>}
					size={size === "default" || !size ? "md" : size}
				/>
			)}
			{description && (
				<Text className="label" slot="description">
					<span className="label-text-alt">{description}</span>
				</Text>
			)}
			<FieldError>
				{({ validationErrors }) => (
					<div className="label">
						<span className="label-text-alt text-error">
							{validationErrors.join(" ")}
						</span>
					</div>
				)}
			</FieldError>
		</AriaTextField>
	);
}

TextField.displayName = "TextField";

export { TextField, textFieldVariants };
