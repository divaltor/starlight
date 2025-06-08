import { openLink } from "@telegram-apps/sdk-react";
import {
	default as NextLink,
	type LinkProps as NextLinkProps,
} from "next/link";
import { type FC, type JSX, type MouseEventHandler, useCallback } from "react";

import { classNames } from "apps/web/src-bak/css/classnames";

import "./Link.css";

export interface LinkProps
	extends NextLinkProps,
		Omit<JSX.IntrinsicElements["a"], "href"> {}

export const Link: FC<LinkProps> = ({
	className,
	onClick: propsOnClick,
	href,
	...rest
}) => {
	const onClick = useCallback<MouseEventHandler<HTMLAnchorElement>>(
		(e) => {
			propsOnClick?.(e);

			// Compute if target path is external. In this case we would like to open link using
			// TMA method.
			let path: string;
			if (typeof href === "string") {
				path = href;
			} else {
				const { search = "", pathname = "", hash = "" } = href;
				path = `${pathname}?${search}#${hash}`;
			}

			const targetUrl = new URL(path, window.location.toString());
			const currentUrl = new URL(window.location.toString());
			const isExternal =
				targetUrl.protocol !== currentUrl.protocol ||
				targetUrl.host !== currentUrl.host;

			if (isExternal) {
				e.preventDefault();
				openLink(targetUrl.toString());
			}
		},
		[href, propsOnClick],
	);

	return (
		<NextLink
			{...rest}
			href={href}
			onClick={onClick}
			className={classNames(className, "link")}
		/>
	);
};
