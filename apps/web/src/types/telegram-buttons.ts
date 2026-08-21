export type ButtonState = "hidden" | "visible" | "disabled";

export interface ButtonAction {
	payload: string | (() => void) | (() => Promise<void>);
	type: "navigate" | "callback" | "external";
}

export interface BaseButtonConfig {
	action?: ButtonAction;
	// Dynamic visibility condition
	condition?: () => boolean;
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

/** Settings button has fixed appearance */
export type SettingsButtonConfig = BaseButtonConfig;

/** Back button has fixed appearance */
export type BackButtonConfig = BaseButtonConfig;

/** Secondary button has fixed appearance */
export type SecondaryButtonConfig = MainButtonConfig;

export interface RouteButtonConfig {
	backButton?: BackButtonConfig;
	mainButton?: MainButtonConfig;
	secondaryButton?: SecondaryButtonConfig;
	settingsButton?: SettingsButtonConfig;
}
