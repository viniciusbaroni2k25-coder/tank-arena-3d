# Tank Arena

Browser-based 3D tank arena with local bot matches and WebSocket multiplayer rooms.

## Development

```sh
npm install
npm run dev
```

Vite serves the client and the local WebSocket lobby together. The lobby is for development/LAN play; production uses Cloudflare Pages Functions and a Durable Object.

## Cloudflare deployment

The Pages site is configured in the root `wrangler.jsonc`. The separate WebSocket lobby Worker and its SQLite-backed Durable Object are in `cloudflare/`.

```sh
npm run build
npx --yes --package=node@22 -c 'node ./node_modules/wrangler/bin/wrangler.js login'
npx wrangler pages project create tank-arena --production-branch main
npm run deploy
```

The Pages Function proxies `/__tank_arena_online` to a single global Durable Object. The client uses the same-origin WebSocket URL, so no secret or production URL is embedded in the frontend. OAuth credentials stay in Wrangler's local config and must never be committed.

No custom domain or paid Cloudflare feature is required; Pages provides a `pages.dev` address. Verify current account limits and project bindings in Cloudflare before production deployment.
