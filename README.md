# Tank Arena

Browser-based 3D tank arena with local bot matches and WebSocket multiplayer rooms.

## Development

```sh
npm install
npm run dev
```

`npm run dev` builds the client, starts local Workers/Pages with a Durable Object, then starts Vite on port 5173. Account signup, login, recovery codes, ranking, and authenticated multiplayer all work through the same local address. Use Ctrl+C to stop the whole stack. Production uses the same Pages Function and Durable Object routes.

## Cloudflare deployment

The Pages site and its production Durable Object binding are configured in the root `wrangler.toml`. The separate WebSocket lobby Worker and its SQLite-backed Durable Object are in `cloudflare/`.

```sh
npm run build
npx --yes --package=node@22 -c 'node ./node_modules/wrangler/bin/wrangler.js login'
npx wrangler pages project create tank-arena --production-branch main
npm run deploy
```

The Pages Function proxies `/__tank_arena_online` to a single global Durable Object. The client uses the same-origin WebSocket URL, so no secret or production URL is embedded in the frontend. OAuth credentials stay in Wrangler's local config and must never be committed.

No custom domain or paid Cloudflare feature is required; Pages provides a `pages.dev` address. Verify current account limits and project bindings in Cloudflare before production deployment.
