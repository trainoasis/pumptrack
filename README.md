# Pumptrack

A tiny-wings-style web game. Ride rolling hills, pump the downhills, launch off the crests. Canvas 2D + TypeScript, no game engine.

Live: https://pumptrack-two.vercel.app

## Run locally

```
npm install
npm run dev
```

## Build

```
npm run build      # minified bundle in dist/
npm run typecheck  # tsc --noEmit
```

Deploys to Vercel automatically on push to `main` once the GitHub integration is connected, or manually with `npx vercel@latest --prod`.

## TODO

- Add Supabase + leaderboard on ESC key
- Redesign to use a BIKER sprite instead of a ball
- Add funky sounds
- Define game goal — when do you "die"? when do you "win"?
- Explore bots to play against (shadow-rider style) — fun, useful, or not?
- Explore a multiplayer version
