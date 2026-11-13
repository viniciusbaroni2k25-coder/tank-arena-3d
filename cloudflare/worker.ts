import { authenticatedAccount, handleAccountRequest } from './accounts';

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
  username: string;
  name: string;
  roomId: string | null;
  team: Team;
  lastStateAt: number;
  position: { x: number; y: number; z: number };
  positionInitialized: boolean;
  tankClass: string;
  health: number;
  alive: boolean;
  deadAt: number;
  lastFireAt: number;
  lastWeapon: string;
  shots: Array<{ x: number; y: number; z: number; dx: number; dy: number; dz: number; weapon: string; damage: number; speed: number; range: number; firedAt: number; hitIds: string[] }>;
};

const validMaps = new Set(['field', 'desert', 'industrial', 'canyon', 'snow', 'harbor', 'volcano', 'metropolis', 'swamp', 'moon']);
const validClasses = new Set(['light', 'medium', 'heavy', 'artillery', 'scout', 'assault']);
const validWeapons = new Set(['cannon', 'rapid', 'mortar', 'plasma', 'ricochet']);
const classStats: Record<string, { health: number; damage: number; speed: number; armor: number }> = {
  scout: { health: 62, damage: 0.78, speed: 27, armor: 0 }, light: { health: 75, damage: 0.85, speed: 25, armor: 0 },
  medium: { health: 100, damage: 1, speed: 19, armor: 0.05 }, assault: { health: 125, damage: 1.16, speed: 18, armor: 0.12 },
  heavy: { health: 160, damage: 1.35, speed: 15, armor: 0.22 }, artillery: { health: 85, damage: 1.65, speed: 17, armor: 0 }
};
const weaponDamage: Record<string, number> = { cannon: 2, rapid: 1, mortar: 4.8, plasma: 1.55, ricochet: 1.45 };
const weaponCooldown: Record<string, number> = { cannon: 470, rapid: 110, mortar: 1050, plasma: 300, ricochet: 320 };
const weaponSpeed: Record<string, number> = { cannon: 34, rapid: 30, mortar: 25, plasma: 25, ricochet: 31 };
const weaponRange: Record<string, number> = { cannon: 90, rapid: 65, mortar: 80, plasma: 72, ricochet: 80 };

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
    if (new URL(request.url).pathname === '/api/account') return handleAccountRequest(request, this.state.storage);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ service: 'tank-arena-lobby', status: 'online' });
    }
    const account = await authenticatedAccount(request, this.state.storage);
    if (!account) return Response.json({ error: 'Entre na sua conta para conectar.' }, { status: 401 });
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const client: Client = {
      id, username: account.username, name: account.nickname, roomId: null, team: 'black', lastStateAt: Date.now(),
      position: { x: -34, y: 0, z: -34 }, positionInitialized: false, tankClass: 'medium', health: 100, alive: true, deadAt: 0,
      lastFireAt: 0, lastWeapon: 'cannon', shots: []
    };
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
      client.position = { x: -34, y: 0, z: -34 };
      client.positionInitialized = false;
      client.health = classStats[client.tankClass].health;
      client.alive = true;
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
      if (!alreadyInside) {
        client.position = { x: client.team === 'black' ? -34 : 34, y: 0, z: client.team === 'black' ? -34 : 34 };
        client.positionInitialized = false;
        client.health = classStats[client.tankClass].health;
        client.alive = true;
      }
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
      const state = data.state;
      if (!state || ![state.x, state.y, state.z, state.rotation, state.turret].every(Number.isFinite)) return;
      const tankClass = typeof state.tankClass === 'string' && validClasses.has(state.tankClass) ? state.tankClass : client.tankClass;
      if (client.alive && client.positionInitialized && tankClass !== client.tankClass) return;
      if (client.alive && !client.positionInitialized && tankClass !== client.tankClass) {
        client.health = classStats[tankClass].health;
      }
      if (state.alive === false && client.alive) {
        client.alive = false; client.health = 0; client.deadAt = now;
      } else if (!client.alive && state.alive !== false && now - client.deadAt >= 3500) {
        client.alive = true; client.deadAt = 0; client.tankClass = tankClass;
        client.health = classStats[tankClass].health;
        client.positionInitialized = false;
      }
      const x = Number(state.x), y = Math.max(0, Math.min(5, Number(state.y))), z = Number(state.z);
      if (Math.abs(x) > 64 || Math.abs(z) > 64) return;
      if (client.alive) {
        if (!client.positionInitialized) {
          const baseX = client.team === 'black' ? -34 : 34;
          const baseZ = client.team === 'black' ? -34 : 34;
          if (Math.hypot(x - baseX, z - baseZ) > 28) return;
          client.positionInitialized = true;
        } else {
          const elapsed = Math.max(0.045, Math.min(1.5, (now - client.lastStateAt) / 1000));
          // Leave room for engine upgrades and temporary speed bonuses while rejecting teleports.
          const maxDistance = Math.max(classStats[client.tankClass].speed, 25) * elapsed + 1.25;
          if (Math.hypot(x - client.position.x, z - client.position.z) > maxDistance) return;
        }
        client.position = { x, y, z };
        client.tankClass = tankClass;
      }
      client.lastStateAt = now;
      client.shots = client.shots.filter(shot => now - shot.firedAt < 5000);
      this.updateClient(socket, client);
      await this.resolveHits(room, socket, now);
      const safeState = {
        x: client.position.x, y: client.position.y, z: client.position.z,
        rotation: state.rotation, turret: state.turret, team: client.team,
        tankClass: client.tankClass, health: client.health, alive: client.alive
      };
      this.broadcastRoom(room, { type: 'player-state', player: { id: client.id, name: client.name, ...safeState } }, client.id);
      return;
    }
    if (data.type === 'fire') {
      if (!client.alive) return;
      const shot = data.shot;
      if (!shot || ![shot.x, shot.y, shot.z, shot.dx, shot.dy, shot.dz].every(Number.isFinite)) return;
      const weapon = typeof shot.weapon === 'string' && validWeapons.has(shot.weapon) ? shot.weapon : 'cannon';
      if (typeof shot.tankClass === 'string' && shot.tankClass !== client.tankClass) return;
      const now = Date.now();
      const fireRateFactor = client.tankClass === 'heavy' ? 1.35 : client.tankClass === 'artillery' ? 1.55 : client.tankClass === 'light' ? 0.78 : client.tankClass === 'scout' ? 0.72 : client.tankClass === 'assault' ? 0.92 : 1;
      const minimumCooldown = Math.max(weaponCooldown[weapon], weaponCooldown[client.lastWeapon]) * fireRateFactor;
      if (now - client.lastFireAt < minimumCooldown) return;
      const length = Math.hypot(shot.dx, shot.dy, shot.dz);
      if (length < 0.75 || length > 1.25 || Math.hypot(shot.x - client.position.x, shot.z - client.position.z) > 7) return;
      client.lastFireAt = now; client.lastWeapon = weapon;
      const stats = classStats[client.tankClass];
      const safeShot = {
        x: shot.x, y: Math.max(0, Math.min(5, shot.y)), z: shot.z,
        dx: shot.dx / length, dy: shot.dy / length, dz: shot.dz / length,
        tankClass: client.tankClass, weapon,
        damage: weaponDamage[weapon] * stats.damage
      };
      client.shots.push({ ...safeShot, speed: weaponSpeed[weapon], range: weaponRange[weapon], firedAt: now, hitIds: [] });
      if (client.shots.length > 12) client.shots.shift();
      this.updateClient(socket, client);
      this.broadcastRoom(room, { type: 'player-fire', playerId: client.id, team: client.team, shot: safeShot }, client.id);
      return;
    }
    if (data.type === 'hit') {
      const targetId = typeof data.targetId === 'string' ? data.targetId : '';
      const targetSocket = this.socketFor(targetId);
      if (!targetSocket || targetId === client.id) return;
      const target = this.client(targetSocket);
      if (!target.alive || target.team === client.team) return;
      await this.resolveHit(room, socket, targetSocket, target, Date.now());
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> { await this.ready; await this.leaveRoom(socket, this.client(socket)); }
  async webSocketError(socket: WebSocket): Promise<void> { await this.ready; await this.leaveRoom(socket, this.client(socket)); }

  private safeMode(value: unknown): Mode {
    return value === 'deathmatch' || value === 'ffa' || value === 'survival' ? value : 'ctf';
  }
  private async resolveHits(room: Room, attackerSocket: WebSocket, now: number) {
    const attacker = this.client(attackerSocket);
    if (!attacker.alive) return;
    for (const targetId of room.players) {
      if (targetId === attacker.id) continue;
      const targetSocket = this.socketFor(targetId);
      if (!targetSocket) continue;
      const target = this.client(targetSocket);
      if (target.team === attacker.team || !target.alive) continue;
      await this.resolveHit(room, attackerSocket, targetSocket, target, now);
    }
  }
  private async resolveHit(room: Room, attackerSocket: WebSocket, targetSocket: WebSocket, target: Client, now: number) {
    const attacker = this.client(attackerSocket);
    if (!attacker.alive || !target.alive || attacker.team === target.team) return;
    const shot = [...attacker.shots].reverse().find(candidate => {
      if (candidate.hitIds.includes(target.id)) return false;
      const age = (now - candidate.firedAt) / 1000;
      const rx = target.position.x - candidate.x, ry = target.position.y - candidate.y, rz = target.position.z - candidate.z;
      const along = rx * candidate.dx + ry * candidate.dy + rz * candidate.dz;
      if (along <= 0 || along > candidate.range || Math.abs(age - along / candidate.speed) > 1.2) return false;
      const perpendicularSquared = Math.max(0, rx * rx + ry * ry + rz * rz - along * along);
      return perpendicularSquared <= 30.25;
    });
    if (!shot) return;
    shot.hitIds.push(target.id);
    attacker.shots = attacker.shots.filter(item => now - item.firedAt < 5000);
    this.updateClient(attackerSocket, attacker);
    const wasAlive = target.alive;
    const armor = classStats[target.tankClass]?.armor ?? 0;
    target.health = Math.max(0, target.health - shot.damage * (1 - armor));
    if (target.health <= 0) { target.alive = false; target.deadAt = now; }
    this.updateClient(targetSocket, target);
    this.send(targetSocket, { type: 'remote-hit', damage: shot.damage, direction: { x: shot.dx, y: shot.dy, z: shot.dz } });
    if (!target.alive) this.send(targetSocket, { type: 'player-down' });
    const state = {
      x: target.position.x, y: target.position.y, z: target.position.z, rotation: 0, turret: 0,
      team: target.team, tankClass: target.tankClass, health: target.health, alive: target.alive
    };
    this.broadcastRoom(room, { type: 'player-state', player: { id: target.id, name: target.name, ...state } }, target.id);
    if (wasAlive && !target.alive) {
      const record = await this.state.storage.transaction(async transaction => {
        const current = await transaction.get<{ kills: number; crystals: number }>(`account:${attacker.username}`);
        if (!current) return null;
        current.kills = Math.max(0, current.kills || 0) + 1;
        current.crystals = Math.max(0, current.crystals || 0) + 10;
        await transaction.put(`account:${attacker.username}`, current);
        return current;
      });
      if (record) this.send(attackerSocket, { type: 'career-update', kills: record.kills, crystals: record.crystals });
    }
  }
  private client(socket: WebSocket): Client {
    const saved = socket.deserializeAttachment() as Partial<Client>;
    return {
      id: saved.id ?? '', username: saved.username ?? '', name: saved.name ?? 'Comandante', roomId: saved.roomId ?? null,
      team: saved.team === 'white' ? 'white' : 'black', lastStateAt: saved.lastStateAt ?? 0,
      position: saved.position ?? { x: saved.team === 'white' ? 34 : -34, y: 0, z: saved.team === 'white' ? 34 : -34 },
      positionInitialized: saved.positionInitialized ?? false,
      tankClass: saved.tankClass && validClasses.has(saved.tankClass) ? saved.tankClass : 'medium',
      health: Number.isFinite(saved.health) ? saved.health! : 100, alive: saved.alive !== false, deadAt: saved.deadAt ?? 0,
      lastFireAt: saved.lastFireAt ?? 0, lastWeapon: saved.lastWeapon ?? 'cannon', shots: saved.shots ?? []
    };
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
