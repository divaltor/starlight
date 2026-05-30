import env from "@starlight/utils/config";
import pino from "pino";

export const logger = pino({
	level: env.LOG_LEVEL || (env.NODE_ENV === "development" ? "debug" : "info"),
	transport: {
		targets: [
			{
				target: "pino-pretty",
				options: {
					colorize: true,
					timestampKey: "time",
					ignore: "pid,hostname",
				},
			},
		],
	},
});

export type Logger = typeof logger;
