import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

type Mode = 'ctf' | 'deathmatch' | 'ffa' | 'survival';
type Room = {
  id: string;
  name: string;
  mode: Mode;
  map: string;
  lighting: 'day' | 'night';
  maxPlayers: number;
  createdAt: number;
  players: Map<string, Client>;
};
type Client = { id: string; name: string; ws: WebSocket; roomId: string | null; team: 'black' | 'white'; lastStateAt: number };

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
let attachedServers = new WeakSet<HttpServer>();

function send(client: Client, payload: unknown) {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
}
function roomSummary(room: Room) {
  return { id: room.id, name: room.name, mode: room.mode, map: room.map, lighting: room.lighting, maxPlayers: room.maxPlayers, players: room.players.size };
}
function publishRooms() {
  const payload = { type: 'rooms', rooms: [...rooms.values()].map(roomSummary) };
  for (const client of clients.values()) send(client, payload);
}
function leaveRoom(client: Client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) { client.roomId = null; return; }
  room.players.delete(client.id);
  for (const peer of room.players.values()) send(peer, { type: 'player-left', playerId: client.id });
  if (room.players.size === 0) rooms.delete(room.id);
  client.roomId = null;
  publishRooms();
}
function safeMode(value: unknown): Mode {
  return value === 'deathmatch' || value === 'ffa' || value === 'survival' ? value : 'ctf';
}
function safeMap(value: unknown): string {
  const valid = new Set(['field', 'desert', 'industrial', 'canyon', 'snow', 'harbor', 'volcano', 'metropolis', 'swamp', 'moon']);
  return typeof value === 'string' && valid.has(value) ? value : 'harbor';
}
function handleMessage(client: Client, data: any) {
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'create-room') {
    leaveRoom(client);
    let id = Math.random().toString(36).slice(2, 8).toUpperCase();
    while (rooms.has(id)) id = Math.random().toString(36).slice(2, 8).toUpperCase();
    const room: Room = {
      id,
      name: typeof data.name === 'string' ? data.name.trim().slice(0, 28) || 'Arena de treino' : 'Arena de treino',
      mode: safeMode(data.mode), map: safeMap(data.map), lighting: data.lighting === 'night' ? 'night' : 'day',
      maxPlayers: Math.max(2, Math.min(10, Number(data.maxPlayers) || 6)), createdAt: Date.now(), players: new Map()
    };
    rooms.set(id, room);
    client.team = 'black';
    room.players.set(client.id, client);
    client.roomId = id;
    send(client, { type: 'room-joined', room: roomSummary(room), you: client.id, youTeam: client.team, players: [] });
    publishRooms();
    return;
  }
  if (data.type === 'join-room') {
    const id = typeof data.roomId === 'string' ? data.roomId.toUpperCase() : '';
    const room = rooms.get(id);
    if (!room) { send(client, { type: 'join-error', message: 'Essa sala não existe mais.' }); publishRooms(); return; }
    if (!room.players.has(client.id) && room.players.size >= room.maxPlayers) { send(client, { type: 'join-error', message: 'A sala está cheia.' }); return; }
    leaveRoom(client);
    const existing = [...room.players.values()].map(peer => ({ id: peer.id, name: peer.name, team: peer.team }));
    client.team = room.players.size % 2 === 0 ? 'black' : 'white';
    room.players.set(client.id, client);
    client.roomId = id;
    send(client, { type: 'room-joined', room: roomSummary(room), you: client.id, youTeam: client.team, players: existing });
    for (const peer of room.players.values()) if (peer.id !== client.id) send(peer, { type: 'player-joined', player: { id: client.id, name: client.name, team: client.team } });
    publishRooms();
    return;
  }
  const room = client.roomId ? rooms.get(client.roomId) : undefined;
  if (!room) return;
  if (data.type === 'leave-room') { leaveRoom(client); return; }
  if (data.type === 'player-state') {
    const now = Date.now();
    if (now - client.lastStateAt < 45) return;
    client.lastStateAt = now;
    const state = data.state;
    if (!state || ![state.x, state.y, state.z, state.rotation, state.turret].every(Number.isFinite)) return;
    const safeState = {
      x: Math.max(-64, Math.min(64, state.x)), y: Math.max(0, Math.min(5, state.y)), z: Math.max(-64, Math.min(64, state.z)),
      rotation: state.rotation, turret: state.turret,
      team: client.team,
      tankClass: typeof state.tankClass === 'string' ? state.tankClass.slice(0, 16) : 'medium',
      health: Number.isFinite(state.health) ? Math.max(0, Math.min(200, state.health)) : 100,
      alive: state.alive !== false
    };
    for (const peer of room.players.values()) if (peer.id !== client.id) send(peer, { type: 'player-state', player: { id: client.id, name: client.name, ...safeState } });
    return;
  }
  if (data.type === 'fire') {
    const shot = data.shot;
    if (!shot || ![shot.x, shot.y, shot.z, shot.dx, shot.dy, shot.dz].every(Number.isFinite)) return;
    const tankClass = ['light', 'medium', 'heavy', 'artillery', 'scout', 'assault'].includes(shot.tankClass) ? shot.tankClass : 'medium';
    const weapon = ['cannon', 'rapid', 'mortar', 'plasma', 'ricochet'].includes(shot.weapon) ? shot.weapon : 'cannon';
    const safeShot = { x: shot.x, y: shot.y, z: shot.z, dx: shot.dx, dy: shot.dy, dz: shot.dz, tankClass, weapon, damage: Number.isFinite(shot.damage) ? Math.max(0.1, Math.min(40, shot.damage)) : 2 };
    for (const peer of room.players.values()) if (peer.id !== client.id) send(peer, { type: 'player-fire', playerId: client.id, team: client.team, shot: safeShot });
    return;
  }
  if (data.type === 'hit') {
    const target = typeof data.targetId === 'string' ? room.players.get(data.targetId) : undefined;
    const hit = data.hit;
    if (!target || target.id === client.id || !hit || !Number.isFinite(hit.damage) || hit.damage <= 0 || hit.damage > 100) return;
    const direction = hit.direction;
    if (!direction || ![direction.x, direction.y, direction.z].every(Number.isFinite)) return;
    send(target, { type: 'remote-hit', damage: hit.damage, direction });
  }
}

export function attachOnlineLobby(httpServer: HttpServer) {
  if (attachedServers.has(httpServer)) return;
  attachedServers.add(httpServer);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32_000 });
  httpServer.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { return; }
    if (pathname !== '/__tank_arena_online') return;
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', ws => {
    const id = Math.random().toString(36).slice(2, 10);
    const client: Client = { id, name: `Comandante ${id.slice(0, 4).toUpperCase()}`, ws, roomId: null, team: 'black', lastStateAt: 0 };
    clients.set(id, client);
    send(client, { type: 'welcome', playerId: id, rooms: [...rooms.values()].map(roomSummary) });
    ws.on('message', raw => {
      try { handleMessage(client, JSON.parse(raw.toString())); } catch { send(client, { type: 'error', message: 'Mensagem inválida.' }); }
    });
    ws.on('close', () => { leaveRoom(client); clients.delete(client.id); publishRooms(); });
    ws.on('error', () => { leaveRoom(client); clients.delete(client.id); publishRooms(); });
  });
}
