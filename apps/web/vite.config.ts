import tailwindcss from "@tailwindcss/vite";
import { nitroV2Plugin } from "@tanstack/nitro-v2-vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    nitroV2Plugin({
      compatibilityDate: "2025-10-17",
      preset: "bun",
      minify: true,
      alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
      plugins: ["./src/telemetry.plugin.ts"],
      sourceMap: false,
    }),
    tailwindcss(),
    tanstackStart(),
    // React Compiler via the Rust port; requires the oxc-transform-react
    // devDependency (optional peer of @vitejs/plugin-react).
    viteReact({ compiler: true }),
  ],
  ssr: {
    noExternal: ["@hugeicons/react"],
  },
  resolve: { tsconfigPaths: true },
  server: { allowedHosts: true },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const vendorChunk =
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler")
              ? "react-vendor"
              : undefined;

          if (id.includes("@telegram-apps/") || id.includes("valibot")) {
            return "telegram-sdk";
          }

          return vendorChunk;
        },
      },
    },
  },
});
