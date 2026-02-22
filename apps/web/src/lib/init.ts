import {
	bindThemeParamsCssVars,
	emitEvent,
	init as initSDK,
	mockTelegramEnv,
	mountBackButton,
	mountClosingBehavior,
	mountMainButton,
	mountMiniAppSync,
	mountSecondaryButton,
	mountSettingsButton,
	mountSwipeBehavior,
	restoreInitData,
	retrieveLaunchParams,
	setDebug,
	type ThemeParams,
	themeParamsState,
	viewport,
} from "@telegram-apps/sdk-react";

export interface InitOptions {
	debug?: boolean;
	mockForMacOS?: boolean;
}

/**
 * Initializes the Telegram Mini App and configures its dependencies.
 */
export function initTMA(): void {
	const launchParams = retrieveLaunchParams();
	const { tgWebAppPlatform: platform } = launchParams;

	const debug =
		(launchParams.tgWebAppStartParam || "").includes("debug") ||
		process.env.NODE_ENV === "development";
	const mockForMacOS = platform === "macos";

	// Set @telegram-apps/sdk-react debug mode and initialize it
	setDebug(debug);
	initSDK();

	// Handle macOS-specific Telegram client bugs
	if (mockForMacOS) {
		let firstThemeSent = false;
		mockTelegramEnv({
			onEvent(event, next) {
				if (event[0] === "web_app_request_theme") {
					let tp: ThemeParams = {};
					if (firstThemeSent) {
						tp = themeParamsState();
					} else {
						firstThemeSent = true;
						tp ||= retrieveLaunchParams().tgWebAppThemeParams;
					}
					return emitEvent("theme_changed", { theme_params: tp });
				}

				if (event[0] === "web_app_request_safe_area") {
					return emitEvent("safe_area_changed", {
						left: 0,
						top: 0,
						right: 0,
						bottom: 0,
					});
				}

				next();
			},
		});
	}

	if (mountMiniAppSync.isAvailable()) {
		mountMiniAppSync();
		bindThemeParamsCssVars();
	}

	mountComponents();

	restoreInitData();
}

/**
 * Mount all available Telegram components
 */
function mountComponents(): void {
	mountBackButton.ifAvailable();
	mountMainButton.ifAvailable();
	mountSettingsButton.ifAvailable();
	mountSwipeBehavior.ifAvailable();
	mountClosingBehavior.ifAvailable();
	mountSecondaryButton.ifAvailable();

	viewport.mount.ifAvailable();
	viewport.bindCssVars.ifAvailable();
	viewport.expand.ifAvailable();
}
