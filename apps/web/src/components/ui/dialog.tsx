import { X } from "lucide-react";
import type * as React from "react";
import type { DialogProps } from "react-aria-components";
import {
	Button as AriaButton,
	Dialog as AriaDialog,
	DialogTrigger as AriaDialogTrigger,
	Modal as AriaModal,
	Heading,
} from "react-aria-components";
import { cn } from "@/lib/utils";

interface DialogContentProps
	extends Omit<React.ComponentProps<typeof AriaDialog>, "children"> {
	children?: React.ReactNode | ((props: DialogProps) => React.ReactNode);
	className?: string;
	showCloseButton?: boolean;
}

function DialogTrigger({
	children,
	...props
}: React.ComponentProps<typeof AriaDialogTrigger>) {
	return <AriaDialogTrigger {...props}>{children}</AriaDialogTrigger>;
}

function DialogContent({
	className,
	children,
	showCloseButton = true,
	...props
}: DialogContentProps) {
	return (
		<AriaModal
			className={cn(
				"data-state-closed:fade-out-0 data-state-closed:slide-out-to-top-2 data-state-open:fade-in-0 data-state-open:slide-in-from-top-2 fixed inset-0 z-50 bg-black/30 backdrop-blur-sm data-state-closed:animate-out data-state-open:animate-in",
				className
			)}
		>
			<AriaDialog
				{...props}
				className={cn(
					"data-state-closed:fade-out-0 data-state-closed:slide-out-to-top-2 data-state-closed:zoom-out-95 data-state-open:fade-in-0 data-state-open:slide-in-from-top-2 data-state-open:zoom-in-95 fixed top-[50%] left-[50%] z-50 max-h-[90vh] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] overflow-auto rounded-lg border border-base-200 bg-base-100 p-6 shadow-lg duration-200 data-state-closed:animate-out data-state-open:animate-in",
					className
				)}
			>
				{typeof children === "function" ? children(props) : children}
				{showCloseButton && (
					<AriaButton
						className={cn(
							"btn btn-circle btn-ghost btn-sm absolute top-2 right-2 [&>svg]:h-4 [&>svg]:w-4"
						)}
						slot="close"
					>
						<X />
						<span className="sr-only">Close</span>
					</AriaButton>
				)}
			</AriaDialog>
		</AriaModal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex flex-col space-y-1.5 text-center sm:text-left",
				className
			)}
			{...props}
		/>
	);
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex sm:flex-row sm:justify-end",
				className
			)}
			{...props}
		/>
	);
}

function DialogTitle({
	className,
	...props
}: React.ComponentProps<typeof Heading>) {
	return (
		<Heading
			className={cn(
				"font-semibold text-lg leading-none tracking-tight",
				className
			)}
			slot="title"
			{...props}
		/>
	);
}

function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
	return (
		<p
			className={cn("text-base-content/60 text-sm", className)}
			slot="description"
			{...props}
		/>
	);
}

export {
	DialogTrigger,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
};
