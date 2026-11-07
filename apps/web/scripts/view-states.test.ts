import { afterAll, beforeAll, expect, test } from "bun:test";

// Run against the web dev server so client.tsx uses the real mock-env.ts Telegram environment.
// bun test apps/web/scripts/view-states.test.ts
const origin = "http://localhost:3001";
const initScript = `/tmp/starlight-view-states-${crypto.randomUUID()}.js`;
const buttonHarness = new URL(`../.view-state-buttons-${crypto.randomUUID()}.tsx`, import.meta.url);

beforeAll(async () => {
  await Bun.write(initScript, `(${installRpcFixture.toString()})()`);
  await Bun.write(
    buttonHarness,
    `
    import { createElement, useEffect } from "react";
    import { createRoot } from "react-dom/client";
    import { RouterContextProvider } from "@tanstack/react-router";
    import { mainButton, secondaryButton, emitEvent } from "@telegram-apps/sdk-react";
    import { useTelegramButtons } from "@/hooks/use-telegram-buttons";
    function Harness() {
      const manager = useTelegramButtons();
      useEffect(() => { Object.assign(window, { buttonFixture: { manager, mainButton, secondaryButton, emitEvent, clicks: 0 } }); }, [manager]);
      return null;
    }
    export function mount(router) {
      const container = document.createElement("div");
      document.body.append(container);
      createRoot(container).render(createElement(RouterContextProvider, { router }, createElement(Harness)));
    }
  `,
  );
  browser("--init-script", initScript, "open", `${origin}/app`);
}, 60_000);

afterAll(async () => {
  browser("close");
  await Bun.file(initScript).delete();
  await Bun.file(buttonHarness).delete();
});

test.each(["mainButton", "secondaryButton"] as const)(
  "test_%s_state_controls_visibility_enablement_and_actions",
  (button) => {
    browser("open", `${origin}/settings?fixture=cookies`);
    browser("wait", "#profile-visibility");
    browser("eval", `import('/${buttonHarness.pathname.split("/").at(-1)}').then(m => m.mount(window.__TSR_ROUTER__))`);
    browser("wait", "--fn", "Boolean(window.buttonFixture)");
    browser(
      "eval",
      `window.buttonFixture.manager.updateConfig({ ${button}: { state: 'visible', text: 'Fixture', action: { type: 'callback', payload: () => window.buttonFixture.clicks++ } } })`,
    );
    browser("wait", "--fn", `window.buttonFixture.${button}.isVisible() && window.buttonFixture.${button}.isEnabled()`);
    const clickEvent = button === "mainButton" ? "main_button_pressed" : "secondary_button_pressed";
    browser("eval", `window.buttonFixture.emitEvent('${clickEvent}')`);
    expect(browser("eval", "window.buttonFixture.clicks")).toBe("1");
    browser(
      "eval",
      `window.buttonFixture.manager.updateConfig({ ${button}: { state: 'disabled', text: 'Fixture', action: { type: 'callback', payload: () => window.buttonFixture.clicks++ } } })`,
    );
    browser(
      "wait",
      "--fn",
      `!window.buttonFixture.${button}.isEnabled() || !window.buttonFixture.${button}.isVisible()`,
    );
    expect(browser("eval", `window.buttonFixture.${button}.isVisible()`)).toBe("true");
    expect(browser("eval", `window.buttonFixture.${button}.isEnabled()`)).toBe("false");
    browser("eval", `window.buttonFixture.emitEvent('${clickEvent}')`);
    expect(browser("eval", "window.buttonFixture.clicks")).toBe("1");
    browser("eval", `window.buttonFixture.manager.updateConfig({ ${button}: { state: 'hidden' } })`);
    browser("wait", "--fn", `!window.buttonFixture.${button}.isVisible()`);
  },
  60_000,
);

test("test_search_failure_is_not_an_empty_result_and_keeps_search_available", () => {
  browser("open", `${origin}/app?q=broken&fixture=search-error`);
  browser("wait", "h1");
  expect(browser("eval", "document.querySelector('h1').textContent")).toBe('"Search failed"');
  expect(browser("eval", "document.body.textContent.includes('Search unavailable')")).toBe("true");
  expect(browser("eval", "document.body.textContent.includes('No search results')")).toBe("false");
  expect(browser("eval", "document.querySelector('button[type=submit]').disabled")).toBe("false");
}, 60_000);

test("test_inactive_feed_failure_does_not_replace_search_results", () => {
  browser("open", `${origin}/app?q=empty&fixture=feed-error`);
  browser("wait", "--text", "No search results");
  expect(browser("eval", "document.body.textContent.includes('Failed to load tweets')")).toBe("false");
}, 60_000);

