import { redirect, useRouter } from "@tanstack/react-router";
import { useRawInitData } from "@telegram-apps/sdk-react";
import { createContext, useContext, useEffect, useMemo } from "react";
import { useTelegramButtons } from "@/hooks/useTelegramButtons";
import type { ButtonState, RouteButtonConfig } from "@/types/telegram-buttons";

interface TelegramButtonsContextValue {
	updateButtons: (config: Partial<RouteButtonConfig>) => void;
	resetButtons: () => void;
	getButtonState: (buttonType: keyof RouteButtonConfig) => ButtonState;
	setMainButton: (text: string, visible?: boolean, action?: () => void) => void;
	rawInitData: string;
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
	const router = useRouter();
	const history = router.history;

	// Simple configuration based on router history and always-visible settings
	const currentConfig = useMemo(() => {
		const canGoBack = history.length > 1;

		return {
			// Settings button always visible
			settingsButton: {
				state: "visible" as const,
				action: {
					type: "navigate" as const,
					payload: "/settings",
				},
			},
			// Back button visible when there's history to go back to
			backButton: canGoBack
				? {
						state: "visible" as const,
						action: {
							type: "callback" as const,
							payload: () => history.back(),
						},
					}
				: undefined,
		};
	}, [history]);

	const buttonManager = useTelegramButtons(currentConfig, {
		autoCleanup: true,
		debounceMs: 100,
	});

	// Auto-update when route/history changes
	useEffect(() => {
		buttonManager.updateConfig(currentConfig);
	}, [currentConfig, buttonManager]);

	const rawInitData = useRawInitData();

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

	if (!rawInitData) {
		throw redirect({ href: "https://youtu.be/dQw4w9WgXcQ", throw: true });
	}

	return (
		<TelegramButtonsContext.Provider value={contextValue}>
			{children}
		</TelegramButtonsContext.Provider>
	);
}
