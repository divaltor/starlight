# Testing

## Non-negotiable admission gate

**Do not write, propose, or generate a test before this gate passes.** First state:

> Our product must `<observable behavior>` because `<business rule, user risk, security boundary, data-loss risk, or regression in our code>`.

A test is allowed only when all are true:

1. The behavior is a repository-owned decision or invariant, including application wiring that delivers a product guarantee, not a dependency's internal behavior.
2. Failure would break a user workflow, violate a product rule, cross a security boundary, lose or corrupt data, or reproduce a real bug.
3. Replacing the underlying library with an equivalent would leave the test valuable.
4. A plausible incorrect implementation of the relevant product rule makes the test fail.

Otherwise use the library's tests, types, documentation, a focused manual check, or lint. Coverage, branch count, complexity, and changed code do not justify a test.

Do not test library validation, encryption mechanics, framework propagation or DI, runtime primitives, pass-throughs, or configured mock returns unless they protect a separately stated product rule.

## Changing existing tests

- A failing test is evidence to investigate, not an expectation to update automatically.
- Change expected outcomes only when the product requirement changes or the old expectation is demonstrably wrong. State which applies and why; the implementation's new output is not justification.
- Refactors preserve behavior assertions. Fixture or setup changes may be necessary, but must not weaken the tested guarantee.

## Rules

- Before implementation, choose how to verify the required behavior. Reuse sufficient existing coverage; apply the admission gate before adding tests.
- Test observable behavior, not internal calls, ordering, intermediate values, or generated SQL.
- Every test names the customer rule or bug class it protects. Every bug fix includes a regression test when the admission gate passes; otherwise record the focused verification used.
- Identify plausible wrong implementations and choose inputs that distinguish them from the required behavior, including both sides of a boundary where relevant. Prove the test fails for the identified mistake; otherwise rewrite or delete it.
- For behavior changes or bug fixes needing new coverage, write the smallest distinguishing test before implementation. Confirm it fails for the intended behavioral reason, not setup errors, then passes after the change.
- Prefer integration tests with real collaborators and only external boundaries mocked. Unit-test tricky owned logic; reserve e2e for critical journeys. Make journey checks repeatable and retain reviewable artifacts when useful; artifacts do not replace behavioral assertions.
- Cover each distinct failure mode at the cheapest useful level; avoid duplicate coverage of the same failure mode. A rule may need multiple cases.
- Use minimal fixtures instead of private helpers. Keep tests isolated, deterministic, order-independent, and free of shared mutable state.
- No sleeps, real clocks, or real networks. Patch real attributes, not string import paths.
- Assert specific values derived independently from the product rule, not from the implementation under test. Parametrize instead of using loops or conditionals.
- Name tests as behavior sentences: `test_<behavior>_when_<condition>`.
- Use snapshots only for formats we own.
- Keep the suite fast and non-flaky. Delete tests that stop earning their maintenance cost; fix seams rather than escalating mocks.