test("test_settings_navigation_failure_is_rendered_by_the_settings_view", () => {
  browser("open", `${origin}/app?fixture=cookies`);
  browser("wait", "--text", "Your feed is empty.");
  browser("eval", "window.rpcFixture.profileError = true");
  browser("eval", "import('/src/utils/orpc.ts').then(m => m.queryClient.removeQueries({ queryKey: ['profile'] }))");
  browser("eval", "window.__TSR_ROUTER__.navigate({ to: '/settings' })");
  browser(
    "wait",
    "--fn",
    "document.body.textContent.includes('Failed to load settings') || document.body.textContent.includes('Something went wrong')",
  );
  expect(browser("eval", "document.body.textContent.includes('Failed to load settings')")).toBe("true");
}, 60_000);

test.each([
  ["cookies", "Your feed is empty.", false],
  ["no-cookies", "Set up your authentication cookies", true],
] as const)(
  "test_empty_feed_guidance_matches_%s",
  (fixture, message, offersSetup) => {
    browser("open", `${origin}/app?fixture=${fixture}`);
    browser("wait", "h1");
    expect(browser("eval", `document.body.textContent.includes(${JSON.stringify(message)})`)).toBe("true");
    expect(browser("eval", "document.body.textContent.includes('Set up your authentication cookies')")).toBe(
      String(offersSetup),
    );
  },
  60_000,
);

test.each([
  ["save", "no-cookies", "button[type=submit]", "Save unavailable"],
  ["delete", "cookies", "button:has(svg)", "Delete unavailable"],
  ["visibility", "cookies", "[role=switch]", "Visibility unavailable"],
] as const)(
  "test_settings_%s_failure_is_visible_and_pending_blocks_edits",
  (operation, fixture, selector, message) => {
    browser("open", `${origin}/settings?fixture=${fixture}`);
    browser("wait", "#profile-visibility");
    browser("eval", "window.rpcFixture.hold = true");

    if (operation === "save") browser("fill", "#new-cookies", "fixture-cookies");
    browser("click", selector);
    browser("wait", "--fn", "Boolean(window.rpcFixture.release)");
    expect(browser("eval", "document.querySelector('#profile-visibility').disabled")).toBe("true");
    expect(
      browser("eval", "Array.from(document.querySelectorAll('main button, main textarea')).every(el => el.disabled)"),
    ).toBe("true");
    browser("eval", "window.rpcFixture.release()");
    browser("wait", "--text", message);
    expect(browser("eval", "document.querySelector('#profile-visibility').disabled")).toBe("false");
  },
  60_000,
);

test("test_failed_profile_refresh_replaces_cached_settings_and_retry_recovers", () => {
  browser("open", `${origin}/settings?fixture=cookies`);
  browser("wait", "#profile-visibility");
  browser("eval", "window.rpcFixture.profileError = true");
  browser("eval", "import('/src/utils/orpc.ts').then(m => m.queryClient.invalidateQueries({ queryKey: ['profile'] }))");
  expect(browser("eval", "document.body.textContent.includes('Failed to load settings')")).toBe("true");
  expect(browser("eval", "Boolean(document.querySelector('#profile-visibility'))")).toBe("false");
  browser("eval", "window.rpcFixture.profileError = false");
  browser("find", "role", "button", "click", "--name", "Retry");
  browser("wait", "#profile-visibility");
  expect(browser("eval", "document.body.textContent.includes('Failed to load settings')")).toBe("false");
}, 60_000);

function browser(...args: string[]) {
  const result = Bun.spawnSync(["agent-browser", "--session", "view-regression", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString() + result.stdout.toString());

  return result.stdout.toString().trim();
}

function installRpcFixture() {
  const scenario = new URLSearchParams(location.search).get("fixture");

  const fixture = {
    profileError: false,
    hold: false,
    release: undefined as (() => void) | undefined,
  };

  Object.assign(window, { rpcFixture: fixture });
  const originalFetch = window.fetch;

  const failures: Record<string, string> = {
    "profiles/get": "Profile unavailable",
    "tweets/list": "Feed unavailable",
    "tweets/search": "Search unavailable",
    "cookies/save": "Save unavailable",
    "cookies/delete": "Delete unavailable",
    "profiles/visibility": "Visibility unavailable",
  };

  Object.assign(window, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);

      if (!url.pathname.startsWith("/api/rpc/")) return await originalFetch(input, init);
      const procedure = url.pathname.replace("/api/rpc/", "");

      if (procedure === "profiles/get" && !fixture.profileError) {
        return Response.json({
          json: { user: { username: "fixture", isPublic: false }, hasValidCookies: scenario !== "no-cookies" },
        });
      }

      if (procedure === "tweets/list" && scenario !== "feed-error") {
        return Response.json({ json: { tweets: [], nextCursor: null } });
      }

      if (procedure === "tweets/search" && scenario !== "search-error") {
        return Response.json({ json: { results: [], nextCursor: null } });
      }

      if (fixture.hold) {
        const pending = Promise.withResolvers<boolean>();
        fixture.release = () => {
          pending.resolve(true);
        };

        await pending.promise;
      }

      if (!failures[procedure]) throw new Error(`Unexpected fixture RPC: ${procedure}`);

      return Response.json(
        { json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: failures[procedure] } },
        { status: 500 },
      );
    },
  });
}
