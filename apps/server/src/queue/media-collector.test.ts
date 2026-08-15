import { beforeEach, describe, expect, mock, test } from "bun:test";
import { enqueueClassification } from "@/queue/classification-recovery";

const classificationSpawn = mock();
const fetchTaskResult = mock();
const retryTask = mock();
const loggerInfo = mock();

describe("media collector classification recovery", () => {
	beforeEach(() => {
		classificationSpawn.mockReset();
		fetchTaskResult.mockReset();
		retryTask.mockReset();
		loggerInfo.mockReset();
	});

	test("recovers each terminal classification failure", async () => {
		classificationSpawn.mockResolvedValue({ taskID: "failed-task", created: false });
		fetchTaskResult
			.mockResolvedValueOnce({ state: "failed", failure: null })
			.mockResolvedValueOnce({ state: "failed", failure: null })
			.mockResolvedValueOnce({ state: "pending" });
		retryTask.mockResolvedValue({ taskID: "failed-task", created: false });

		const dependencies = {
			classificationApp: { spawn: classificationSpawn, fetchTaskResult, retryTask },
			retryStrategy: { kind: "exponential", baseSeconds: 30, factor: 2 },
			logger: { info: loggerInfo },
		};
		await enqueueClassification(dependencies, "media-1", "twitter", "user-1");
		// The first in-place recovery terminally fails; the next collection
		// creates one more recovery on that same task.
		await enqueueClassification(dependencies, "media-1", "twitter", "user-1");
		// Once that recovery is pending, further collectors only coalesce onto it.
		await enqueueClassification(dependencies, "media-1", "twitter", "user-1");

		expect(classificationSpawn).toHaveBeenCalledTimes(3);
		expect(retryTask).toHaveBeenCalledTimes(2);
		expect(retryTask).toHaveBeenNthCalledWith(1, "failed-task");
		expect(retryTask).toHaveBeenNthCalledWith(2, "failed-task");
		expect(classificationSpawn.mock.calls[0]?.[2]).toMatchObject({
			idempotencyKey: "classify-twitter-user-1-media-1",
			maxAttempts: 5,
		});
	});
});
