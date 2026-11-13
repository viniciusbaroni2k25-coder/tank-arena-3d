import { defineConfig, type Plugin } from 'vite';
import type { Server as HttpServer } from 'node:http';
import { attachOnlineLobby } from './server/online-lobby';

function tankArenaOnlineLobby(): Plugin {
  return {
    name: 'tank-arena-online-lobby',
    configureServer(server) {
      if (server.httpServer) attachOnlineLobby(server.httpServer as unknown as HttpServer);
    },
    configurePreviewServer(server) {
      attachOnlineLobby(server.httpServer as unknown as HttpServer);
    }
  };
}

export default defineConfig({
  server: { host: true },
  preview: { host: true },
  plugins: [tankArenaOnlineLobby()]
});
