# ADR-004: Adopt Memo-Ray Aesthetic

## Status

Accepted

## Context

The `prime-silo` project's UI has evolved organically resulting in a fragmented presentation tier with inconsistent depth physics (aggressive anti-shadow CSS resets) and dissonant visual themes (e.g., sci-fi/space themed login screens versus standard dashboard elements). In contrast, the `memo-ray` project successfully implements a highly cohesive, organic "Zen Mode" aesthetic utilizing an earth-tone color palette (Sage, Moss, Taupe, Slate) and purposeful spatial hierarchy. This fragmentation in `prime-silo` increases cognitive load and causes spatial disorientation for users.

## Decision

We will adopt the `memo-ray` design aesthetic as the canonical visual language for `prime-silo`.
This entails:

1. **Design Tokens Migration:** Porting the organic color palette (`--sage`, `--moss`, `--taupe`, `--bg-deep`, etc.) into `prime-silo`'s core visual CSS.
2. **Restoring Spatial Depth:** Removing aggressive `box-shadow: none !important` rules globally to allow surfaces (cards, popovers, modals) to express elevation naturally.
3. **Harmonizing Entry Points:** Refactoring `login.html` and other public entry pages to replace their legacy space themes with the unified Zen Mode background and organic styling.
4. **Active Mascot Micro-Interactions:** Upgrading the static onscreen agent (German Shepherd) with CSS animations (idle breathing, active states) to accurately reflect system visibility and improve trust.

## Consequences

- **Positive:** Drastically improved visual consistency across the platform. Reduced cognitive load for users. Better onboarding flow without aesthetic dissonance.
- **Negative:** Some existing `prime-silo` components may look temporarily unpolished or "lifted" due to the sudden reintroduction of global shadows, requiring iterative targeted adjustments to specific components.
