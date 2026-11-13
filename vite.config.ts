import { defineConfig, type Plugin } from 'vite';
import type { Server as HttpServer } from 'node:http';
import { attachOnlineLobby } from './server/online-lobby';

function tankArenaOnlineLobby(): Plugin {
  return {
    name: 'tank-arena-online-lobby',
    configureServer(server) {
      if (process.env.TANK_ARENA_WRANGLER_DEV === '1') return;
      if (server.httpServer) attachOnlineLobby(server.httpServer as unknown as HttpServer);
    },
    configurePreviewServer(server) {
      if (process.env.TANK_ARENA_WRANGLER_DEV === '1') return;
      attachOnlineLobby(server.httpServer as unknown as HttpServer);
    }
  };
}

const wranglerProxy = process.env.TANK_ARENA_WRANGLER_DEV === '1';
const localPagesTarget = 'http://127.0.0.1:8788';
const localPagesProxy = {
  target: localPagesTarget,
  changeOrigin: true,
  configure(proxy: { on: (event: string, listener: (request: { setHeader: (name: string, value: string) => void }) => void) => void }) {
    const rewriteOrigin = (request: { setHeader: (name: string, value: string) => void }) => request.setHeader('Origin', localPagesTarget);
    proxy.on('proxyReq', rewriteOrigin);
    proxy.on('proxyReqWs', rewriteOrigin);
  }
};

export default defineConfig({
  server: {
    host: true,
    ...(wranglerProxy ? { proxy: {
      '/api/account': localPagesProxy,
      '/__tank_arena_online': { ...localPagesProxy, ws: true }
    } } : {})
  },
  preview: { host: true },
  plugins: [tankArenaOnlineLobby()]
});
