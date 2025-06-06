import env from "@/server/config";
import pino from "pino";

export const logger = pino({
	level: env.ENVIRONMENT === "dev" ? "debug" : "info",
	transport: {
		targets:
			env.AXIOM_DATASET && env.AXIOM_TOKEN && env.ENVIRONMENT === "prod"
				? [
						{
							target: "@axiomhq/pino",
							options: {
								dataset: env.AXIOM_DATASET,
								token: env.AXIOM_TOKEN,
							},
						},
					]
				: [],
	},
});

export type Logger = typeof logger;
