# UI/UX Refactor Requirements

## 1. Executive Summary

The `prime-silo` interface currently operates as a highly fragmented utility, presenting as an aggregation of disconnected modules rather than a cohesive, centralized platform. While architecturally modular, the UI lacks systemic visual logic and spatial orientation, directly increasing user cognitive load. Conversely, the `memo-ray` project establishes a high benchmark for top-tier visual craft—leveraging an organic color token system, isometric data visualization, and calming spatial relationships—providing an ideal target aesthetic to unify and elevate `prime-silo`.

## 2. Critical Usability & Design Violations

| Severity | Category                 | Issue Description & Heuristic Violated                                                                                                                                                                                             | Context / Impact on User                                                                                               |
| :------: | :----------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
|    3     | Information Architecture | **Fragmented User Flows:** Navigation paths and visual elements in `prime-silo` feel disconnected and stitched together without a unified App Shell or consistent mental model.                                                    | Users suffer severe spatial disorientation and increased cognitive load as they transition between disjointed modules. |
|    3     | Visual Craft             | **Flattened Spatial Hierarchy:** `prime-silo` enforces strict flattening (`box-shadow: none !important`), removing crucial depth cues that users rely on to distinguish interactive surfaces from backgrounds.                     | Prevents users from quickly scanning the interface, causing hesitation and friction.                                   |
|    3     | Conversion & Onboarding  | **Login Aesthetic Dissonance:** The `login.html` screen utilizes heavy space-themed visual language (gradients, stars) that directly conflicts with the organic, grounded aesthetic (`memo-ray`) desired for the core application. | Breaks the continuity of the user journey. The abrupt transition creates brand dissonance.                             |
|    2     | Interaction Design       | **Static Mascot:** The floating German Shepherd mascot (`onscreen-agent`) is entirely static except for a CSS orbit. It fails to provide micro-interaction feedback.                                                               | A lifeless avatar fails to build trust or indicate system state.                                                       |

## 3. Required Actionable Remediation

### Dissonant Login Screen

- **The Fix:** Refactor the login screen to adopt the `memo-ray` aesthetic.
  1. Strip out the space gradients and adopt the deep organic palette (`--bg-deep: #151816`, Sage accents).
  2. Introduce the "Zen Mode" framing for the login box.

### Lifeless Mascot (Missing Micro-Animations)

- **The Fix:** Implement CSS keyframe animations for the dog.
  1. Add an "idle" CSS keyframe animation (subtle breathing/scaling and ear twitches/floating).
  2. Implement state-based CSS classes (e.g., `.is-listening`, `.is-processing`) that trigger specific animations.

### Flattened Spatial Hierarchy

- **The Fix:** Reintroduce spatial elevation mapping by adopting `memo-ray`'s design tokens.
  1. Remove the global `!important` shadow overrides in `prime-silo/app/L0/_all/mod/_core/visual/index.css`.
  2. Import the `memo-ray` organic design tokens.
