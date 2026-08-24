export namespace CacheDiagnostics {
  export interface PrefixSnapshot {
    readonly messages: readonly string[];
    readonly settings: string;
    readonly system: readonly string[];
  }

  export type PrefixVerdict =
    | { readonly appendedMessages: number; readonly status: "append-only" }
    | { readonly changed: "messages" | "settings" | "system"; readonly status: "changed" }
    | { readonly status: "initial" }
    | { readonly status: "stable" };

  // A prefix is only reusable by the provider cache when every leading component is
  // byte-identical and history grew strictly at the tail.
  export function comparePrefix(previous: PrefixSnapshot | undefined, current: PrefixSnapshot): PrefixVerdict {
    if (previous === undefined) return { status: "initial" };
    if (previous.settings !== current.settings) return { changed: "settings", status: "changed" };
    if (
      previous.system.length !== current.system.length ||
      previous.system.some((hash, index) => hash !== current.system[index])
    ) {
      return { changed: "system", status: "changed" };
    }
    // Also covers shrinkage: an absent current entry fails the strict-equality check.
    if (previous.messages.some((hash, index) => hash !== current.messages[index])) {
      return { changed: "messages", status: "changed" };
    }
    if (current.messages.length === previous.messages.length) return { status: "stable" };
    return {
      appendedMessages: current.messages.length - previous.messages.length,
      status: "append-only",
    };
  }
}
