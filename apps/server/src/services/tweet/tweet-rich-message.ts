import { FormattedString } from "@grammyjs/parse-mode";
import { cleanupTweetText } from "@starlight/utils/twitter";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import type { FxEmbedTweet } from "@/services/fxembed/types";
import type { TweetData } from "@/services/render";

type ReplyChainTweet = Pick<TweetData, "authorName" | "authorUsername" | "text">;

type RichBlock = NonNullable<InputRichMessageWithoutUpload["blocks"]>[number];

const CAPTION_LIMIT = 1024;

export namespace TweetRichMessage {
  export function build(params: {
    height?: number;
    replyChain?: ReplyChainTweet[];
    tweet: FxEmbedTweet;
    video: string;
    width?: number;
  }): InputRichMessageWithoutUpload {
    const blocks: RichBlock[] = [
      ...(params.replyChain ?? []).map((reply): RichBlock => ({
        type: "blockquote",
        blocks: [
          authorParagraph(reply.authorName, reply.authorUsername),
          { type: "paragraph", text: cleanupTweetText(reply.text) ?? "" },
        ],
      })),
      authorParagraph(params.tweet.author.name, params.tweet.author.screen_name),
    ];

    const mainText = cleanupTweetText(params.tweet.getDisplayText());

    if (mainText !== undefined && mainText !== "") {
      blocks.push({ type: "paragraph", text: mainText });
    }

    const quoteText = cleanupTweetText(params.tweet.quote?.getDisplayText());

    if (params.tweet.quote && quoteText !== undefined && quoteText !== "") {
      blocks.push({
        type: "blockquote",
        blocks: [
          authorParagraph(params.tweet.quote.author.name, params.tweet.quote.author.screen_name),
          { type: "paragraph", text: quoteText },
        ],
      });
    }

    const video: Extract<RichBlock, { type: "video" }>["video"] = {
      type: "video",
      media: params.video,
      supports_streaming: true,
    };

    if (params.width !== undefined) {
      video.width = params.width;
    }

    if (params.height !== undefined) {
      video.height = params.height;
    }

    blocks.push({
      type: "video",
      video,
    });

    return { blocks };
  }

  // Media captions cap at 1024 characters: the oldest replies go first, then the post body is cut.
  export function caption(params: { replyChain: ReplyChainTweet[]; tweet: FxEmbedTweet }): FormattedString {
    const header = FormattedString.b(params.tweet.author.name)
      .plain(" ")
      .link(`@${params.tweet.author.screen_name}`, `https://x.com/${params.tweet.author.screen_name}`);

    const link = new FormattedString(`https://x.com/i/status/${params.tweet.id}`);
    const mainText = cleanupTweetText(params.tweet.getDisplayText());
    const quoteText = cleanupTweetText(params.tweet.quote?.getDisplayText());

    const body = FormattedString.join(
      [
        ...(mainText === undefined || mainText === "" ? [] : [new FormattedString(mainText)]),
        ...(params.tweet.quote && quoteText !== undefined && quoteText !== ""
          ? [FormattedString.blockquote(FormattedString.b(params.tweet.quote.author.name).plain(`\n${quoteText}`))]
          : []),
      ],
      "\n\n",
    );

    const replies = params.replyChain.map((reply) =>
      FormattedString.expandableBlockquote(
        FormattedString.b(reply.authorName).plain(`\n${cleanupTweetText(reply.text) ?? ""}`),
      ),
    );

    const post = FormattedString.join([header, ...(body.text === "" ? [] : [body]), link], "\n\n");

    const fittingReplies = replies.findIndex(
      (_, index) => FormattedString.join([...replies.slice(index), post], "\n\n").caption.length <= CAPTION_LIMIT,
    );

    if (fittingReplies !== -1) {
      return FormattedString.join([...replies.slice(fittingReplies), post], "\n\n");
    }

    if (post.caption.length <= CAPTION_LIMIT) {
      return post;
    }

    return FormattedString.join(
      [header, body.slice(0, body.text.length - (post.caption.length - CAPTION_LIMIT) - 1).plain("…"), link],
      "\n\n",
    );
  }
}

function authorParagraph(name: string, screenName: string): RichBlock {
  return {
    type: "paragraph",
    text: [
      { type: "bold", text: name },
      " ",
      { type: "url", text: `@${screenName}`, url: `https://x.com/${screenName}` },
    ],
  };
}
