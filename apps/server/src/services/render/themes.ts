export type Theme = "light" | "dark";

export type ThemeColors = {
	background: string;
	cardBackground: string;
	text: string;
	secondaryText: string;
	accent: string;
	border: string;
};

export const themes: Record<Theme, ThemeColors> = {
	light: {
		background: "#ffffff",
		cardBackground: "#FAF4ED",
		text: "#0f1419",
		secondaryText: "#536471",
		accent: "#1d9bf0",
		border: "#cfd9de",
	},
	dark: {
		background: "#000000",
		cardBackground: "#16181c",
		text: "#e7e9ea",
		secondaryText: "#71767b",
		accent: "#1d9bf0",
		border: "#3e4144",
	},
};
