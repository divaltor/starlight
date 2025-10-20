import { useRouter } from "@tanstack/react-router";
import {
	backButton,
	mainButton,
	secondaryButton,
	settingsButton,
} from "@telegram-apps/sdk-react";
import { useCallback, useEffect, useRef } from "react";
import type {
	ButtonAction,
	ButtonState,
	RouteButtonConfig,
} from "@/types/telegram-buttons";

type ButtonManager = {
	updateConfig: (config: Partial<RouteButtonConfig>) => void;
	resetToDefaults: () => void;
	getButtonState: (buttonType: keyof RouteButtonConfig) => ButtonState;
};

type UseTelegramButtonsOptions = {
	autoCleanup?: boolean;
	debounceMs?: number;
};

export function useTelegramButtons(
	initialConfig?: RouteButtonConfig,
	options?: UseTelegramButtonsOptions
): ButtonManager {
	const router = useRouter();
	const configRef = useRef<RouteButtonConfig>(initialConfig || {});
	const cleanupFunctions = useRef<(() => void)[]>([]);
	const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

	// Action execution with error handling and analytics
	const executeButtonAction = useCallback(
		(action: ButtonAction, buttonType: string) => {
			try {
				switch (action.type) {
					case "navigate":
						router.navigate({ to: action.payload as string });
						break;
					case "callback":
						if (typeof action.payload === "function") {
							(action.payload as () => void | Promise<void>)();
						}
						break;
					case "external":
						window.open(action.payload as string, "_blank");
						break;
					default:
						throw new Error(`Invalid action type: ${action.type}`);
				}
			} catch (error) {
				console.error(`Error executing ${buttonType} action:`, error);
			}
		},
		[router]
	);

	// Core button update logic
	const updateButtonsInternal = useCallback(
		(config: RouteButtonConfig) => {
			// Cleanup previous handlers
			for (const cleanup of cleanupFunctions.current) {
				cleanup();
			}

			cleanupFunctions.current = [];

			// Main Button Logic
			if (config.mainButton) {
				const { state, text, action, condition, isLoading, hasShineEffect } =
					config.mainButton;

				const shouldShow = condition ? condition() : state === "visible";

				if (shouldShow && mainButton.isMounted()) {
					mainButton.setParams({
						text,
						isVisible: true,
						isEnabled: state !== "disabled",
						isLoaderVisible: isLoading,
						hasShineEffect,
						...(config.mainButton.color && { color: config.mainButton.color }),
						...(config.mainButton.textColor && {
							textColor: config.mainButton.textColor,
						}),
					});

					if (action && mainButton.onClick.isAvailable()) {
						const unsubscribe = mainButton.onClick(() => {
							executeButtonAction(action, "mainButton");
						});
						cleanupFunctions.current.push(() => unsubscribe?.());
					}
				} else if (mainButton.isMounted()) {
					mainButton.setParams({ isVisible: false });
				}
			}

			if (config.secondaryButton) {
				const { state, text, action, condition, isLoading, hasShineEffect } =
					config.secondaryButton;

				const shouldShow = condition ? condition() : state === "visible";

				if (shouldShow && secondaryButton.isMounted()) {
					secondaryButton.setParams({
						text,
						isVisible: true,
						isEnabled: state !== "disabled",
						isLoaderVisible: isLoading,
						hasShineEffect,
						...(config.secondaryButton.color && {
							color: config.secondaryButton.color,
						}),
						...(config.secondaryButton.textColor && {
							textColor: config.secondaryButton.textColor,
						}),
					});

					if (action && secondaryButton.onClick.isAvailable()) {
						const unsubscribe = secondaryButton.onClick(() => {
							executeButtonAction(action, "secondaryButton");
						});
						cleanupFunctions.current.push(() => unsubscribe?.());
					}
				} else if (secondaryButton.isMounted()) {
					secondaryButton.setParams({ isVisible: false });
				}
			}

			// Settings Button Logic - Always visible
			if (config.settingsButton) {
				const { action } = config.settingsButton;

				settingsButton.show.ifAvailable();

				if (action && settingsButton.onClick.isAvailable()) {
					const unsubscribe = settingsButton.onClick(() => {
						executeButtonAction(action, "settingsButton");
					});
					cleanupFunctions.current.push(() => {
						unsubscribe?.();
					});
				}
			}

			// Back Button Logic - Show based on router history
			if (config.backButton) {
				const { action } = config.backButton;

				backButton.show.ifAvailable();

				if (action && backButton.onClick.isAvailable()) {
					const unsubscribe = backButton.onClick(() => {
						executeButtonAction(action, "backButton");
					});
					cleanupFunctions.current.push(() => {
						unsubscribe?.();
					});
				}
			} else {
				// Hide back button when not needed
				backButton.hide.ifAvailable();
			}
		},
		[executeButtonAction]
	);

	// Debounced config updates
	const debouncedUpdateButtons = useCallback(
		(config: RouteButtonConfig) => {
			if (updateTimeoutRef.current) {
				clearTimeout(updateTimeoutRef.current);
			}

			updateTimeoutRef.current = setTimeout(() => {
				updateButtonsInternal(config);
			}, options?.debounceMs || 100);
		},
		[options?.debounceMs, updateButtonsInternal]
	);

	// Public API
	const updateConfig = useCallback(
		(newConfig: Partial<RouteButtonConfig>) => {
			configRef.current = { ...configRef.current, ...newConfig };
			debouncedUpdateButtons(configRef.current);
		},
		[debouncedUpdateButtons]
	);

	const resetToDefaults = useCallback(() => {
		configRef.current = {};
		debouncedUpdateButtons({});
	}, [debouncedUpdateButtons]);

	const getButtonState = useCallback(
		(buttonType: keyof RouteButtonConfig): ButtonState => {
			const buttonConfig = configRef.current[buttonType];
			return buttonConfig?.state || "hidden";
		},
		[]
	);

	// Initialize on mount
	useEffect(() => {
		if (initialConfig) {
			updateButtonsInternal(initialConfig);
		}

		// Cleanup on unmount
		return () => {
			if (options?.autoCleanup !== false) {
				for (const cleanup of cleanupFunctions.current) {
					cleanup();
				}

				if (updateTimeoutRef.current) {
					clearTimeout(updateTimeoutRef.current);
				}
			}
		};
	}, [initialConfig, updateButtonsInternal, options?.autoCleanup]);

	return { updateConfig, resetToDefaults, getButtonState };
}
