const QUOTLY_COMMAND = /^\/q(?:@[a-z\d_]+)?(?:\s|$)/iu;

export namespace MessageReply {
  export interface Options {
    readonly explicitlyAddressed: boolean;
    readonly hasSticker: boolean;
    readonly isReply: boolean;
    readonly random: () => number;
    readonly randomResponseChance: number;
    readonly text: string;
  }

  export function shouldRespond(options: Options): boolean {
    if (options.isReply && QUOTLY_COMMAND.test(options.text)) return false;
    if (options.explicitlyAddressed) return true;
    if (options.hasSticker) return false;
    return options.random() < options.randomResponseChance;
  }
}
