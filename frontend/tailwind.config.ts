import type { Config } from "tailwindcss";

const config: Config = {
	darkMode: ["class"],
	content: [
		"./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
		"./src/components/**/*.{js,ts,jsx,tsx,mdx}",
		"./src/app/**/*.{js,ts,jsx,tsx,mdx}",
	],
	theme: {
		extend: {
			colors: {
				// Nanashi Mumei inspired color palette
				primary: {
					DEFAULT: "#8B6F47", // Mumei's main brown
					50: "#FAF8F5",
					100: "#F5F0E8",
					200: "#E8D5C4",
					300: "#DBBA9F",
					400: "#C19E7A",
					500: "#8B6F47", // Main brown
					600: "#75623D",
					700: "#5E4F32",
					800: "#483C28",
					900: "#32291D",
					950: "#1C1611",
				},
				secondary: {
					DEFAULT: "#F5EFE7", // Light cream
					50: "#FDFCFA",
					100: "#FAF8F5",
					200: "#F5EFE7",
					300: "#F0E6D9",
					400: "#EBDDCB",
					500: "#E6D4BD",
					600: "#D4C2A5",
					700: "#C2B08D",
					800: "#B09E75",
					900: "#9E8C5D",
				},
				accent: {
					DEFAULT: "#D4A574", // Warm beige accent
					50: "#FCF9F6",
					100: "#F9F3ED",
					200: "#F0E7D4",
					300: "#E7DBBB",
					400: "#DECFA2",
					500: "#D4A574", // Main accent
					600: "#C89456",
					700: "#B0803B",
					800: "#8B6630",
					900: "#664C24",
				},
				muted: {
					DEFAULT: "#F5F0E8",
					foreground: "#8B7355",
				},
				background: "#FDFCFA", // Very light cream
				foreground: "#3C3328", // Dark brown text
				card: {
					DEFAULT: "#FFFFFF",
					foreground: "#3C3328",
				},
				popover: {
					DEFAULT: "#FFFFFF",
					foreground: "#3C3328",
				},
				border: "#E8D5C4",
				input: "#F5EFE7",
				ring: "#8B6F47",
				destructive: {
					DEFAULT: "#DC6E5C",
					foreground: "#FFFFFF",
				},
			},
			borderRadius: {
				lg: "var(--radius)",
				md: "calc(var(--radius) - 2px)",
				sm: "calc(var(--radius) - 4px)",
			},
			backgroundImage: {
				"gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
				"gradient-conic":
					"conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
			},
		},
	},
	plugins: [require("tailwindcss-animate")],
};
export default config;
