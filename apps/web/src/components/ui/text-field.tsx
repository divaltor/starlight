import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import {
	TextField as AriaTextField,
	FieldError,
	Label,
	Text,
	TextArea,
} from "react-aria-components";

import { cn } from "@/lib/utils";
import { Input } from "./input";

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
	className?: string;
	description?: string;
	inputRef?: React.Ref<HTMLInputElement | HTMLTextAreaElement>;
	label?: string;
	multiline?: boolean;
	placeholder?: string;
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
				<TextArea
					className={cn(
						"textarea w-full transition-shadow duration-200 ease-in-out focus:ring-2 focus:ring-blue-500/20",
						size === "default" || !size ? "textarea-md" : `textarea-${size}`,
						className
					)}
					placeholder={placeholder}
					ref={inputRef as React.Ref<HTMLTextAreaElement>}
				/>
			) : (
				<Input
					placeholder={placeholder}
					ref={inputRef as React.Ref<HTMLInputElement>}
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
