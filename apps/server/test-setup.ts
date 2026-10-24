// bun test sets NODE_ENV=test, so env validation is skipped. Modules in the
// handler import graph still read these values at import time.
process.env.BOT_TOKEN ??= "123:test";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
