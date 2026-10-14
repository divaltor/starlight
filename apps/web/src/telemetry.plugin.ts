import { defineNitroPlugin } from "nitropack/runtime";
import { shutdownTelemetry } from "@/telemetry.server";

export default defineNitroPlugin((nitroApp) => {
  // oxlint-disable-next-line typescript/strict-void-return -- Nitro awaits close hooks despite their void declaration.
  nitroApp.hooks.hook("close", shutdownTelemetry);
});
