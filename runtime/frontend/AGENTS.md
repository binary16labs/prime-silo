# Frontend & AgentAmp Directives (frontend/AGENTS.md)

This directory contains the React 19, Vite, and Three.js frontend for Benny's Studio and AgentAmp cockpit.

## Ownership and Architecture
- The frontend is deeply skinnable via AgentAmp.
- We avoid hardcoded styles where a skin token should be used instead.
- The UI listens heavily to SSE (Server-Sent Events) for real-time swarm activity, token streams, and telemetry.

## Implementation Rules
1. **AgentAmp First**: All new UI components must support `.aamp` skin packs. Use design tokens from the active theme rather than hardcoding hex values.
2. **WebGL/Three.js**: Visualizers (AgentVis plugins) run in sandboxed contexts. Do not introduce egress or allow plugins to leak the host DOM.
3. **Component Structure**: Follow functional component patterns with React Hooks. 
4. **State Management**: Keep local state localized. Use global state only for true cross-cutting concerns (like the active Swarm Manifest or active Skin).
