# Bestter's TankWars Project Guide

## Build & Development Commands

- Install dependencies: `npm install`
- Start dev server: `npm run dev`
- Build project: `npm run build`
- Run linter: `npm run lint`

## Architecture & Code Style Guidelines

- **Tech Stack:** React (functional components, hooks) + TypeScript + HTML5 Canvas.
- **State Separation:** Keep React state (turns, shop, money) strictly decoupled from the Canvas 2D high-frequency loop (physics, rendering).
- **Type Safety:** Strict TypeScript. Zero `any`. Define structural types inside `src/types/`.
- **Canvas Rendering:** Use 16-color VGA palette hex codes for assets/tanks.
- **Terrain Logic:** Implement custom destructible terrain algorithms (pixel-manipulation via `ImageData` or high-density heightmaps). Do not use external physics engines.

## AI Strategy Pattern (Crucial)

- AI controllers must implement a unified interface (`src/game/entities/ai/AIEngine.ts`).
- Phase 1 must strictly be a simple/stupid random trajectory injector to allow testing without blocking the architecture.
- Phase 2 will have much smarter AI.

## Error Prevention

- Never modify HTML5 canvas properties directly inside a React render cycle; always pass updates through refs or dedicated game engine methods.

## Commit style

- Always sign your comments by you name, and your EXACT model name for each commit.
- Use IMPERATIVE mood for commit messages.
