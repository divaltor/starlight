---
name: grammy-bots
description: "Guides writing grammY Telegram bot handlers, middleware, and plugins. Use when creating or modifying bot commands, inline queries, callback queries, message handlers, or middleware."
---

# Writing grammY Bots

Best practices for structuring grammY Telegram bots with atomic handlers, filter-based routing, and proper plugin usage.

## Handler File Structure

Each handler file uses a `Composer` scoped to a business domain and exports it as default:

```ts
import { Composer } from "grammy";
import type { Context } from "@/types";

const composer = new Composer<Context>();

// Scope to chat type
const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);

// ... handlers ...

export default composer;
```

Register handlers on an error boundary:

```ts
const boundary = bot.errorBoundary((error) => {
  error.ctx.logger.error({ err: error.error, message: error.message });
});

boundary.use(featureHandler);
```

## Core Principles

### 1. One File Per Business Domain

Separate handlers by business domain, not by update type. Each file owns one cohesive feature area. Create a **new file** for a distinct domain; add to an existing file only if the feature clearly belongs there.

### 2. Atomic Handlers via Filter Chains

**Never mix validation and processing in a single handler.** Split into separate `.filter()` chains — one validates, one processes. This replaces early-returns inside handlers:

```ts
// ✅ CORRECT: Validation handler responds to invalid state
privateChat.command("find").filter(
  (ctx) => ctx.message.reply_to_message?.photo === undefined,
  async (ctx) => {
    await ctx.reply("Please reply to a photo with /find command.");
  },
);

// ✅ CORRECT: Processing handler only runs when valid
privateChat.command("find").filter(
  (ctx) => ctx.message.reply_to_message?.photo !== undefined,
  async (ctx) => {
    // Process the photo...
  },
);
```

```ts
// ❌ WRONG: Mixed validation and processing
privateChat.command("find", async (ctx) => {
  if (!ctx.message.reply_to_message?.photo) {
    await ctx.reply("Please reply to a photo.");
    return;
  }
  // Process...
});
```

**Rules:**

- Each handler atomically processes ONE case
- Filter predicates must be **mutually exclusive** and **exhaustive**
- Validation handlers reply with user-friendly error messages
- Processing handlers assume their preconditions are met
- Filter predicates can be `async` (e.g., checking session state)

### 3. Chat Type Scoping

Always scope handlers to their target chat type:

```ts
const privateChat = composer.chatType("private");
const groupChat = composer.chatType(["group", "supergroup"]);
const allChats = composer.chatType(["private", "group", "supergroup"]);
```

### 4. Use grammY Plugins

Prefer official grammY plugins over manual implementations:

| Plugin           | Package                      | Purpose                                                    |
| ---------------- | ---------------------------- | ---------------------------------------------------------- |
| Auto-retry       | `@grammyjs/auto-retry`       | Transformer — automatic rate limit retry                   |
| Files            | `@grammyjs/files`            | Transformer — download files from `getFile()`              |
| Hydrate          | `@grammyjs/hydrate`          | Context flavor — methods on API return objects             |
| Parse Mode       | `@grammyjs/parse-mode`       | Transformer — default parse mode + `ctx.replyWithHTML()`   |
| Router           | `@grammyjs/router`           | Route updates based on session state                       |
| Runner           | `@grammyjs/runner`           | Concurrent long polling at scale                           |
| Rate Limiter     | `@grammyjs/ratelimiter`      | Middleware — dismiss excess user requests (supports Redis) |
| Auto Chat Action | `@grammyjs/auto-chat-action` | Middleware — auto "typing...", "uploading..." indicators   |
| Conversations    | `@grammyjs/conversations`    | Complex multi-step dialog flows                            |
| Menu             | `@grammyjs/menu`             | Dynamic interactive button menus                           |

**When to reach for a plugin:**

- **Rate limiting users** → `@grammyjs/ratelimiter` with Redis instead of manual rate-limiter libraries
- **HTML/Markdown formatting** → `@grammyjs/parse-mode` transformer so you don't pass `parse_mode` on every call
- **Multi-step flows** → `@grammyjs/router` for session-based routing, or `@grammyjs/conversations` for dialogs
- **Upload indicators** → `@grammyjs/auto-chat-action` instead of manual `replyWithChatAction()`

### 5. Context Type Safety

Compose context types using grammY flavors:

```ts
import type { Context as BaseContext, SessionFlavor } from "grammy";
import type { FileFlavor } from "@grammyjs/files";
import type { HydrateFlavor } from "@grammyjs/hydrate";
import type { ParseModeFlavor } from "@grammyjs/parse-mode";

type MyContext = FileFlavor<
  HydrateFlavor<
    ParseModeFlavor<BaseContext & CustomProps & SessionFlavor<SessionData>>
  >
>;
```

When adding new context properties, define them in a dedicated type and attach via middleware.

### 6. Inline Queries

Inline queries are not scoped to chat type. Use `.filter()` to partition by query content:

```ts
composer.on("inline_query").filter(
  (ctx) => isSpecialQuery(ctx.inlineQuery.query.trim()),
  async (ctx) => {
    /* handle special case */
  },
);

composer.on("inline_query").filter(
  (ctx) => !isSpecialQuery(ctx.inlineQuery.query.trim()),
  async (ctx) => {
    /* handle default case */
  },
);
```

### 7. Callback Queries

Use regex patterns for callback data with structured metadata:

```ts
// Pattern: feature:action:id:param:ownerId
composer.callbackQuery(/^feature:action:(\w+):(\w+):(\d+)$/, async (ctx) => {
  const id = ctx.match.at(1)!;
  const param = ctx.match.at(2)!;
  const ownerId = ctx.match.at(3)!;

  // Ownership check
  if (ctx.from.id !== Number(ownerId)) {
    await ctx.answerCallbackQuery({
      text: "Only the requester can use this button",
      show_alert: true,
    });
    return;
  }

  // Process...
});
```

### 8. Error Handling

- Let the error boundary catch unhandled errors
- Handle **expected** errors (like `GrammyError` for missing permissions) locally
- Re-throw unexpected errors

```ts
try {
  await ctx.deleteMessage();
} catch (error) {
  if (error instanceof GrammyError) {
    ctx.logger.debug({ error: error.message }, "Could not delete message");
  } else {
    throw error;
  }
}
```

### 9. Separation of Concerns

- **Handlers** orchestrate: receive update → call services → reply
- **Services** compute: pure business logic, no grammY dependency
- **Middleware** cross-cuts: session, auth, logging, rate limiting

## Checklist for New Handlers

1. Create a file named after the business domain
2. Use `Composer<Context>` with chat type scoping
3. Split every command into atomic filter chains (validation → processing)
4. Register on the error boundary
5. Keep business logic in services — handlers orchestrate, not compute
6. Use grammY plugins instead of reimplementing common patterns
7. Use structured logging with context fields

## Reference

If something falls outside the scope of this skill or you encounter an unfamiliar grammY API, consult the official documentation at <https://grammy.dev> for examples, plugin guides, and API reference from Telegram (<https://core.telegram.org/bots/api>).
