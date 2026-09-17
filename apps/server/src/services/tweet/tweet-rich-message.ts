import { cleanupTweetText } from "@starlight/utils/twitter";
import type { InputFile } from "grammy";
import type { InputRichBlockVideo, InputRichMessage } from "grammy/types";
import type { FxEmbedTweet } from "@/services/fxembed/types";

export namespace TweetRichMessage {
  export function build(params: {
    height?: number;
    tweet: FxEmbedTweet;
    video: string | InputFile;
    width?: number;
  }): InputRichMessage {
    const blocks: NonNullable<InputRichMessage["blocks"]> = [
      {
        type: "paragraph",
        text: [
          { type: "bold", text: params.tweet.author.name },
          " ",
          {
            type: "url",
            text: `@${params.tweet.author.screen_name}`,
            url: `https://x.com/${params.tweet.author.screen_name}`,
          },
        ],
      },
    ];

    const mainText = cleanupTweetText(params.tweet.getDisplayText());
    if (mainText) {
      blocks.push({ type: "paragraph", text: mainText });
    }

    const quoteText = cleanupTweetText(params.tweet.quote?.getDisplayText());
    if (params.tweet.quote && quoteText) {
      blocks.push({
        type: "blockquote",
        blocks: [
          {
            type: "paragraph",
            text: [
              { type: "bold", text: params.tweet.quote.author.name },
              " ",
              {
                type: "url",
                text: `@${params.tweet.quote.author.screen_name}`,
                url: `https://x.com/${params.tweet.quote.author.screen_name}`,
              },
            ],
          },
          { type: "paragraph", text: quoteText },
        ],
      });
    }

    const video: InputRichBlockVideo["video"] = {
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
}
