declare module "az" {
  // Az compares token types by identity: each is a `String` object, so `type === "WORD"` is never true.
  interface TokenType {
    readonly azTokenType: never;
  }

  interface Token {
    readonly type: TokenType;
    // Set on a NUMBER token when letters follow the digits, as in «300к» or «5k».
    readonly subType?: TokenType;
    readonly toString: () => string;
  }

  interface Parse {
    // OpenCorpora grammemes: `POS` holds the part of speech; each grammeme the word has, such as `LATN`, is `true`.
    readonly tag: { readonly POS?: string; readonly LATN?: true };
    readonly word: string;
    readonly normalize: () => Parse;
  }

  export const Tokens: ((text: string) => { readonly done: (types?: readonly TokenType[]) => Token[] }) & {
    readonly WORD: TokenType;
    readonly NUMBER: TokenType;
    readonly OTHER: TokenType;
  };

  // Parses one word, most likely reading first; empty when nothing matches.
  export const Morph: ((word: string) => Parse[]) & {
    readonly init: (callback: (error: Error | null) => void) => void;
  };
}
