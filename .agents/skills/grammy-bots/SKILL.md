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
  async (ctx) => {
    /* handle link */
  },
);

// Filter messages by sender context
groupChat.on("message").filter(
  (ctx) => shouldReplyToMessage(ctx, ctx.message),
  async (ctx) => {
    /* generate AI reply */
  },
);
```

### Filter chain rules

- Each handler processes **ONE case** atomically
- Predicates must be **mutually exclusive** and **exhaustive**
- Validation handlers reply with user-friendly messages
- Processing handlers assume their preconditions are met

## grammY Filter Query Language

Examples at <https://grammy.dev/guide/filter-queries>

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

1. Chat type scoped (`privateChat`, `groupChat`)
2. Every handler split into atomic `.filter()` chains, no `if` + early-return
3. Business logic in services, not handlers
4. Registered on error boundary

## Reference

Consult <https://grammy.dev> for unfamiliar APIs and <https://core.telegram.org/bots/api> for the Telegram Bot API.
