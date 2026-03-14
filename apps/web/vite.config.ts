import tailwindcss from "@tailwindcss/vite";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		nitroV2Plugin({
			compatibilityDate: "2025-10-17",
			preset: "bun",
			minify: true,
			sourceMap: true,
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
	],
	resolve: { tsconfigPaths: true },
	server: { allowedHosts: true },
});
