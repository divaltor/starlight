// Ultracite oxlint rules (applied).
import { defineConfig } from "oxlint";

import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import jsPlugins, { jsPluginSettings } from "ultracite/oxlint/js-plugins";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";
import tanstackJsPlugins from "ultracite/oxlint/tanstack/js-plugins";

export default defineConfig({
	extends: [core, react, tanstack, jsPlugins, tanstackJsPlugins, antiSlop],
	ignorePatterns: [
		...(core.ignorePatterns ?? []),
		".agent/**",
		".agents/**",
		".claude/**",
		".codex/**",
		".continue/**",
		".cursor/**",
		".gemini/**",
		".opencode/**",
		".pi/**",
		".roo/**",
		".windsurf/**",
		"apps/web/src/routeTree.gen.ts",
		// Prisma generated client must not be linted.
		"packages/utils/src/generated/**",
	],
	settings: jsPluginSettings,
	rules: {
		// Disabled because they conflict with repo conventions: function
		// declarations, non-alphabetical key order (oRPC routers), TanStack
		// router filenames, the utils barrel re-exporting Prisma, and
		// single-line guard clauses.
		"eslint/func-style": "off",
		"react/function-component-definition": "off",
		"eslint/sort-keys": "off",
		"github/filenames-match-regex": "off",
		"oxc/no-barrel-file": "off",
		"eslint/curly": "off",
		"eslint/no-use-before-define": "off",
		// React components that return children/null and server entrypoints
		// can't satisfy the camelCase function-name regex.
		"sonarjs/function-name": "off",
		// Async handling prefers `.catch()` over try/catch.
		"github/no-then": "off",
		"promise/prefer-await-to-then": "off",
		"promise/prefer-await-to-callbacks": "off",
		// Non-null assertions are the repo convention for middleware-guaranteed
		// values (`ctx.from!`) and internal invariants (lookup tables, env).
		"typescript/no-non-null-assertion": "off",
		// Idiomatic loop counters and intentionally sequential processing in
		// queues/scrapers (rate limits forbid parallel awaits in loops).
		"eslint/no-plusplus": "off",
		"eslint/no-await-in-loop": "off",
		// Misfires: fixed-size numeric arrays (DCT tables) duplicate the already
		// handled unicorn/no-new-array; `await next()` is the grammy middleware
		// idiom, not a Node-style callback; namespace imports are legit.
		"sonarjs/array-constructor": "off",
		"node/callback-return": "off",
		"sonarjs/no-wildcard-import": "off",
		// Opinionated anti-slop rules that flag valid code: a comment above
		// every type assertion and explicit named contracts like
		// `Record<Theme, ThemeColors>`. Runtime `typeof` narrowing is how env,
		// platform, and library union inputs (`string | Uint8Array`, `number |
		// undefined`) are parsed at construction boundaries.
		"anti-slop/require-safety-comment-for-type-assertion": "off",
		"anti-slop/no-known-value-widening": "off",
		"anti-slop/no-runtime-typeof": "off",
		// Manual memoization is still needed: React Compiler is not installed.
		"react-doctor/react-compiler-no-manual-memoization": "off",
		// EffectTS idioms: services define several Schema/service classes per
		// module, wrap them in `namespace Service`, pair a value with a same-name
		// type, export a module-local `Error` union, and pass anonymous
		// generators to `Effect.gen`. Static-method classes are also used as
		// namespaces for utility APIs (`Attachment.save`, `History.build`).
		"eslint/max-classes-per-file": "off",
		"typescript/no-namespace": "off",
		"eslint/func-names": "off",
		"eslint/no-redeclare": "off",
		"sonarjs/no-built-in-override": "off",
		"typescript/no-extraneous-class": "off",
		"unicorn/no-static-only-class": "off",
		// `x == null` is the deliberate nullish check for `T | null | undefined`
		// values; only loose comparisons against null are allowed.
		"eslint/no-eq-null": "off",
		"eslint/eqeqeq": ["error", "always", { null: "ignore" }],
		// Math.random is used only for retry jitter and UI randomness, never for
		// security-sensitive values.
		"sonarjs/pseudo-random": "off",
		// TODO comments track planned follow-up work on purpose.
		"sonarjs/todo-tag": "off",
		"eslint/no-warning-comments": "off",
		// shadcn/ui components export cva variant helpers next to components, and
		// forwarding React props (`onClick={action.onClick}`) is not a handler
		// naming problem.
		"react-doctor/only-export-components": "off",
		"react/jsx-handler-names": "off",
		// React Compiler cannot lower throw statements inside try/catch yet
		// (BuildHIR limitation), which flags valid existing code.
		"react/todo": "off",
	},
});
