## Skills

- When editing UI, apply the `frontend-design` skill (visual craft, layout hierarchy) and `vercel-react-best-practices` (rendering and bundle performance).

## Interface system

- Build screens from the shadcn/ui primitives in `src/components/ui/*`. Do not hand-roll controls, cards, menus, dialogs, or empty states.
- Each view has one clear focal action. Include loading, empty, error, hover, focus, active, and disabled states where applicable.
- Color communicates state; keep surfaces quiet.

## Motion

- Predetermined state changes (hover, popover, dialog): 150–250ms with a strong ease-out curve. Never `ease-in`, never `transition: all`.
- Gesture-driven motion (drag, swipe, sheet): springs, `bounce: 0` by default; bounce ≤ 0.2 only when the gesture carried momentum.
- Never animate keyboard-initiated or high-frequency actions.
- Enter and exit along the same path; exit faster than enter.
- Pressables ship `:active { transform: scale(0.97) }` in the `ui` primitives — once, not per screen.
- With `prefers-reduced-motion`, cross-fade instead of movement.

## Telegram

- All Telegram access goes through `@telegram-apps/sdk-react`. No direct `window.Telegram.WebApp` usage.
- Before writing any Telegram helper, check the SDK first. Implement only what it does not cover — in practice this is almost never needed.
