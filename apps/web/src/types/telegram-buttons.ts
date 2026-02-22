export type ButtonState = "hidden" | "visible" | "disabled";

export interface ButtonAction {
	payload: string | (() => void) | (() => Promise<void>);
	type: "navigate" | "callback" | "external";
}

export interface BaseButtonConfig {
	action?: ButtonAction;
	condition?: () => boolean; // Dynamic visibility condition
	state: ButtonState;
}

export interface MainButtonConfig extends BaseButtonConfig {
	color?: `#${string}`;
	hasShineEffect?: boolean;
	isEnabled?: boolean;
	isLoading?: boolean;
	text?: string;
	textColor?: `#${string}`;
}

export interface SettingsButtonConfig extends BaseButtonConfig {
	// Settings button has fixed appearance
}

export interface BackButtonConfig extends BaseButtonConfig {
	// Back button has fixed appearance
}

export interface SecondaryButtonConfig extends MainButtonConfig {
	// Secondary button has fixed appearance
}

export interface RouteButtonConfig {
	backButton?: BackButtonConfig;
	mainButton?: MainButtonConfig;
	secondaryButton?: SecondaryButtonConfig;
	settingsButton?: SettingsButtonConfig;
}
