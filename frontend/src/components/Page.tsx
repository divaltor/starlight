"use client";

import { backButton, useSignal } from "@telegram-apps/sdk-react";
import { useRouter } from "next/navigation";
import type { PropsWithChildren } from "react";
import { useEffect } from "react";

export function Page({
	children,
	back = true,
}: PropsWithChildren<{
	/**
	 * True if it is allowed to go back from this page.
	 * @default true
	 */
	back?: boolean;
}>) {
	const router = useRouter();
	const isVisible = useSignal(backButton.isVisible);

	// Handle back button click
	useEffect(() => {
		const unsubscribe = backButton.onClick(() => {
			router.back();
		});

		return unsubscribe;
	}, [router]);

	// Control back button visibility based on the 'back' prop
	useEffect(() => {
		if (back) {
			backButton.show();
		} else {
			backButton.hide();
		}

		// Cleanup: hide back button when component unmounts
		return () => {
			if (back) {
				backButton.hide();
			}
		};
	}, [back]);

	// Log visibility changes for debugging (optional)
	useEffect(() => {
		console.log("Back button is", isVisible ? "visible" : "invisible");
	}, [isVisible]);

	return <>{children}</>;
}
