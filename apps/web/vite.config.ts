import tailwindcss from "@tailwindcss/vite";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	plugins: [
		tsconfigPaths(),
		nitroV2Plugin({
			compatibilityDate: "2025-10-17",
			preset: "bun",
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
	server: { allowedHosts: true },
});
