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

## Auditing existing tests

- Inspect the complete test, its production owner and callers, overlapping coverage, and relevant history before judging its value.
- Before deletion, record the test's name and location, the failure it can actually detect, and the stronger remaining proof—or why the contract no longer needs coverage. Name the risk and focused validation command. Uncertainty means investigate, not delete.
- Static or slow tests are not inherently low-value. Retain independent checks of contracts that pass the admission gate, including source inspection when it is the cheapest guard and survives identifier-only refactoring.
- Investigate retained tests that fail on the baseline as possible product bugs; do not delete them to make checks pass.
- Remove obsolete test-only seams and dead paths only after checking non-test callers. Keep each audit focused on one coherent production owner; optimize for confidence, not deletion count.

## Rules

- Before implementation, choose how to verify the required behavior. Reuse sufficient existing coverage; apply the admission gate before adding tests.
- Test observable behavior, not internal calls, internal ordering, intermediate values, or generated SQL. Assert ordering when it is observable behavior, such as acknowledging work only after durable persistence.
- Every test names the customer rule or bug class it protects. Every bug fix includes a regression test when the admission gate passes; otherwise record the focused verification used.
- Identify plausible wrong implementations and choose inputs that distinguish them from the required behavior, including both sides of a boundary where relevant. Prove the test fails for the identified mistake; otherwise rewrite or delete it.
- For behavior changes or bug fixes needing new coverage, write the smallest distinguishing test before implementation. Confirm it fails for the intended behavioral reason, not setup errors, then passes after the change.
- Prefer integration tests with real collaborators and only external boundaries mocked. Unit-test tricky owned logic; reserve e2e for critical journeys. Make journey checks repeatable and retain reviewable artifacts when useful; artifacts do not replace behavioral assertions.
- Before adding coverage, name the missing failure mode and why existing tests cannot catch it. Give each contract one primary test owner at the cheapest useful boundary; another layer must protect a distinct risk. Extend existing parametrized cases instead of duplicating scenarios or setup. A rule may need multiple cases.
- Do not introduce production exports, flags, wrappers, or injection hooks solely for tests; exercise the real boundary instead.
- Use minimal fixtures instead of private helpers. Keep tests isolated, deterministic, order-independent, and free of shared mutable state.
- Mocks and fixtures must not supply the decisions, ordering, or persisted state the production owner should produce. Assert persistence against the store the path actually writes. Negative cases must fail through the intended guard, not an unrelated rejection.
- No sleeps, real clocks, or real networks. Patch real attributes, not string import paths.
- Assert specific values derived independently from the product rule, not from the implementation under test. Parametrize instead of using loops or conditionals.
- Name tests as behavior sentences: `test_<behavior>_when_<condition>`.
- Use snapshots only for formats we own.
- Keep the suite fast and non-flaky. Delete tests that stop earning their maintenance cost; fix seams rather than escalating mocks.
