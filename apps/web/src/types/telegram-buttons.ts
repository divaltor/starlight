export type ButtonState = "hidden" | "visible" | "disabled";

export type ButtonAction = {
	type: "navigate" | "callback" | "external";
	payload: string | (() => void) | (() => Promise<void>);
};

export type BaseButtonConfig = {
	state: ButtonState;
	action?: ButtonAction;
	condition?: () => boolean; // Dynamic visibility condition
};

export interface MainButtonConfig extends BaseButtonConfig {
	text?: string;
	color?: `#${string}`;
	textColor?: `#${string}`;
	isLoading?: boolean;
	isEnabled?: boolean;
	hasShineEffect?: boolean;
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

export type RouteButtonConfig = {
	mainButton?: MainButtonConfig;
	settingsButton?: SettingsButtonConfig;
	backButton?: BackButtonConfig;
	secondaryButton?: SecondaryButtonConfig;
};
