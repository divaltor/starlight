const token = process.env.STARLIGHT_BOT_TOKEN;

if (!token) {
	throw new Error("STARLIGHT_BOT_TOKEN is required");
}

// Shared configuration still validates BOT_TOKEN for the original server process.
process.env.BOT_TOKEN ??= token;

await import("@/app");


