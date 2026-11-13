export interface Env {}

type Mode = 'ctf' | 'deathmatch' | 'ffa' | 'survival';
type Team = 'black' | 'white';
type Room = {
  id: string;
  name: string;
  mode: Mode;
  map: string;
  lighting: 'day' | 'night';
  maxPlayers: number;
  players: string[];
};
type Client = {
  id: string;
  name: string;
  roomId: string | null;
  team: Team;
  lastStateAt: number;
};

const validMaps = new Set(['field', 'desert', 'industrial', 'canyon', 'snow', 'harbor', 'volcano', 'metropolis', 'swamp', 'moon']);
const validClasses = new Set(['light', 'medium', 'heavy', 'artillery', 'scout', 'assault']);
const validWeapons = new Set(['cannon', 'rapid', 'mortar', 'plasma', 'ricochet']);

export class GameLobby {
  private rooms = new Map<string, Room>();
  private ready: Promise<void>;
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.ready = state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get<Room[]>('rooms');
      this.rooms = new Map((saved ?? []).map(room => [room.id, room]));
      // Drop stale members left behind by a hibernation or a terminated socket.
      const connected = new Set(state.getWebSockets().map(socket => this.client(socket).id));
      for (const room of this.rooms.values()) room.players = room.players.filter(id => connected.has(id));
      await this.saveRooms();
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ service: 'tank-arena-lobby', status: 'online' });
    }
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const client: Client = { id, name: `Comandante ${id.slice(0, 4).toUpperCase()}`, roomId: null, team: 'black', lastStateAt: 0 };
    serverSocket.serializeAttachment(client);
    this.state.acceptWebSocket(serverSocket, [id]);
    this.send(serverSocket, { type: 'welcome', playerId: id, rooms: [...this.rooms.values()].map(room => this.summary(room)) });
    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ready;
    let data: any;
    try { data = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); }
    catch { this.send(socket, { type: 'error', message: 'Mensagem inválida.' }); return; }
    if (!data || typeof data.type !== 'string') return;
    const client = this.client(socket);

    if (data.type === 'create-room') {
      await this.leaveRoom(socket, client);
      let id = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
      while (this.rooms.has(id)) id = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
      const room: Room = {
        id,
        name: typeof data.name === 'string' ? data.name.trim().slice(0, 28) || 'Arena de treino' : 'Arena de treino',
        mode: this.safeMode(data.mode),
        map: typeof data.map === 'string' && validMaps.has(data.map) ? data.map : 'harbor',
        lighting: data.lighting === 'night' ? 'night' : 'day',
        maxPlayers: Math.max(2, Math.min(10, Number(data.maxPlayers) || 6)),
        players: [client.id]
      };
      this.rooms.set(id, room);
      client.roomId = id;
      client.team = 'black';
      this.updateClient(socket, client);
      await this.saveRooms();
      this.send(socket, { type: 'room-joined', room: this.summary(room), you: client.id, youTeam: client.team, players: [] });
      this.publishRooms();
      return;
    }

    if (data.type === 'join-room') {
      const id = typeof data.roomId === 'string' ? data.roomId.toUpperCase() : '';
      const room = this.rooms.get(id);
      if (!room) { this.send(socket, { type: 'join-error', message: 'Essa sala não existe mais.' }); this.publishRooms(); return; }
      if (!room.players.includes(client.id) && room.players.length >= room.maxPlayers) {
        this.send(socket, { type: 'join-error', message: 'A sala está cheia.' });
        return;
      }
      const alreadyInside = client.roomId === id;
      if (!alreadyInside) await this.leaveRoom(socket, client);
      const existing = room.players.filter(playerId => playerId !== client.id).map(playerId => {
        const peerSocket = this.socketFor(playerId);
        if (!peerSocket) return null;
        const peer = this.client(peerSocket);
        return { id: peer.id, name: peer.name, team: peer.team };
      }).filter(Boolean);
      if (!alreadyInside) client.team = room.players.length % 2 === 0 ? 'black' : 'white';
      if (!room.players.includes(client.id)) room.players.push(client.id);
      client.roomId = id;
      this.updateClient(socket, client);
      await this.saveRooms();
      this.send(socket, { type: 'room-joined', room: this.summary(room), you: client.id, youTeam: client.team, players: existing });
      if (!alreadyInside) this.broadcastRoom(room, { type: 'player-joined', player: { id: client.id, name: client.name, team: client.team } }, client.id);
      this.publishRooms();
      return;
    }

    const room = client.roomId ? this.rooms.get(client.roomId) : undefined;
    if (!room) return;
    if (data.type === 'leave-room') { await this.leaveRoom(socket, client); return; }
    if (data.type === 'player-state') {
      const now = Date.now();
      if (now - client.lastStateAt < 45) return;
      client.lastStateAt = now;
      this.updateClient(socket, client);
      const state = data.state;
      if (!state || ![state.x, state.y, state.z, state.rotation, state.turret].every(Number.isFinite)) return;
      const safeState = {
        x: Math.max(-64, Math.min(64, state.x)), y: Math.max(0, Math.min(5, state.y)), z: Math.max(-64, Math.min(64, state.z)),
        rotation: state.rotation, turret: state.turret, team: client.team,
        tankClass: typeof state.tankClass === 'string' && validClasses.has(state.tankClass) ? state.tankClass : 'medium',
        health: Number.isFinite(state.health) ? Math.max(0, Math.min(200, state.health)) : 100,
        alive: state.alive !== false
      };
      this.broadcastRoom(room, { type: 'player-state', player: { id: client.id, name: client.name, ...safeState } }, client.id);
      return;
    }
    if (data.type === 'fire') {
      const shot = data.shot;
      if (!shot || ![shot.x, shot.y, shot.z, shot.dx, shot.dy, shot.dz].every(Number.isFinite)) return;
      const safeShot = {
        x: shot.x, y: shot.y, z: shot.z, dx: shot.dx, dy: shot.dy, dz: shot.dz,
        tankClass: typeof shot.tankClass === 'string' && validClasses.has(shot.tankClass) ? shot.tankClass : 'medium',
        weapon: typeof shot.weapon === 'string' && validWeapons.has(shot.weapon) ? shot.weapon : 'cannon',
        damage: Number.isFinite(shot.damage) ? Math.max(0.1, Math.min(40, shot.damage)) : 2
      };
      this.broadcastRoom(room, { type: 'player-fire', playerId: client.id, team: client.team, shot: safeShot }, client.id);
      return;
    }
    if (data.type === 'hit') {
      const targetId = typeof data.targetId === 'string' ? data.targetId : '';
      const hit = data.hit;
      if (!room.players.includes(targetId) || targetId === client.id || !hit || !Number.isFinite(hit.damage) || hit.damage <= 0 || hit.damage > 100) return;
      const direction = hit.direction;
      if (!direction || ![direction.x, direction.y, direction.z].every(Number.isFinite)) return;
      const targetSocket = this.socketFor(targetId);
      if (targetSocket) this.send(targetSocket, { type: 'remote-hit', damage: hit.damage, direction });
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> { await this.ready; await this.leaveRoom(socket, this.client(socket)); }
  async webSocketError(socket: WebSocket): Promise<void> { await this.ready; await this.leaveRoom(socket, this.client(socket)); }

  private safeMode(value: unknown): Mode {
    return value === 'deathmatch' || value === 'ffa' || value === 'survival' ? value : 'ctf';
  }
  private client(socket: WebSocket): Client {
    return socket.deserializeAttachment() as Client;
  }
  private updateClient(socket: WebSocket, client: Client) { socket.serializeAttachment(client); }
  private socketFor(id: string): WebSocket | undefined {
    return this.state.getWebSockets(id).find(socket => this.client(socket).id === id);
  }
  private send(socket: WebSocket, message: unknown) {
    try { socket.send(JSON.stringify(message)); } catch { /* disconnected */ }
  }
  private summary(room: Room) {
    return { id: room.id, name: room.name, mode: room.mode, map: room.map, lighting: room.lighting, maxPlayers: room.maxPlayers, players: room.players.length };
  }
  private publishRooms() {
    const payload = { type: 'rooms', rooms: [...this.rooms.values()].map(room => this.summary(room)) };
    for (const socket of this.state.getWebSockets()) this.send(socket, payload);
  }
  private broadcastRoom(room: Room, payload: unknown, excludeId = '') {
    for (const id of room.players) {
      if (id === excludeId) continue;
      const socket = this.socketFor(id);
      if (socket) this.send(socket, payload);
    }
  }
  private async leaveRoom(socket: WebSocket, client: Client) {
    if (!client.roomId) return;
    const room = this.rooms.get(client.roomId);
    if (!room) { client.roomId = null; this.updateClient(socket, client); return; }
    room.players = room.players.filter(id => id !== client.id);
    client.roomId = null;
    this.updateClient(socket, client);
    this.broadcastRoom(room, { type: 'player-left', playerId: client.id });
    if (!room.players.length) this.rooms.delete(room.id);
    await this.saveRooms();
    this.publishRooms();
  }
  private saveRooms() { return this.state.storage.put('rooms', [...this.rooms.values()]); }
}

export default {
  fetch() { return new Response('Tank Arena lobby worker', { status: 200 }); }
} satisfies ExportedHandler<Env>;
