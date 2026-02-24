---
name: grammy-bots
description: "Guides writing grammY Telegram bot handlers, middleware, and plugins. Use when creating or modifying bot commands, inline queries, callback queries, message handlers, or middleware."
---

# Writing grammY Handlers

## Handler File Structure

Each file is a `Composer` scoped to a business domain (one file per domain):

```ts
import { Composer } from "grammy";
import type { Context } from "@/types";

const composer = new Composer<Context>();

const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);

// ... handlers ...

export default composer;
```

Register on the error boundary in `src/index.ts`:

```ts
boundary.use(featureHandler);
```

## Filter Chains -- The Core Pattern

**NEVER use `if` + early-return inside handlers.** Instead, split every case into separate `.filter()` chains with mutually exclusive predicates. This applies to `.command()`, `.on()`, and all handler methods.

### Commands with validation

```ts
// CORRECT: Validation handler responds when precondition fails
privateChat.command("find").filter(
  (ctx) => ctx.message.reply_to_message?.photo === undefined,
  async (ctx) => {
    await ctx.reply("Please reply to a photo with /find command.");
  },
);

// CORRECT: Processing handler runs when precondition is met
privateChat.command("find").filter(
  (ctx) => ctx.message.reply_to_message?.photo !== undefined,
  async (ctx) => {
    // Process the photo...
  },
);
```

```ts
// WRONG: Mixed validation and processing
privateChat.command("find", async (ctx) => {
  if (!ctx.message.reply_to_message?.photo) {
    await ctx.reply("Please reply to a photo.");
    return;
  }
  // Process...
});
```

### `.on()` with `.filter()` for message routing

Use grammY's filter query language with `.on()` to narrow update types, then chain `.filter()` for custom predicates:

```ts
// Filter text messages that are URLs
feature.on(":text").filter(
  (ctx) => ctx.msg.text.startsWith("https://"),
  async (ctx) => { /* handle link */ },
);

// Filter messages by sender context
groupChat.on("message").filter(
  (ctx) => shouldReplyToMessage(ctx, ctx.message),
  async (ctx) => { /* generate AI reply */ },
);
```

### Async filter predicates (permission checks)

Filter predicates can be `async`. Use this for permission checks instead of `if` blocks:

```ts
groupChat.command("memory").filter(
  async (ctx) => {
    if (!ctx.from) return false;
    if (env.SUPERVISOR_IDS.includes(ctx.from.id)) return true;
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "administrator" || member.status === "creator";
  },
  async (ctx) => { /* authorized handler */ },
);

groupChat.command("memory").filter(
  async (ctx) => {
    if (!ctx.from) return true;
    if (env.SUPERVISOR_IDS.includes(ctx.from.id)) return false;
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status !== "administrator" && member.status !== "creator";
  },
  async (ctx) => {
    await ctx.reply("Only admins, creators, and supervisors can use this command.");
  },
);
```

### Filter chain rules

- Each handler processes **ONE case** atomically
- Predicates must be **mutually exclusive** and **exhaustive**
- Validation handlers reply with user-friendly messages
- Processing handlers assume their preconditions are met

## grammY Filter Query Language

Use the built-in filter query language to narrow update types before custom `.filter()`:

```ts
bot.on("message:text");          // only text messages
bot.on("message:photo");         // only photo messages
bot.on(":text");                 // text in messages or channel posts
bot.on("::url");                 // URL entities in text or caption
bot.on(":media");                // shortcut for photo + video
bot.on("message:is_automatic_forward"); // forwarded from linked channel
```

**Combine with AND** (chain `.on()`):
```ts
bot.on("::url").on(":forward_origin"); // forwarded messages with URLs
```

**Combine with OR** (array):
```ts
bot.on(["message", "edited_message"]); // messages or edits
```

**Filter by sender type** (chain `.filter()`):
```ts
bot.on("message").filter((ctx) => ctx.senderChat === undefined);  // regular users
bot.on("message").filter((ctx) => ctx.senderChat?.id === ctx.chat.id); // anonymous admins
```

## Inline Queries

Not scoped to chat type. Use `.filter()` to partition by query content:

```ts
composer.on("inline_query").filter(
  (ctx) => !isTwitterUrl(ctx.inlineQuery.query.trim()),
  async (ctx) => { /* handle search */ },
);

composer.on("inline_query").filter(
  (ctx) => isTwitterUrl(ctx.inlineQuery.query.trim()),
  async (ctx) => { /* handle tweet link */ },
);
```

## Callback Queries

Use regex patterns for structured callback data:

```ts
// Pattern: feature:action:params
feature.callbackQuery(/^video:(add_desc|remove_desc):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = ctx.match[1];
  const videoId = ctx.match[2];
  // Process...
});
```

## Context Type

The project composes context flavors in `src/types.ts`:

```ts
type Context = FileFlavor<HydrateFlavor<BaseContext & ExtendedContext>>;
```

`ExtendedContext` adds `logger`, `user`, `userChat`, `userChatMember`, and `currentMessageAttachments`. These are attached via middleware. Do not re-declare them.

## Separation of Concerns

- **Handlers** orchestrate: receive update, call services, reply
- **Services** compute: business logic, no grammY dependency
- **Middleware** cross-cuts: session, auth, logging

## Checklist

1. File named after business domain, exports `Composer<Context>` as default
2. Chat type scoped (`privateChat`, `groupChat`)
3. Every handler split into atomic `.filter()` chains, no `if` + early-return
4. Business logic in services, not handlers
5. Registered on error boundary

## Reference

Consult <https://grammy.dev> for unfamiliar APIs and <https://core.telegram.org/bots/api> for the Telegram Bot API.
