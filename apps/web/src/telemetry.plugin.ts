import { defineNitroPlugin } from "nitropack/runtime";
import { shutdownTelemetry } from "./telemetry.server";

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("close", shutdownTelemetry);
});
