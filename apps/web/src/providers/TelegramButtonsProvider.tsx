import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { useRawInitData } from "@telegram-apps/sdk-react";
import { createContext, useContext, useEffect, useMemo } from "react";
import { useTelegramButtons } from "@/hooks/useTelegramButtons";
import type { ButtonState, RouteButtonConfig } from "@/types/telegram-buttons";

interface TelegramButtonsContextValue {
	updateButtons: (config: Partial<RouteButtonConfig>) => void;
	resetButtons: () => void;
	getButtonState: (buttonType: keyof RouteButtonConfig) => ButtonState;
	setMainButton: (text: string, visible?: boolean, action?: () => void) => void;
	rawInitData: string | undefined;
}

const TelegramButtonsContext =
	createContext<TelegramButtonsContextValue | null>(null);

export function useTelegramContext() {
	const context = useContext(TelegramButtonsContext);

	if (!context) {
		throw new Error(
			"useTelegramContext must be used within TelegramButtonsProvider",
		);
	}

	return context;
}

export function TelegramButtonsProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	"use client";

	const router = useRouter();
	const canGoBack = useCanGoBack();

	// Simple configuration using TanStack Router's built-in navigation state
	const currentConfig = useMemo(() => {
		return {
			// Settings button always visible
			settingsButton: {
				state: "visible" as const,
				action: {
					type: "navigate" as const,
					payload: "/settings",
				},
			},
			// Back button visible when router can go back
			backButton: canGoBack
				? {
						state: "visible" as const,
						action: {
							type: "callback" as const,
							payload: () => {
								// Use router's built-in back navigation
								router.history.back();
							},
						},
					}
				: undefined,
		};
	}, [canGoBack, router]);

	const buttonManager = useTelegramButtons(currentConfig, {
		autoCleanup: true,
		debounceMs: 100,
	});

	// Auto-update when route/history changes
	useEffect(() => {
		buttonManager.updateConfig(currentConfig);
	}, [currentConfig, buttonManager]);

	let rawInitData: string | undefined;

	try {
		// biome-ignore lint/correctness/useHookAtTopLevel: We can't use it in SSR because `window` is not presented and we fail
		rawInitData = useRawInitData();
	} catch (error) {
		console.error(error);
	}

	// Helper function for main button
	const setMainButton = (text: string, visible = true, action?: () => void) => {
		buttonManager.updateConfig({
			mainButton: {
				state: visible ? "visible" : "hidden",
				text,
				action: action
					? {
							type: "callback",
							payload: action,
						}
					: undefined,
			},
		});
	};

	const contextValue: TelegramButtonsContextValue = {
		updateButtons: buttonManager.updateConfig,
		resetButtons: buttonManager.resetToDefaults,
		getButtonState: buttonManager.getButtonState,
		setMainButton,
		rawInitData,
	};

	return (
		<TelegramButtonsContext.Provider value={contextValue}>
			{children}
		</TelegramButtonsContext.Provider>
	);
}
