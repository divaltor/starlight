# Testing

## Non-negotiable admission gate

**Do not write, propose, or generate a test before this gate passes.** First state:

> Our product must `<observable behavior>` because `<business rule, user risk, security boundary, data-loss risk, or regression in our code>`.

A test is allowed only when all are true:

1. The behavior is a repository-owned decision or invariant, not dependency, framework, validator, database, language, or runtime behavior.
2. Failure would break a user workflow, violate a product rule, cross a security boundary, lose or corrupt data, or reproduce a real bug.
3. Replacing the underlying library with an equivalent would leave the test valuable.
4. Mutating the relevant business logic makes the test fail.

Otherwise use the library's tests, types, documentation, a focused manual check, or lint. Coverage, branch count, complexity, and changed code do not justify a test.

Do not test library validation, encryption mechanics, framework propagation or DI, runtime primitives, pass-throughs, or configured mock returns unless they protect a separately stated product rule.

## Rules

- Test observable behavior, not internal calls, ordering, intermediate values, or generated SQL.
- Every test names the customer rule or bug class it protects. Every bug fix includes its regression test.
- Prove the test fails when the behavior is broken; otherwise rewrite or delete it.
- Prefer integration tests with real collaborators and only external boundaries mocked. Unit-test tricky owned logic; reserve e2e for critical journeys.
- Test each rule once at the cheapest useful level. One behavior and equivalence class per test.
- Use minimal fixtures instead of private helpers. Keep tests isolated, deterministic, order-independent, and free of shared mutable state.
- No sleeps, real clocks, or real networks. Patch real attributes, not string import paths.
- Assert specific values. Parametrize instead of using loops or conditionals.
- Name tests as behavior sentences: `test_<behavior>_when_<condition>`.
- Use snapshots only for formats we own.
- Keep the suite fast and non-flaky. Delete tests that stop earning their maintenance cost; fix seams rather than escalating mocks.
