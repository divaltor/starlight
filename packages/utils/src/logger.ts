import { env } from "@starlight/utils";
import pino from "pino";

export const logger = pino({
	level: env.ENVIRONMENT === "dev" ? "debug" : "info",
	transport: {
		targets:
			env.AXIOM_DATASET && env.AXIOM_TOKEN
				? [
						{
							target: "@axiomhq/pino",
							options: {
								dataset: env.AXIOM_DATASET,
								token: env.AXIOM_TOKEN,
							},
							level: "info",
						},
						{
							target: "pino-pretty",
							options: {
								colorize: true,
								timestampKey: "time",
								ignore: "pid,hostname",
							},
						},
					]
				: [
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
