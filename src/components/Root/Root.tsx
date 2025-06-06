"use client";

import {
	initData,
	miniApp,
	useLaunchParams,
	useSignal,
} from "@telegram-apps/sdk-react";
import { AppRoot } from "@telegram-apps/telegram-ui";
import { type PropsWithChildren, useEffect } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorPage } from "@/components/ErrorPage";
import { setLocale } from "@/core/i18n/locale";
import { useDidMount } from "@/hooks/useDidMount";

import "./styles.css";
import { redirect } from "next/navigation";

function RootInner({ children }: PropsWithChildren) {
	const lp = useLaunchParams();

	const isDark = useSignal(miniApp.isDark);
	const initDataUser = useSignal(initData.user);

	// Set the user locale.
	useEffect(() => {
		initDataUser && setLocale(initDataUser.language_code);
	}, [initDataUser]);

	return (
		<AppRoot
			appearance={isDark ? "dark" : "light"}
			platform={["macos", "ios"].includes(lp.tgWebAppPlatform) ? "ios" : "base"}
		>
			{children}
		</AppRoot>
	);
}

export function Root(props: PropsWithChildren) {
	// Unfortunately, Telegram Mini Apps does not allow us to use all features of
	// the Server Side Rendering. That's why we are showing loader on the server
	// side.
	const didMount = useDidMount();

	return didMount ? (
		redirect("https://youtu.be/dQw4w9WgXcQ")
	) : (
		<div className="root__loading">Loading</div>
	);
}
