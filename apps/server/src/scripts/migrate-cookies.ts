import { logger } from "@/logger";
import { redis } from "@/storage";
import { CookieEncryption } from "@repo/crypto";
import { env } from "@repo/utils";

const cookieEncryption = new CookieEncryption(
	env.COOKIE_ENCRYPTION_KEY,
	env.COOKIE_ENCRYPTION_SALT,
);

async function migrateCookies() {
	logger.info("Starting cookie encryption migration...");

	// Get all cookie keys from Redis
	const cookieKeys = await redis.keys("user:cookies:*");
	logger.info(
		{ count: cookieKeys.length },
		"Found %d cookie entries",
		cookieKeys.length,
	);

	let migratedCount = 0;
	let alreadyEncryptedCount = 0;
	let errorCount = 0;

	for (const key of cookieKeys) {
		try {
			// Extract user ID from key (user:cookies:123456789)
			const userId = key.split(":")[2];
			if (!userId) {
				logger.warn({ key }, "Could not extract user ID from key");
				continue;
			}

			// Get current cookie data
			const cookieData = await redis.get(key);
			if (!cookieData) {
				logger.warn({ key }, "No data found for key");
				continue;
			}

			// Check if already encrypted
			if (cookieEncryption.isEncrypted(cookieData)) {
				logger.debug(
					{ userId },
					"Cookies already encrypted for user %s",
					userId,
				);
				alreadyEncryptedCount++;
				continue;
			}

			// Validate that it's valid JSON before encrypting
			try {
				JSON.parse(cookieData);
			} catch (error) {
				logger.error(
					{ userId, error },
					"Invalid JSON in cookie data for user %s",
					userId,
				);
				errorCount++;
				continue;
			}

			// Encrypt the cookie data
			const encryptedData = cookieEncryption.encrypt(cookieData, userId);

			// Store encrypted data back to Redis
			await redis.set(key, encryptedData);

			// Verify we can decrypt it
			const decrypted = cookieEncryption.decrypt(encryptedData, userId);
			if (decrypted !== cookieData) {
				logger.error(
					{ userId },
					"Encryption verification failed for user %s",
					userId,
				);
				errorCount++;
				continue;
			}

			migratedCount++;
			logger.debug(
				{ userId },
				"Successfully migrated cookies for user %s",
				userId,
			);
		} catch (error) {
			const userId = key.split(":")[2];
			logger.error(
				{ userId, error, key },
				"Error migrating cookies for key %s",
				key,
			);
			errorCount++;
		}
	}

	logger.info(
		{
			total: cookieKeys.length,
			migrated: migratedCount,
			alreadyEncrypted: alreadyEncryptedCount,
			errors: errorCount,
		},
		"Cookie migration completed: %d total, %d migrated, %d already encrypted, %d errors",
		cookieKeys.length,
		migratedCount,
		alreadyEncryptedCount,
		errorCount,
	);

	process.exit(0);
}

async function main() {
	try {
		await migrateCookies();
	} catch (error) {
		logger.error({ error }, "Migration failed");
		process.exit(1);
	}
}

if (import.meta.main) {
	main();
}
