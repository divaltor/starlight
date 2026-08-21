import { useRouter } from "@tanstack/react-router";
import { backButton, mainButton, secondaryButton, settingsButton } from "@telegram-apps/sdk-react";
import { useCallback, useEffect, useRef } from "react";
import type {
	ButtonAction,
	ButtonState,
	MainButtonConfig,
	RouteButtonConfig,
} from "@/types/telegram-buttons";

interface ButtonManager {
	getButtonState: (buttonType: keyof RouteButtonConfig) => ButtonState;
	resetToDefaults: () => void;
	updateConfig: (config: Partial<RouteButtonConfig>) => void;
}

interface UseTelegramButtonsOptions {
	autoCleanup?: boolean;
	debounceMs?: number;
}

type ActionExecutor = (action: ButtonAction, buttonType: string) => void;
type CleanupRegistrar = (cleanup: () => void) => void;

type BottomButtonParams = Parameters<typeof mainButton.setParams>[0];

interface BottomButtonApi {
	canSubscribeClick: () => boolean;
	isMounted: () => boolean;
	setParams: (updates: BottomButtonParams) => void;
	subscribeClick: (handler: () => void) => (() => void) | undefined;
}

/**
 * Show/hide a bottom button according to its config, then wire up the click handler.
 * Used for the main and secondary buttons which share the same lifecycle.
 */
function syncBottomButton(
	config: MainButtonConfig,
	buttonType: string,
	executeAction: ActionExecutor,
	registerCleanup: CleanupRegistrar,
	api: BottomButtonApi,
) {
	const { state, text, action, condition, isLoading, hasShineEffect } = config;
	const shouldShow = condition ? condition() : state === "visible";

	if (!shouldShow || !api.isMounted()) {
		if (api.isMounted()) {
			api.setParams({ isVisible: false });
		}
		return;
	}

	api.setParams({
		text,
		isVisible: true,
		isEnabled: state !== "disabled",
		isLoaderVisible: isLoading,
		hasShineEffect,
		...(config.color && { backgroundColor: config.color }),
		...(config.textColor && { textColor: config.textColor }),
	});

	if (action && api.canSubscribeClick()) {
		const unsubscribe = api.subscribeClick(() => {
			executeAction(action, buttonType);
		});
		registerCleanup(() => unsubscribe?.());
	}
}

/** Wire up the click handler for a simple always-shown button (settings/back). */
function bindButtonTap(
	action: ButtonAction | undefined,
	buttonType: string,
	executeAction: ActionExecutor,
	registerCleanup: CleanupRegistrar,
	canSubscribeClick: () => boolean,
	subscribeClick: (handler: () => void) => (() => void) | undefined,
) {
	if (!action || !canSubscribeClick()) {
		return;
	}

	const unsubscribe = subscribeClick(() => {
		executeAction(action, buttonType);
	});
	registerCleanup(() => unsubscribe?.());
}

export function useTelegramButtons(
	initialConfig?: RouteButtonConfig,
	options?: UseTelegramButtonsOptions,
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
					case "navigate": {
						router.navigate({ to: action.payload as string });
						break;
					}
					case "callback": {
						if (typeof action.payload === "function") {
							(action.payload as () => void | Promise<void>)();
						}
						break;
					}
					case "external": {
						window.open(action.payload as string, "_blank");
						break;
					}
					default: {
						throw new Error(`Invalid action type: ${action.type}`);
					}
				}
			} catch (error) {
				console.error("Failed to execute Telegram button action", { buttonType, error });
			}
		},
		[router],
	);

	// Core button update logic
	const updateButtonsInternal = useCallback(
		(config: RouteButtonConfig) => {
			// Cleanup previous handlers
			for (const cleanup of cleanupFunctions.current) {
				cleanup();
			}

			cleanupFunctions.current = [];

			const registerCleanup: CleanupRegistrar = (cleanup) => {
				cleanupFunctions.current.push(cleanup);
			};

			if (config.mainButton) {
				syncBottomButton(config.mainButton, "mainButton", executeButtonAction, registerCleanup, {
					canSubscribeClick: () => mainButton.onClick.isAvailable(),
					isMounted: () => mainButton.isMounted(),
					setParams: (updates) => mainButton.setParams(updates),
					subscribeClick: (handler) => mainButton.onClick(handler),
				});
			}

			if (config.secondaryButton) {
				syncBottomButton(
					config.secondaryButton,
					"secondaryButton",
					executeButtonAction,
					registerCleanup,
					{
						canSubscribeClick: () => secondaryButton.onClick.isAvailable(),
						isMounted: () => secondaryButton.isMounted(),
						setParams: (updates) => secondaryButton.setParams(updates),
						subscribeClick: (handler) => secondaryButton.onClick(handler),
					},
				);
			}

			// Settings Button Logic - Always visible
			if (config.settingsButton) {
				settingsButton.show.ifAvailable();

				bindButtonTap(
					config.settingsButton.action,
					"settingsButton",
					executeButtonAction,
					registerCleanup,
					() => settingsButton.onClick.isAvailable(),
					(handler) => settingsButton.onClick(handler),
				);
			}

			// Back Button Logic - Show based on router history
			if (config.backButton) {
				backButton.show.ifAvailable();

				bindButtonTap(
					config.backButton.action,
					"backButton",
					executeButtonAction,
					registerCleanup,
					() => backButton.onClick.isAvailable(),
					(handler) => backButton.onClick(handler),
				);
			} else {
				// Hide back button when not needed
				backButton.hide.ifAvailable();
			}
		},
		[executeButtonAction],
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
		[options?.debounceMs, updateButtonsInternal],
	);

	// Public API
	const updateConfig = useCallback(
		(newConfig: Partial<RouteButtonConfig>) => {
			configRef.current = { ...configRef.current, ...newConfig };
			debouncedUpdateButtons(configRef.current);
		},
		[debouncedUpdateButtons],
	);

	const resetToDefaults = useCallback(() => {
		configRef.current = {};
		debouncedUpdateButtons({});
	}, [debouncedUpdateButtons]);

	const getButtonState = useCallback((buttonType: keyof RouteButtonConfig): ButtonState => {
		const buttonConfig = configRef.current[buttonType];
		return buttonConfig?.state || "hidden";
	}, []);

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
