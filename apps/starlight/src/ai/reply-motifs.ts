import { experimental_decide } from "ai";
import type { Experimental_DecisionModel } from "ai";
import { Context, Duration, Effect, Layer, Schema } from "effect";
import { Morph, Tokens } from "@/morphology";

/**
 * Tags the callback in each delivered reply: the word Starlight used to tease a chat member
 * with something about them (a car, a purchase, a loss, a nickname). The lane shows the tags of
 * recent replies to the next request, so she stops reaching for the same detail every time.
 * Code lists candidate words and the decision model picks one or none.
 */
export namespace ReplyMotifs {
  const MIN_PROBABILITY = 0.5;
  const MAX_CANDIDATES = 40;
  const NONE = "none";

  // Az tokenizes these as OTHER, like emoji halves, so only these count as a unit after a number.
  const unitSymbols = new Set(["$", "€", "₽", "%"]);

  const question = {
    question:
      "Which word in `reply` is a callback: something about a specific chat member that Starlight uses to tease them? Prefer a word that `answeredMessages` does not already mention. Choose none when the reply has no callback.",
    definition: {
      callback:
        "A word Starlight uses to tease a specific chat member with something about that person, usually remembered from earlier chat: their car (e.g. «солярис», «бэха»), clothes or other purchases and what they paid (e.g. «куртка», «300 баксов»), their savings, debts, trades or losses (e.g. «кредитка», «шорт»), drinking or diet, their job or employer, an earlier complaint or mistake, or a nickname, title or running bit she keeps for them (e.g. «генерал», «принцесса», «чемодан с кроссовками»).",
      notCallback:
        "The ordinary subject the conversation is about at that moment, general words, verbs, adjectives, insults that do not refer to anything about the person, and words about Starlight herself.",
    },
  };

  export class TagError extends Schema.TaggedError<TagError>()("ReplyMotifsTagError", {
    cause: Schema.Defect(),
    message: Schema.String,
  }) {
    static fromCause(cause: unknown) {
      return new TagError({ cause, message: "Failed to tag reply motifs" });
    }
  }

  export interface Interface {
    // One list per reply, in order; the replies answered the messages in `answered`.
    readonly tag: (input: {
      readonly answered: string;
      readonly replies: readonly string[];
    }) => Effect.Effect<readonly string[][], TagError>;
  }

  export class Service extends Context.Service<Service, Interface>()("starlight/ReplyMotifs") {}

  export function layer(decisionModel: Experimental_DecisionModel): Layer.Layer<Service> {
    const tagReply = Effect.fn("ReplyMotifs.tagReply")(function* tagReply(reply: string, answered: string) {
      const candidates = candidatesOf(reply);

      if (candidates.length === 0) return [];

      const result = yield* Effect.tryPromise({
        try: async (signal) =>
          await experimental_decide({
            abortSignal: signal,
            maxRetries: 2,
            model: decisionModel,
            questions: {
              callback: {
                type: "choice",
                instructions: question,
                criteria: {
                  ...Object.fromEntries(candidates.map((candidate) => [candidate, null])),
                  [NONE]: "The reply has no callback word.",
                },
              },
            },
            state: { answeredMessages: answered, reply },
            // Replies come from private chats too; keep their content out of telemetry.
            telemetry: { functionId: "reply-motifs", isEnabled: true, recordInputs: false, recordOutputs: false },
          }),
        catch: (cause) => TagError.fromCause(cause),
      }).pipe(
        Effect.timeout(Duration.seconds(5)),
        Effect.mapError((cause) => TagError.fromCause(cause)),
      );

      const { choice } = result.answers.callback;
      const probability = result.answers.callback.probabilities?.[choice] ?? 1;

      return choice === NONE || probability < MIN_PROBABILITY ? [] : [choice];
    });

    return Layer.succeed(Service)(
      Service.of({
        tag: Effect.fn("ReplyMotifs.tag")(function* tag(input) {
          return yield* Effect.all(
            input.replies.map((reply) => tagReply(reply, input.answered)),
            { concurrency: "unbounded" },
          );
        }),
      }),
    );
  }

  // Callbacks are things and names, so candidates are nouns, Latin words (brands such as «bmw»)
  // and amounts; the dictionary rules out verbs, adjectives, pronouns and other function words.
  function candidatesOf(reply: string): string[] {
    const tokens = Tokens(reply.toLowerCase().replaceAll("ё", "е")).done([Tokens.WORD, Tokens.NUMBER, Tokens.OTHER]);

    const amounts = tokens.flatMap((token, index) => {
      const unit = tokens[index + 1];

      if (token.type !== Tokens.NUMBER) return [];

      // «300к» and «300баксов» arrive as one token.
      if (token.subType) return [token.toString()];

      if (unit?.type === Tokens.OTHER && unitSymbols.has(unit.toString())) {
        return [`${token.toString()}${unit.toString()}`];
      }

      // After a number the noun reading wins even when it is not the likeliest one, as in «30 см».
      if (unit?.type === Tokens.WORD && Morph(unit.toString()).some((parse) => parse.tag.POS === "NOUN")) {
        return [`${token.toString()} ${unit.toString()}`];
      }

      return [];
    });

    const words = tokens.flatMap((token) => {
      if (token.type !== Tokens.WORD) return [];

      const tag = Morph(token.toString())[0]?.tag;

      return tag?.POS === "NOUN" || tag?.LATN ? [token.toString()] : [];
    });

    return [...new Set([...amounts, ...words])].slice(0, MAX_CANDIDATES);
  }
}
