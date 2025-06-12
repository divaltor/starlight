import alias from "@rollup/plugin-alias";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "@tanstack/react-start/config";
import viteTsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	tsr: {
		appDirectory: "src",
	},
	vite: {
		plugins: [
			viteTsConfigPaths({
				projects: ["./tsconfig.json"],
			}),
			tailwindcss(),
		],
		build: {
			rollupOptions: {
				plugins: [
					alias({
						entries: [
							{
								find: "@repo/utils",
								replacement: "../../packages/utils/src",
							},
						],
					}),
				],
			},
		},
	},
	server: {
		preset: "vercel",
	},
});
