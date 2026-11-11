import { experimental_decide } from "ai";
import type { Experimental_DecisionModel } from "ai";
import { Context, Duration, Effect, Layer, Schema } from "effect";

/**
 * Tags the callback in each delivered reply: the word Starlight used to tease a chat member
 * with something about them (a car, a purchase, a loss, a nickname). The lane shows the tags of
 * recent replies to the next request, so she stops reaching for the same detail every time.
 * Code lists candidate words and the decision model picks one or none.
 */
export namespace ReplyMotifs {
  const MIN_PROBABILITY = 0.5;
  const MAX_CANDIDATES = 40;
  const MIN_WORD_LENGTH = 4;
  const NONE = "none";

  const amount = /(?<!\d)\d+\s?(?:к|k|тыс|евро|рубл|баксов|долларов|см|\$|€|%)/gu;
  const word = /\p{L}+/gu;
  const adjective = /(?:ого|его|ому|ему|ыми|ими|ая|яя|ую|юю|ые|ие|ый|ий)$/u;

  // Function words and pronouns that the model would otherwise have to rule out one by one.
  const stopwords = new Set(
    `просто сейчас только конечно вообще реально потому который которая которое которые которых которым когда тогда
    теперь всегда никогда иногда здесь чтобы чтоб будто словно если хотя даже уже еще очень слишком совсем почти может
    можно нужно надо будет будешь будут было были была быть есть этим такой такая такое такие таких такого таким также тоже
    потом после перед между через более менее самый самая самое самые самого всего всему всеми другой другая другие
    других себя себе собой тебя тебе тобой меня мне мной ничего никто ничем нибудь лучше хуже больше меньше много мало
    сразу снова опять почему зачем сколько какой какая какое какие каких какого каким кажется значит главное вместо
    вокруг кроме ради около против давай давайте хочешь хочет хочу знаешь знаю знает думаешь думаю говорит говоришь
    сказал сказала делать сделать делаешь прямо точно вроде типа ладно правда понятно наверное похоже сегодня завтра
    вчера человек людей время времени жизнь жизни раньше дальше выглядит звучит видимо явно скоро пока нормально
    твой твоя твое твои твою твоем твоим твоих моем моим моих свой своя свое свои свою своем своим своих наша наше наши
    нашем нашим наших ваша ваше ваши вашем вашим ваших этот этого этому этом этой этих этими тому того теми всем всех
    весь кого кому чего чему нему него ними нами вами`.split(/\s+/u),
  );

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

  function candidatesOf(reply: string): string[] {
    const lower = reply.toLowerCase().replaceAll("ё", "е");

    const words = [...lower.matchAll(word)].flatMap((match) =>
      match[0].length < MIN_WORD_LENGTH || stopwords.has(match[0]) || adjective.test(match[0]) ? [] : [match[0]],
    );

    return [...new Set([...[...lower.matchAll(amount)].map((match) => match[0]), ...words])].slice(0, MAX_CANDIDATES);
  }
}
