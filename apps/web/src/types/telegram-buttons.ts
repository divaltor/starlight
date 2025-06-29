export type ButtonState = "hidden" | "visible" | "disabled";

export interface ButtonAction {
	type: "navigate" | "callback" | "external";
	payload: string | (() => void) | (() => Promise<void>);
}

export interface BaseButtonConfig {
	state: ButtonState;
	action?: ButtonAction;
	condition?: () => boolean; // Dynamic visibility condition
}

export interface MainButtonConfig extends BaseButtonConfig {
	text: string;
	color?: string;
	textColor?: string;
	isLoading?: boolean;
}

export interface SettingsButtonConfig extends BaseButtonConfig {
	// Settings button has fixed appearance
}

export interface BackButtonConfig extends BaseButtonConfig {
	// Back button has fixed appearance
}

export interface RouteButtonConfig {
	mainButton?: MainButtonConfig;
	settingsButton?: SettingsButtonConfig;
	backButton?: BackButtonConfig;
	// Future buttons can be added here
}
