import env from "@/server/config";
import pino from "pino";

export const logger = pino({
	level: env.LOG_LEVEL,
	// transport: {
	// 	targets: [
	// 		{
	// 			target: "pino-pretty",
	// 			level: env.LOG_LEVEL,
	// 			options: {
	// 				ignore: "pid,hostname",
	// 				colorize: true,
	// 				translateTime: true,
	// 			},
	// 		},
	// 	],
	// },
});

export type Logger = typeof logger;
