import { rm } from 'node:fs/promises';

// This optional Abrams source model is kept in the repository, but the game
// currently loads only the Quaternius tank models at /models/tank_*.glb.
// Avoid uploading its 174 MB of unused textures to Pages deployments.
await rm(new URL('../dist/models/tanks/abrams_m1a2_sepv3', import.meta.url), { recursive: true, force: true });
