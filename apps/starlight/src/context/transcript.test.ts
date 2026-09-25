import { expect, test } from "bun:test";
import { Transcript } from "@/context/transcript";

// Regression: forwarded bot replies replayed as user turns taught the model to copy their emoji sign-offs.
test.each([
  { forwardedFromSelf: true, role: "assistant" },
  { forwardedFromSelf: false, role: "user" },
])("a forwarded message replays as $role when forwardedFromSelf is $forwardedFromSelf", (input) => {
  const projections = Transcript.projectRun(
    {
      actions: [],
      errorTag: null,
      id: "run-1",
      inputs: [
        {
          input: {
            id: 1n,
            mediaReferences: [],
            payload: {
              addressed: false,
              date: 1,
              editDate: null,
              forwardOrigin: '{"type":"user"}',
              forwardedFromSelf: input.forwardedFromSelf,
              messageId: 10,
              repliedText: null,
              replyToMessageId: null,
              senderFirstName: "Vlad",
              senderId: 2,
              text: "earlier reply 💅",
            },
          },
        },
      ],
      status: "completed",
      toolCalls: [],
    },
    new Set(),
  );

  expect(projections.map((projection) => projection.role)).toEqual([input.role]);
});
