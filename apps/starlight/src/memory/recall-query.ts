import { isWithinTokenLimit } from "gpt-tokenizer/encoding/cl100k_base";
import type { InputPayload } from "@/conversation/run-artifacts";

export namespace RecallQuery {
  const ENCODE_OPTIONS = { disallowedSpecial: new Set<string>() };

  type Input = Pick<InputPayload, "addressed" | "repliedText" | "senderFirstName" | "text">;

  interface Segment {
    readonly addressed: boolean;
    readonly body: string;
    readonly inputOrdinal: number;
    readonly kindOrdinal: number;
    readonly label: string;
  }

  export function build(options: { readonly inputs: readonly Input[]; readonly maxTokens: number }) {
    // Hindsight 0.9.2 counts cl100k_base tokens and rejects REST queries above its
    // configured cap. Keep normal batches byte-for-byte unchanged; only overflow
    // invokes the relevance policy below.
    const segments = options.inputs.flatMap((input, inputOrdinal): Segment[] => [
      {
        addressed: input.addressed,
        body: input.text,
        inputOrdinal,
        kindOrdinal: 0,
        label: `${input.senderFirstName}: `,
      },
      ...(input.repliedText === null
        ? []
        : [
            {
              addressed: input.addressed,
              body: input.repliedText,
              inputOrdinal,
              kindOrdinal: 1,
              label: "Replied to: ",
            },
          ]),
    ]);
    // The one-token fallback keeps every validated positive cap representable, including
    // empty or pathological batches where no labeled segment can fit.
    const fullQuery = render(segments) || "context";
    if (isWithinTokenLimit(fullQuery, options.maxTokens, ENCODE_OPTIONS) !== false) return fullQuery;

    // Recall only selects durable memories; every frozen input still reaches the model.
    // Spend this narrower budget on addressed and recent text, then restore FIFO for retrieval.
    const prioritized = segments.toSorted(
      (left, right) =>
        Number(right.addressed) - Number(left.addressed) ||
        right.inputOrdinal - left.inputOrdinal ||
        left.kindOrdinal - right.kindOrdinal,
    );
    const selected: Segment[] = [];
    let exhausted = false;
    for (const segment of prioritized) {
      if (exhausted) continue;
      const completeFits =
        isWithinTokenLimit(render([...selected, segment]), options.maxTokens, ENCODE_OPTIONS) !== false;
      if (completeFits) selected.push(segment);
      if (!completeFits) {
        // Preserve both ends of the last useful segment rather than losing either its topic
        // or conclusion; encode every candidate because characters are not token-equivalent.
        const characters = [...segment.body];
        let lower = 1;
        let upper = characters.length - 1;
        let fitting: Segment | null = null;
        while (lower <= upper) {
          const length = Math.floor((lower + upper) / 2);
          const prefixLength = Math.ceil(length / 2);
          const fragment = {
            ...segment,
            body: `${characters.slice(0, prefixLength).join("")} … ${characters.slice(-Math.floor(length / 2)).join("")}`,
          };
          if (isWithinTokenLimit(render([...selected, fragment]), options.maxTokens, ENCODE_OPTIONS) !== false) {
            fitting = fragment;
            lower = length + 1;
            continue;
          }
          upper = length - 1;
        }
        if (fitting !== null) selected.push(fitting);
        exhausted = true;
      }
    }

    return render(selected) || "context";
  }

  function render(segments: readonly Segment[]) {
    return segments
      .toSorted((left, right) => left.inputOrdinal - right.inputOrdinal || left.kindOrdinal - right.kindOrdinal)
      .map((segment) => `${segment.label}${segment.body}`)
      .join("\n")
      .trim();
  }
}
