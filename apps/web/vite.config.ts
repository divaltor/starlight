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
      sourceMap: false,
    }),
    tailwindcss(),
    tanstackStart(),
    // React Compiler via the Rust port; requires the oxc-transform-react
    // devDependency (optional peer of @vitejs/plugin-react).
    viteReact({ compiler: true }),
  ],
  ssr: {
    // Bundle lucide-react into the server build so only used icons ship,
    // instead of the whole CJS package being copied verbatim.
    noExternal: ["lucide-react"],
  },
  resolve: { tsconfigPaths: true },
  server: { allowedHosts: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@telegram-apps/")) return "telegram-sdk";
          if (id.includes("valibot")) return "telegram-sdk";
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler")
          )
            return "react-vendor";
        },
      },
    },
  },
});
