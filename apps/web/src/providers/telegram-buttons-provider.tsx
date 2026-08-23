import { useCanGoBack, useRouter } from "@tanstack/react-router";
import { retrieveRawInitData } from "@telegram-apps/sdk-react";
import { createContext, useContext, useEffect } from "react";
import { useTelegramButtons } from "@/hooks/use-telegram-buttons";
import type { ButtonState, RouteButtonConfig } from "@/types/telegram-buttons";

interface TelegramButtonsContextValue {
	getButtonState: (buttonType: keyof RouteButtonConfig) => ButtonState;
	rawInitData: string | null;
	resetButtons: () => void;
	setMainButton: (text: string, visible?: boolean, action?: () => void) => void;
	updateButtons: (config: Partial<RouteButtonConfig>) => void;
}

const TelegramButtonsContext = createContext<TelegramButtonsContextValue | null>(null);

export function useTelegramContext() {
	const context = useContext(TelegramButtonsContext);

	if (!context) {
		throw new Error("useTelegramContext must be used within TelegramButtonsProvider");
	}

	return context;
}

export function TelegramButtonsProvider({ children }: { children: React.ReactNode }) {
	"use client";

	const router = useRouter();
	const canGoBack = useCanGoBack();

	const buttonManager = useTelegramButtons(undefined, {
		autoCleanup: true,
		debounceMs: 100,
	});

	// Auto-update when route/history changes. The config is built inside the
	// effect: a fresh object per render would defeat dependency checks.
	useEffect(() => {
		buttonManager.updateConfig({
			settingsButton: {
				state: "visible" as const,
				action: {
					type: "navigate" as const,
					payload: "/settings",
				},
			},
			backButton: canGoBack
				? {
						state: "visible" as const,
						action: {
							type: "callback" as const,
							payload: () => {
								router.history.back();
							},
						},
					}
				: undefined,
		});
	}, [buttonManager, canGoBack, router]);

	let rawInitData: string | null;

	try {
		rawInitData = retrieveRawInitData() ?? null;
	} catch {
		rawInitData = null;
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
