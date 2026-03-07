import * as React from "react";
import { Dialog as AriaDialog, Modal as AriaModal, Heading } from "react-aria-components";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AlertDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: React.ReactNode;
}

function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
	return (
		<AlertDialogContext.Provider value={{ onOpenChange }}>
			{open ? children : null}
		</AlertDialogContext.Provider>
	);
}

const AlertDialogContext = React.createContext<{ onOpenChange: (open: boolean) => void }>({
	onOpenChange: () => {},
});

function AlertDialogContent({
	className,
	children,
	...props
}: Omit<React.ComponentProps<typeof AriaDialog>, "children" | "role"> & {
	children?: React.ReactNode;
	className?: string;
}) {
	const { onOpenChange } = React.useContext(AlertDialogContext);

	return (
		<AriaModal
			isOpen
			onOpenChange={onOpenChange}
			isDismissable={false}
			className={cn(
				"data-state-closed:fade-out-0 data-state-closed:slide-out-to-top-2 data-state-open:fade-in-0 data-state-open:slide-in-from-top-2 fixed inset-0 z-50 bg-black/30 backdrop-blur-sm data-state-closed:animate-out data-state-open:animate-in",
				className,
			)}
		>
			<AriaDialog
				{...props}
				role="alertdialog"
				className={cn(
					"data-state-closed:fade-out-0 data-state-closed:slide-out-to-top-2 data-state-closed:zoom-out-95 data-state-open:fade-in-0 data-state-open:slide-in-from-top-2 data-state-open:zoom-in-95 fixed top-[50%] left-[50%] z-50 max-h-[90vh] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] overflow-auto rounded-lg border border-base-200 bg-base-100 p-6 shadow-lg duration-200 data-state-closed:animate-out data-state-open:animate-in",
					className,
				)}
			>
				{children}
			</AriaDialog>
		</AriaModal>
	);
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
			{...props}
		/>
	);
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-col-reverse gap-2 sm:flex sm:flex-row sm:justify-end", className)}
			{...props}
		/>
	);
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof Heading>) {
	return (
		<Heading
			className={cn("font-semibold text-lg leading-none tracking-tight", className)}
			slot="title"
			{...props}
		/>
	);
}

function AlertDialogDescription({ className, ...props }: React.ComponentProps<"p">) {
	return (
		<p className={cn("text-base-content/60 text-sm", className)} slot="description" {...props} />
	);
}

function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof Button>) {
	return <Button className={className} {...props} />;
}

function AlertDialogCancel({
	className,
	variant = "outline",
	...props
}: React.ComponentProps<typeof Button>) {
	const { onOpenChange } = React.useContext(AlertDialogContext);

	return (
		<Button
			variant={variant}
			className={className}
			onPress={() => onOpenChange(false)}
			{...props}
		/>
	);
}

export {
	AlertDialog,
	AlertDialogContent,
	AlertDialogHeader,
	AlertDialogFooter,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogAction,
	AlertDialogCancel,
};
