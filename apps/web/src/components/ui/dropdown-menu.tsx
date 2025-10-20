import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	Button,
	Menu,
	MenuItem,
	MenuSection,
	MenuTrigger,
	Popover,
} from "react-aria-components";

import { cn } from "@/lib/utils";

function DropdownMenu({
	children,
	...props
}: React.ComponentProps<typeof MenuTrigger>) {
	return <MenuTrigger {...props}>{children}</MenuTrigger>;
}

function DropdownMenuPortal({
	children,
	...props
}: React.ComponentProps<"div">) {
	return (
		<div data-slot="dropdown-menu-portal" {...props}>
			{children}
		</div>
	);
}

function DropdownMenuTrigger({
	children,
	...props
}: React.ComponentProps<typeof Button>) {
	return (
		<Button data-slot="dropdown-menu-trigger" {...props}>
			{children}
		</Button>
	);
}

function DropdownMenuContent({
	children,
	className,
	...props
}: React.ComponentProps<typeof Popover>) {
	return (
		<Popover
			className={cn(
				"dropdown-content z-[1] w-52 rounded-box bg-base-100 p-2 shadow",
				className
			)}
			{...props}
		>
			<Menu className="menu w-full">{children}</Menu>
		</Popover>
	);
}

function DropdownMenuGroup({
	...props
}: React.ComponentProps<typeof MenuSection>) {
	return <MenuSection data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
	className,
	inset,
	variant = "default",
	...props
}: React.ComponentProps<typeof MenuItem> & {
	inset?: boolean;
	variant?: "default" | "destructive";
}) {
	return (
		<MenuItem
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-base-200 focus:text-base-content data-[disabled]:pointer-events-none data-[inset]:pl-8 data-[variant=destructive]:text-error data-[disabled]:opacity-50 data-[variant=destructive]:focus:bg-error/10 data-[variant=destructive]:focus:text-error [&_svg:not([class*='text-'])]:text-base-content/60 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-item"
			data-variant={variant}
			{...props}
		/>
	);
}

function DropdownMenuCheckboxItem({
	className,
	children,
	checked,
	...props
}: { children: ReactNode; checked?: boolean } & React.ComponentProps<
	typeof MenuItem
>) {
	return (
		<MenuItem
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-sm outline-none focus:bg-base-200 focus:text-base-content data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
				className
			)}
			data-slot="dropdown-menu-checkbox-item"
			{...props}
		>
			<span className="pointer-events-none absolute left-2 flex h-4 w-4 items-center justify-center">
				{checked && <CheckIcon className="size-4" />}
			</span>
			{children}
		</MenuItem>
	);
}

function DropdownMenuRadioGroup({
	children,
	...props
}: { children: React.ReactNode } & React.ComponentProps<"div">) {
	return (
		<div data-slot="dropdown-menu-radio-group" {...props}>
			{children}
		</div>
	);
}

function DropdownMenuRadioItem({
	className,
	children,
	...props
}: { children: ReactNode } & React.ComponentProps<typeof MenuItem>) {
	const [selected, setSelected] = useState(false);
	return (
		<MenuItem
			className={cn(
				"relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-sm outline-none focus:bg-base-200 focus:text-base-content data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
				className
			)}
			data-slot="dropdown-menu-radio-item"
			onAction={() => setSelected(true)}
			{...props}
		>
			<span className="pointer-events-none absolute left-2 flex h-4 w-4 items-center justify-center">
				{selected && <CircleIcon className="size-3 fill-current" />}
			</span>
			{children}
		</MenuItem>
	);
}

function DropdownMenuLabel({
	className,
	inset,
	children,
	...props
}: { children: ReactNode; inset?: boolean } & React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"px-2 py-1.5 font-medium text-sm data-[inset]:pl-8",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-label"
			role="presentation"
			{...props}
		>
			{children}
		</div>
	);
}

function DropdownMenuSeparator({
	className,
	...props
}: React.ComponentProps<"hr">) {
	return (
		<hr
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			data-slot="dropdown-menu-separator"
			{...props}
		/>
	);
}

function DropdownMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ml-auto text-muted-foreground text-xs tracking-widest",
				className
			)}
			data-slot="dropdown-menu-shortcut"
			{...props}
		/>
	);
}

function DropdownMenuSub({ ...props }: React.ComponentProps<"div">) {
	return <div data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: { children: ReactNode; inset?: boolean } & React.ComponentProps<
	typeof MenuItem
>) {
	return (
		<MenuItem
			className={cn(
				"flex cursor-default select-none items-center rounded-md px-2 py-1.5 text-sm outline-none focus:bg-base-200 focus:text-base-content data-[state=open]:bg-base-200 data-[inset]:pl-8 data-[state=open]:text-base-content",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-sub-trigger"
			{...props}
		>
			{children}
			<ChevronRightIcon className="ml-auto size-4" />
		</MenuItem>
	);
}

function DropdownMenuSubContent({
	className,
	...props
}: React.ComponentProps<typeof Popover>) {
	return (
		<Popover
			className={cn(
				"z-50 min-w-[8rem] origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-hidden rounded-box border bg-base-100 p-1 text-base-content shadow-lg",
				className
			)}
			data-slot="dropdown-menu-sub-content"
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuPortal,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuItem,
	DropdownMenuCheckboxItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
};
