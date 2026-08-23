interface ClassificationQueue {
	spawn(
		name: string,
		data: { photoId: string; provider: string; userId: string },
		options: {
			idempotencyKey: string;
			maxAttempts: number;
			retryStrategy: unknown;
		},
	): Promise<{ created: boolean; taskID: string }>;
	fetchTaskResult(taskID: string): Promise<{ state: string } | null | undefined>;
	retryTask(taskID: string): Promise<unknown>;
}

interface ClassificationRecoveryDependencies {
	classificationApp: ClassificationQueue;
	retryStrategy: unknown;
	logger: {
		info(context: Record<string, unknown>, message: string): void;
	};
}

export async function enqueueClassification(
	{ classificationApp, retryStrategy, logger }: ClassificationRecoveryDependencies,
	photoId: string,
	provider: string,
	userId: string,
) {
	const idempotencyKey = `classify-${provider}-${userId}-${photoId}`;
	const task = await classificationApp.spawn(
		"classification",
		{ photoId, provider, userId },
		{
			idempotencyKey,
			maxAttempts: 5,
			retryStrategy,
		},
	);

	if (task.created) {
		return;
	}

	const result = await classificationApp.fetchTaskResult(task.taskID);
	if (result?.state !== "failed") {
		return;
	}

	// retryTask atomically changes the failed task back to pending. This keeps
	// its idempotency key and lets every later terminal failure recover again.
	// Omitting maxAttempts adds one attempt beyond the terminal task's count.
	try {
		await classificationApp.retryTask(task.taskID);
	} catch (error) {
		// Another collector may have recovered this task after our snapshot. Once
		// it is no longer failed, that recovery is the coalesced outcome.
		const latestResult = await classificationApp.fetchTaskResult(task.taskID);
		if (!latestResult || latestResult.state === "failed") {
			throw error;
		}
	}
	logger.info(
		{ photoId, provider, userId, taskId: task.taskID },
		"Classification recovery enqueued",
	);
}
