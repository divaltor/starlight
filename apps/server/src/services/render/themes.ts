export type Theme = "light" | "dark";

export interface ThemeColors {
  accent: string;
  background: string;
  border: string;
  cardBackground: string;
  secondaryText: string;
  text: string;
}

export const themes: Record<Theme, ThemeColors> = {
  light: {
    background: "#ffffff",
    cardBackground: "#f7f9f9",
    text: "#0f1419",
    secondaryText: "#536471",
    accent: "#1d9bf0",
    border: "#cfd9de",
  },
  dark: {
    background: "#000000",
    cardBackground: "#16181c",
    text: "#e7e9ea",
    // X's #71767b only reaches 3.9:1 on the card background; this clears WCAG AA (4.5:1).
    secondaryText: "#7c8186",
    accent: "#1d9bf0",
    border: "#3e4144",
  },
};
