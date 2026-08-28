import { expect, test } from "bun:test";
import { CacheDiagnostics } from "@/context/cache-diagnostics";

const base: CacheDiagnostics.PrefixSnapshot = {
  messages: ["m1", "m2", "m3"],
  settings: "model-x:high:false",
  system: ["envelope-1", "memory-1"],
};

test("reports_initial_when_no_previous_snapshot_exists", () => {
  expect(CacheDiagnostics.comparePrefix(undefined, base)).toEqual({ status: "initial" });
});

test("reports_stable_when_snapshots_are_identical", () => {
  expect(CacheDiagnostics.comparePrefix(base, { ...base, messages: [...base.messages] })).toEqual({ status: "stable" });
});

test("reports_append_only_with_count_when_messages_grow_at_the_tail", () => {
  const current = { ...base, messages: [...base.messages, "m4"] };
  expect(CacheDiagnostics.comparePrefix(base, current)).toEqual({ appendedMessages: 1, status: "append-only" });
});

test("reports_changed_messages_when_an_existing_message_hash_is_replaced", () => {
  const current = { ...base, messages: ["m1", "m9", "m3"] };
  expect(CacheDiagnostics.comparePrefix(base, current)).toEqual({ changed: "messages", status: "changed" });
});

test("reports_changed_messages_when_history_shrinks", () => {
  const current = { ...base, messages: ["m1"] };
  expect(CacheDiagnostics.comparePrefix(base, current)).toEqual({ changed: "messages", status: "changed" });
});

test("reports_changed_system_before_messages_when_both_drift", () => {
  const current = { ...base, messages: [...base.messages, "m4"], system: ["envelope-2", "memory-1"] };
  expect(CacheDiagnostics.comparePrefix(base, current)).toEqual({ changed: "system", status: "changed" });
});

test("reports_changed_settings_when_model_profile_moves", () => {
  const current = { ...base, settings: "model-y:high:false" };
  expect(CacheDiagnostics.comparePrefix(base, current)).toEqual({ changed: "settings", status: "changed" });
});
