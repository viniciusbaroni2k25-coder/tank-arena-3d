import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import './style.css';

// =====================================================
// TANK ARENA 3D
// PROTÓTIPO OFFLINE COM BOTS, PATENTES E RESPAWN
// VERSÃO OTIMIZADA: menos chamadas de desenho, resolução nativa e LOD
// =====================================================

let graphicsQuality: 'balanced' | 'high' | 'maximum' = 'maximum';
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b9d9);
scene.fog = new THREE.Fog(0x87b9d9, 55, 125);

const camera = new THREE.PerspectiveCamera(
  65, window.innerWidth / window.innerHeight, 0.1, 200
);

const renderer = new THREE.WebGLRenderer({
  // Suavização de bordas ligada: tira o serrilhado das esteiras e do casco.
  // Se o jogo ficar pesado em PC fraco, troque para false.
  antialias: true,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: false
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
document.body.appendChild(renderer.domElement);

// =====================================================
// PERFIS DE QUALIDADE + PÓS-PROCESSAMENTO (tone mapping e correção de cor)
// =====================================================
type QualityLevel = 'balanced' | 'high' | 'maximum';
const QUALITY: Record<QualityLevel, { ratio: number; post: boolean; msaa: number }> = {
  balanced: { ratio: 1.0, post: false, msaa: 0 },
  high: { ratio: 1.0, post: true, msaa: 2 },
  maximum: { ratio: 1.0, post: false, msaa: 0 }
};
// Ganho do céu quando o pós-processamento está ativo (o OutputPass aplica o tone mapping em tudo).
// Se o céu ficar lavado/claro demais, diminua; se ficar escuro, aumente.
const SKY_POST_GAIN = 0.72;

let composer: EffectComposer | null = null;
let postFxActive = false;
let fxAutoDisabled = false;
let lastDrawCalls = 0;
let lastTriangles = 0;
renderer.info.autoReset = false;

function disposePostFx() {
  if (composer) {
    composer.dispose();
    composer = null;
  }
}

const ATMOSPHERE: Record<string, number> = { field: 0x87b9d9, desert: 0xe0bd83, night: 0x111827, snow: 0xc6d5df };
function applyAtmosphere() {
  const atmosphereKey = lightingStyle === 'night' ? 'night' : mapStyleName === 'desert' ? 'desert' : mapStyleName === 'snow' ? 'snow' : 'field';
  const base = new THREE.Color(ATMOSPHERE[atmosphereKey] ?? 0x87b9d9);
  base.multiplyScalar(postFxActive ? SKY_POST_GAIN : 1);
  if (scene.fog) scene.fog.color.copy(base);
  scene.background = base.clone();
}

function setupPostFx() {
  disposePostFx();
  const q = QUALITY[graphicsQuality];
  postFxActive = q.post && !fxAutoDisabled;
  skyMaterial.color.setScalar(postFxActive ? SKY_POST_GAIN : 1);
  applyAtmosphere();
  if (!postFxActive) return;

  const width = Math.max(2, window.innerWidth);
  const height = Math.max(2, window.innerHeight);
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: q.msaa });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const outputPass = new OutputPass();
  outputPass.uniforms.uVignette = { value: 0.30 } as any;
  outputPass.uniforms.uSaturation = { value: 1.14 } as any;
  outputPass.uniforms.uContrast = { value: 1.07 } as any;
  outputPass.material.fragmentShader = outputPass.material.fragmentShader
    .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\nuniform float uVignette; uniform float uSaturation; uniform float uContrast;')
    .replace(
      /\/\/ color space[\s\S]*?#endif/,
      `// color space
			#ifdef SRGB_TRANSFER
				gl_FragColor = sRGBTransferOETF( gl_FragColor );
			#endif
			float gradeLuma = dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
			gl_FragColor.rgb = mix( vec3( gradeLuma ), gl_FragColor.rgb, uSaturation );
			gl_FragColor.rgb = ( gl_FragColor.rgb - 0.5 ) * uContrast + 0.5;
			vec2 gradeUV = ( vUv - 0.5 ) * vec2( 1.0, 0.85 );
			float gradeVignette = 1.0 - smoothstep( 0.25, 0.85, length( gradeUV ) );
			gl_FragColor.rgb *= mix( 1.0 - uVignette, 1.0, gradeVignette );`
    );
  outputPass.material.needsUpdate = true;
  composer.addPass(outputPass);
}

// O perfil escolhido pelo jogador permanece ativo; a taxa de quadros não altera a qualidade.
function qualityPixelRatio(): number {
  const deviceRatio = window.devicePixelRatio || 1;
  return Math.min(deviceRatio, QUALITY[graphicsQuality].ratio);
}
function applyPixelRatio() {
  const ratio = qualityPixelRatio();
  renderer.setPixelRatio(ratio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) {
    composer.setPixelRatio(ratio);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
}
applyPixelRatio();

// Medidor real de FPS: média por janela de 500 ms, sem logs no console.
const fpsHud = document.createElement('div');
fpsHud.id = 'tank-arena-fps';
fpsHud.textContent = 'FPS: --';
Object.assign(fpsHud.style, {
  position: 'fixed', top: '10px', left: '10px', zIndex: '1000',
  padding: '6px 9px', border: '1px solid rgba(180,210,190,.35)',
  borderRadius: '5px', background: 'rgba(5,12,10,.78)',
  color: '#baf7c5', font: 'bold 12px/1.2 monospace',
  letterSpacing: '.4px', pointerEvents: 'none',
  textShadow: '0 1px 3px #000'
});
document.body.appendChild(fpsHud);
let fpsFrameCount = 0;
let fpsWindowStart = performance.now();
let lastCpuFrameMs = 0;
function updateFpsCounter(now: number) {
  fpsFrameCount++;
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 500) {
    const fps = Math.round(fpsFrameCount * 1000 / elapsed);
    fpsHud.textContent = `FPS: ${fps} · ${lastDrawCalls} calls · ${(lastTriangles / 1000).toFixed(0)}k tris · CPU ${lastCpuFrameMs.toFixed(1)}ms${postFxActive ? ' · FX' : ''} · ${graphicsQuality === 'maximum' ? 'MAX' : graphicsQuality === 'high' ? 'ALTO' : 'EQUIL'}`;
    fpsHud.style.color = fps >= 55 ? '#baf7c5' : fps >= 30 ? '#ffe09a' : '#ff9999';
    fpsFrameCount = 0;
    fpsWindowStart = now;
  }
}

// Só escreve no HTML quando o texto realmente mudou (evita recalcular layout todo frame).
function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

const hemi = new THREE.HemisphereLight(0xdde7ed, 0x46513d, 1.35);
scene.add(hemi);

// Luz direcional global; sombras projetadas ficam desligadas para evitar outro passe de GPU.
const SUN_OFFSET = new THREE.Vector3(15, 30, 12);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
sun.position.copy(SUN_OFFSET);
sun.castShadow = false;
scene.add(sun);
scene.add(sun.target);

const clock = new THREE.Clock();
const worldUp = new THREE.Vector3(0, 1, 0);
// =====================================================
// CÉU: cúpula com degradê, nuvens e sol (1 única chamada de desenho)
// =====================================================

type SkyStyle = 'field' | 'desert' | 'night';
const skyTextures = new Map<SkyStyle, THREE.CanvasTexture>();
function getSkyTexture(style: SkyStyle): THREE.CanvasTexture {
  const cached = skyTextures.get(style);
  if (cached) return cached;

  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  let seed = style === 'field' ? 5521 : style === 'desert' ? 7733 : 9941;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const palettes = {
    field: { top: '#3a82cf', mid: '#6cb0e2', horizon: '#87b9d9' },
    desert: { top: '#6a9bd0', mid: '#c4c3a8', horizon: '#e0bd83' },
    night: { top: '#03050b', mid: '#09101f', horizon: '#111827' }
  } as const;
  const palette = palettes[style];

  // Metade de cima = céu (topo no alto da imagem, horizonte no meio). Metade de baixo = cor do horizonte.
  const gradient = ctx.createLinearGradient(0, 0, 0, H / 2);
  gradient.addColorStop(0, palette.top);
  gradient.addColorStop(0.55, palette.mid);
  gradient.addColorStop(1, palette.horizon);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H / 2);
  ctx.fillStyle = palette.horizon;
  ctx.fillRect(0, H / 2, W, H / 2);

  const softBlob = (x: number, y: number, radius: number, stretch: number, color: string, alpha: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(stretch, 1);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();
  };

  if (style === 'night') {
    for (let i = 0; i < 420; i++) {
      const x = rand() * W, y = rand() * H * 0.46;
      ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.6})`;
      ctx.fillRect(x, y, rand() > 0.9 ? 2 : 1, 1);
    }
    softBlob(W * 0.393, H * 0.225, 70, 1.5, '170,190,255', 0.55);
    softBlob(W * 0.393, H * 0.225, 14, 1.5, '235,240,255', 1);
  } else {
    // Sol: posição alinhada com a direção da luz principal.
    softBlob(W * 0.393, H * 0.225, 120, 1.5, '255,236,180', 0.55);
    softBlob(W * 0.393, H * 0.225, 38, 1.5, '255,250,225', 1);
    const cloudAlpha = style === 'field' ? 0.62 : 0.34;
    for (let c = 0; c < 30; c++) {
      const cx = rand() * W;
      const cy = H * (0.10 + rand() * 0.32);
      const size = 18 + rand() * 30;
      const puffs = 5 + Math.floor(rand() * 5);
      for (let p = 0; p < puffs; p++) {
        softBlob(cx + (rand() - 0.5) * size * 4.5, cy + (rand() - 0.5) * size * 0.5, size * (0.8 + rand() * 0.9), 2.4, '255,255,255', cloudAlpha * (0.5 + rand() * 0.5));
      }
      // Base levemente azulada para dar volume.
      softBlob(cx, cy + size * 0.35, size * 1.6, 3.2, '150,185,220', cloudAlpha * 0.22);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  skyTextures.set(style, texture);
  return texture;
}
const skyMaterial = new THREE.MeshBasicMaterial({
  map: getSkyTexture('field'),
  side: THREE.BackSide,
  fog: false,
  depthWrite: false,
  toneMapped: false
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(120, 32, 16), skyMaterial);
skyDome.renderOrder = -10;
skyDome.frustumCulled = false;
scene.add(skyDome);

// Sem reflexos de ambiente: mantém materiais e mapas de pintura/relevo, mas
// evita o brilho de estúdio/HDR que não combina com a leitura visual do combate.
function useEnv<T extends THREE.MeshStandardMaterial>(material: T, _intensity: number): T {
  material.envMap = null;
  material.envMapIntensity = 0;
  material.metalness = 0.04;
  material.metalnessMap = null;
  material.roughness = Math.max(material.roughness, 0.72);
  return material;
}
function releaseEnv(_material: THREE.Material) {}

// =====================================================
// MAPA E COLISÕES RETANGULARES
// =====================================================

// Textura procedural leve (1024 px): criada uma vez e reutilizada pelo terreno inteiro.
function createTerrainTexture() {
  const S = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const image = context.createImageData(S, S);
  let seed = 918273;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < image.data.length; i += 4) {
    const grain = Math.floor(112 + random() * 34);
    image.data[i] = grain;
    image.data[i + 1] = grain;
    image.data[i + 2] = grain;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);

  // Pequenas pedras e manchas de terra, sem imagens externas.
  for (let i = 0; i < 3200; i++) {
    const shade = Math.floor(75 + random() * 105);
    const radius = 0.3 + random() * 0.9;
    context.fillStyle = `rgba(${shade},${shade},${shade},${0.12 + random() * 0.2})`;
    context.beginPath();
    context.arc(random() * S, random() * S, radius, 0, Math.PI * 2);
    context.fill();
  }
  for (let i = 0; i < 90; i++) {
    const x = random() * S;
    const y = random() * S;
    context.strokeStyle = `rgba(65,65,65,${0.08 + random() * 0.08})`;
    context.lineWidth = 1 + random() * 2;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + random() * 28 - 14, y + random() * 28 - 14);
    context.stroke();
  }

  // Variação cromática de solo: manchas de capim seco, terra úmida e cascalho.
  for (let i = 0; i < 1500; i++) {
    const x = random() * S;
    const y = random() * S;
    const radiusX = 2 + random() * 12;
    const radiusY = 1 + random() * 6;
    const kind = random();
    if (kind < 0.48) context.fillStyle = `rgba(38,65,29,${0.035 + random() * 0.09})`;
    else if (kind < 0.82) context.fillStyle = `rgba(133,105,66,${0.035 + random() * 0.075})`;
    else context.fillStyle = `rgba(190,184,157,${0.04 + random() * 0.08})`;
    context.beginPath();
    context.ellipse(x, y, radiusX, radiusY, random() * Math.PI, 0, Math.PI * 2);
    context.fill();
  }
  // Cascalhos individuais com luz e sombra para leitura de relevo à distância.
  for (let i = 0; i < 260; i++) {
    const x = random() * S, y = random() * S;
    const radius = 0.7 + random() * 1.6;
    context.fillStyle = `rgba(32,35,28,${0.10 + random() * 0.16})`;
    context.beginPath(); context.ellipse(x + 1, y + 1, radius * 1.2, radius * 0.7, random(), 0, Math.PI * 2); context.fill();
    context.fillStyle = `rgba(205,197,169,${0.10 + random() * 0.16})`;
    context.beginPath(); context.ellipse(x, y, radius, radius * 0.6, random(), 0, Math.PI * 2); context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(38.6, 38.6); // plano de 300 m: mesma densidade de detalhe de antes
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(12, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

let terrainTexture: THREE.Texture | null = null;
// The large terrain keeps its full-color texture and uses a flat matte shader,
// avoiding per-pixel BRDF and shadow-map work across most of the screen.
const groundMaterial = new THREE.MeshBasicMaterial({
  color: 0x657d4b,
  map: terrainTexture ?? undefined,
});
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(300, 300),
  groundMaterial
);
ground.geometry.setAttribute('uv2', ground.geometry.getAttribute('uv'));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
// The full-screen ground is the most expensive shadow receiver. Vehicles keep
// smooth contact shadows below; the ground no longer samples the shadow map on
// every pixel of the arena.
ground.receiveShadow = false;
scene.add(ground);

const tankShadowCanvas = document.createElement('canvas');
tankShadowCanvas.width = tankShadowCanvas.height = 64;
const tankShadowContext = tankShadowCanvas.getContext('2d')!;
const tankShadowGradient = tankShadowContext.createRadialGradient(32, 32, 3, 32, 32, 32);
tankShadowGradient.addColorStop(0, 'rgba(4,8,5,0.52)');
tankShadowGradient.addColorStop(0.42, 'rgba(4,8,5,0.32)');
tankShadowGradient.addColorStop(1, 'rgba(4,8,5,0)');
tankShadowContext.fillStyle = tankShadowGradient;
tankShadowContext.fillRect(0, 0, 64, 64);
const tankShadowTexture = new THREE.CanvasTexture(tankShadowCanvas);
tankShadowTexture.generateMipmaps = false;
tankShadowTexture.minFilter = THREE.LinearFilter;
tankShadowTexture.magFilter = THREE.LinearFilter;
const tankContactShadowMaterial = new THREE.MeshBasicMaterial({
  map: tankShadowTexture, transparent: true, depthWrite: false, toneMapped: false
});
const tankContactShadowGeometry = new THREE.CircleGeometry(1, 24);
tankContactShadowGeometry.rotateX(-Math.PI / 2);

// Estradas de terra batida para quebrar a grande área uniforme de grama.
// Uma textura procedural pequena evita downloads e mantém o custo em dois draws.
function makeDirtRoadTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  let seed = 81927;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  ctx.fillStyle = '#8d8064';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 4200; i++) {
    const value = 72 + Math.floor(random() * 100);
    const alpha = 0.05 + random() * 0.2;
    ctx.fillStyle = `rgba(${value},${Math.floor(value * 0.86)},${Math.floor(value * 0.63)},${alpha})`;
    const x = random() * size, y = random() * size;
    const radius = 0.4 + random() * 2.3;
    ctx.beginPath(); ctx.ellipse(x, y, radius * 1.7, radius, random() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  // Sulcos de esteira, repetidos em duas linhas com pequenas quebras naturais.
  for (const x of [74, 182]) {
    for (let y = -4; y < size; y += 19) {
      if (random() < 0.13) continue;
      ctx.fillStyle = `rgba(45,39,30,${0.10 + random() * 0.12})`;
      ctx.fillRect(x, y, 3 + random() * 2, 10 + random() * 8);
      ctx.fillStyle = `rgba(201,181,145,${0.06 + random() * 0.08})`;
      ctx.fillRect(x + 4, y + 2, 1, 9);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(15, 1);
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}
const dirtRoadTexture = makeDirtRoadTexture();
const dirtRoadMaterial = new THREE.MeshLambertMaterial({ map: dirtRoadTexture, color: 0xffffff });
const roadGeometry = new THREE.PlaneGeometry(110, 5.2);
roadGeometry.setAttribute('uv2', roadGeometry.getAttribute('uv'));
const eastWestRoad = new THREE.Mesh(roadGeometry, dirtRoadMaterial);
eastWestRoad.rotation.x = -Math.PI / 2;
eastWestRoad.position.set(0, -0.018, 0);
eastWestRoad.receiveShadow = true;
scene.add(eastWestRoad);
const northSouthRoad = new THREE.Mesh(roadGeometry, dirtRoadMaterial);
northSouthRoad.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
northSouthRoad.position.set(0, -0.017, 0);
northSouthRoad.receiveShadow = true;
scene.add(northSouthRoad);

// A textura albedo do terreno; usa a versão procedural se o arquivo local falhar.
let groundTextureLoaded = false;
type MapStyle = 'field' | 'desert' | 'industrial' | 'canyon' | 'snow';
type LightingStyle = 'day' | 'night';
let mapStyleName: MapStyle = 'field';
let lightingStyle: LightingStyle = 'day';
{
  const textureLoader = new THREE.TextureLoader();
  const terrainAnisotropy = () => Math.min(
    graphicsQuality === 'maximum' ? 4 : graphicsQuality === 'high' ? 4 : 2,
    renderer.capabilities.getMaxAnisotropy()
  );
  const prepare = (texture: THREE.Texture, isColor: boolean) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(40, 40);
    texture.anisotropy = terrainAnisotropy();
    if (isColor) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };
  const prepareRoadMap = (texture: THREE.Texture, isColor = false) => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(37, 1.8);
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (isColor) texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };
  textureLoader.load('/textures/road_albedo.jpg', texture => {
    dirtRoadMaterial.map = prepareRoadMap(texture, true);
    dirtRoadMaterial.needsUpdate = true;
  }, undefined, () => {});
  textureLoader.load('/textures/road_normal.jpg', texture => {
    dirtRoadMaterial.normalMap = prepareRoadMap(texture);
    dirtRoadMaterial.normalScale.set(0.55, 0.55);
    dirtRoadMaterial.needsUpdate = true;
  }, undefined, () => {});
  // Roughness is always near 1 for the matte dirt, so the map does not change
  // its lighting in practice and is intentionally not sampled at runtime.
  textureLoader.load('/textures/road_ao.jpg', texture => {
    dirtRoadMaterial.aoMap = prepareRoadMap(texture);
    dirtRoadMaterial.aoMapIntensity = 0.55;
    dirtRoadMaterial.needsUpdate = true;
  }, undefined, () => {});
  textureLoader.load('/textures/ground_albedo.jpg', albedo => {
    groundMaterial.map = prepare(albedo, true);
    terrainTexture = albedo;
    groundMaterial.color.setHex(mapStyleName === 'desert' || mapStyleName === 'canyon' ? 0xa38a62 : mapStyleName === 'snow' ? 0xc0ccd2 : 0x818b70);
    groundTextureLoaded = true;
    groundMaterial.needsUpdate = true;
    console.info('[Tank Arena] textura de terreno carregada');
  }, undefined, () => {
    terrainTexture = createTerrainTexture();
    groundMaterial.map = terrainTexture;
    groundMaterial.color.setHex(mapStyleName === 'desert' || mapStyleName === 'canyon' ? 0xb49a63 : mapStyleName === 'snow' ? 0x9cabb5 : 0x566c45);
    groundMaterial.needsUpdate = true;
  });
}

// Montanhas ao redor da arena: um único mesh, escondido pela neblina em degradê (profundidade de cena).
const hillMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.BackSide, vertexColors: true });
{
  const hillGeometry = new THREE.CylinderGeometry(98, 98, 24, 384, 1, true);
  const hillPos = hillGeometry.attributes.position as THREE.BufferAttribute;
  const hillColors = new Float32Array(hillPos.count * 3);
  const valleyColor = new THREE.Color(0x394839);
  const ridgeColor = new THREE.Color(0x718066);
  const hillColor = new THREE.Color();
  for (let i = 0; i < hillPos.count; i++) {
    const x = hillPos.getX(i), z = hillPos.getZ(i);
    if (hillPos.getY(i) > 0) {
      const a = Math.atan2(z, x);
      const h = 9 + 5 * Math.sin(a * 3 + 1.3) + 3.5 * Math.sin(a * 7 + 0.4) + 1.6 * Math.sin(a * 17 + 2.1) + 0.8 * Math.sin(a * 41 + 0.7);
      hillPos.setY(i, Math.max(1.5, h));
    } else {
      hillPos.setY(i, -4);
    }
    const elevation = THREE.MathUtils.smoothstep(hillPos.getY(i), 3, 16);
    hillColor.copy(valleyColor).lerp(ridgeColor, elevation);
    const landNoise = 0.94 + 0.06 * Math.sin(x * 0.12 + z * 0.08) * Math.cos(z * 0.09 - x * 0.06);
    hillColor.multiplyScalar(landNoise);
    hillColors[i * 3] = hillColor.r;
    hillColors[i * 3 + 1] = hillColor.g;
    hillColors[i * 3 + 2] = hillColor.b;
  }
  hillGeometry.setAttribute('color', new THREE.Float32BufferAttribute(hillColors, 3));
  hillGeometry.computeVertexNormals();
  const hills = new THREE.Mesh(hillGeometry, hillMaterial);
  hills.frustumCulled = false;
  scene.add(hills);
}

const grid = new THREE.GridHelper(140, 70, 0x435a35, 0x526b40);
grid.position.y = 0.012;
grid.visible = false; // grade de depuração: preservada, mas fora da apresentação do jogo
const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
for (const material of gridMaterials) {
  material.transparent = true;
  material.opacity = 0.12;
}
function setGridColor(color: number) {
  for (const material of gridMaterials) {
    (material as THREE.LineBasicMaterial).color.setHex(color);
  }
}
scene.add(grid);

type Obstacle = {
  center: THREE.Vector3;
  halfX: number;
  halfZ: number;
  height: number;
  style?: MapStyle;
};

const obstacles: Obstacle[] = [];
const obstacleGeometryBatch: THREE.BufferGeometry[] = [];
const obstacleTrimGeometryBatch: THREE.BufferGeometry[] = [];

// Textura industrial de painéis metálicos com rebites (neutra; é tingida pela cor do material).
function createBuildingTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext('2d')!;
  let seed = 31337;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  c.fillStyle = '#74796e';
  c.fillRect(0, 0, size, size);
  const panel = size / 4;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const shade = 157 + Math.floor(rand() * 32);
      c.fillStyle = `rgb(${shade},${shade + 3},${shade - 4})`;
      c.fillRect(col * panel + 2, row * panel + 2, panel - 4, panel - 4);
      // Frestas de ventilação em alguns painéis.
      if (rand() > 0.72) {
        c.fillStyle = 'rgba(40,46,48,0.38)';
        for (let v = 0; v < 5; v++) c.fillRect(col * panel + 36, row * panel + 44 + v * 30, panel - 72, 8);
      }
    }
  }
  // Frestas entre os painéis.
  c.strokeStyle = 'rgba(38,44,46,0.6)';
  c.lineWidth = 5;
  for (let i = 0; i <= 4; i++) {
    c.beginPath(); c.moveTo(i * panel, 0); c.lineTo(i * panel, size); c.stroke();
    c.beginPath(); c.moveTo(0, i * panel); c.lineTo(size, i * panel); c.stroke();
  }
  // Rebites.
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      for (const [dx, dy] of [[7, 7], [panel - 7, 7], [7, panel - 7], [panel - 7, panel - 7]]) {
        c.fillStyle = 'rgba(30,34,36,0.55)';
        c.beginPath(); c.arc(col * panel + dx + 2, row * panel + dy + 2, 5, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.55)';
        c.beginPath(); c.arc(col * panel + dx, row * panel + dy, 4, 0, Math.PI * 2); c.fill();
      }
    }
  }
  // Marcas de chuva/ferrugem escorrendo.
  for (let i = 0; i < 40; i++) {
    c.strokeStyle = `rgba(60,52,44,${0.04 + rand() * 0.07})`;
    c.lineWidth = 1 + rand() * 2;
    const x = rand() * size, y = rand() * size * 0.7;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rand() - 0.5) * 4, y + 20 + rand() * 60); c.stroke();
  }
  for (let i = 0; i < 1800; i++) {
    const x = rand() * size, y = rand() * size;
    c.fillStyle = `rgba(${rand() > 0.5 ? '212,204,175' : '26,31,29'},${0.05 + rand() * 0.20})`;
    c.fillRect(x, y, 1 + rand() * 16, 1 + rand() * 3);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}
const buildingTexture = createBuildingTexture();
const buildingTrimMaterial = new THREE.MeshLambertMaterial({ color: 0x8a7344 });
const buildingMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, map: buildingTexture, bumpMap: buildingTexture, bumpScale: 0.035 });

// Ajusta o mapeamento da textura para que os painéis tenham tamanho constante (4 m) em qualquer parede.
function scaleBoxUVs(geometry: THREE.BoxGeometry, width: number, height: number, depth: number, tile = 4) {
  const uv = geometry.attributes.uv as THREE.BufferAttribute;
  const faceSizes: Array<[number, number]> = [[depth, height], [depth, height], [width, depth], [width, depth], [width, height], [width, height]];
  for (let face = 0; face < 6; face++) {
    for (let i = 0; i < 4; i++) {
      const index = face * 4 + i;
      uv.setXY(index, uv.getX(index) * faceSizes[face][0] / tile, uv.getY(index) * faceSizes[face][1] / tile);
    }
  }
  uv.needsUpdate = true;
}

function createObstacle(
  x: number,
  z: number,
  width: number,
  height: number,
  depth = width
) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  scaleBoxUVs(geometry, width, height, depth);
  geometry.translate(x, height / 2, z);
  obstacleGeometryBatch.push(geometry);
  // Faixa amarela no topo (acabamento estilo arena).
  const trimGeometry = new THREE.BoxGeometry(width + 0.22, 0.26, depth + 0.22);
  trimGeometry.translate(x, height / 2 - 0.13, z);
  obstacleTrimGeometryBatch.push(trimGeometry);

  obstacles.push({
    center: new THREE.Vector3(x, height / 2, z),
    halfX: width / 2,
    halfZ: depth / 2,
    height,
  });

}

// Construções
createObstacle(-12, -9, 5, 4, 3);
createObstacle(12, 9, 5, 4, 3);
createObstacle(-15, 12, 4, 3, 7);
createObstacle(15, -12, 4, 3, 7);
createObstacle(0, -22, 12, 3, 3);
createObstacle(0, 22, 12, 3, 3);
createObstacle(-25, 0, 3, 4, 12);
createObstacle(25, 0, 3, 4, 12);

function addMergedArenaMeshes(geometries: THREE.BufferGeometry[], material: THREE.Material) {
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) return;
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  scene.add(mesh);
}

// Coberturas exclusivas por cenário: cada estilo fica em poucos meshes agrupados.
const mapVariantMeshes: Record<MapStyle, THREE.Object3D[]> = { field: [], desert: [], industrial: [], canyon: [], snow: [] };
function addMapVariantMesh(geometries: THREE.BufferGeometry[], material: THREE.Material, style: Exclude<MapStyle, 'field'>) {
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) return;
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.visible = style === mapStyleName;
  mapVariantMeshes[style].push(mesh);
  scene.add(mesh);
}

function createMapVariantCover(
  style: Exclude<MapStyle, 'field'>,
  x: number,
  z: number,
  width: number,
  height: number,
  depth: number,
  geometryBatch: THREE.BufferGeometry[],
  trimBatch?: THREE.BufferGeometry[],
) {
  const obstacle: Obstacle = {
    center: new THREE.Vector3(x, height / 2, z),
    halfX: width / 2,
    halfZ: depth / 2,
    height,
    style,
  };
  obstacles.push(obstacle);

  if (style === 'desert' || style === 'canyon') {
    const rock = new THREE.IcosahedronGeometry(1, 1);
    const positions = rock.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < positions.count; i++) {
      const variation = 0.82 + 0.2 * Math.sin(i * 12.9898 + x * 3.7 + z * 8.1);
      positions.setXYZ(i, positions.getX(i) * variation, positions.getY(i) * variation, positions.getZ(i) * variation);
    }
    rock.computeVertexNormals();
    rock.scale(width * 0.46, height * 0.45, depth * 0.46);
    rock.translate(x, height * 0.48, z);
    geometryBatch.push(rock);
    return;
  }

  const body = new THREE.BoxGeometry(width, height, depth);
  body.translate(x, height / 2, z);
  geometryBatch.push(body);
  if (trimBatch) {
    const stripe = new THREE.BoxGeometry(width * 0.78, 0.16, depth + 0.04);
    stripe.translate(x, height * 0.68, z);
    trimBatch.push(stripe);
  }
}

const desertCoverGeometries: THREE.BufferGeometry[] = [];
createMapVariantCover('desert', -8, -15, 5.2, 2.8, 3.4, desertCoverGeometries);
createMapVariantCover('desert', 8, 15, 5.2, 2.8, 3.4, desertCoverGeometries);
createMapVariantCover('desert', -20, 4, 3.4, 2.3, 6.2, desertCoverGeometries);
createMapVariantCover('desert', 20, -4, 3.4, 2.3, 6.2, desertCoverGeometries);
const desertRockMaterial = new THREE.MeshLambertMaterial({ color: 0xb89a6d });
addMapVariantMesh(desertCoverGeometries, desertRockMaterial, 'desert');

const canyonCoverGeometries: THREE.BufferGeometry[] = [];
createMapVariantCover('canyon', -19, 5, 7.2, 3.8, 5.5, canyonCoverGeometries);
createMapVariantCover('canyon', 19, -5, 7.2, 3.8, 5.5, canyonCoverGeometries);
createMapVariantCover('canyon', -5, -25, 4.2, 2.8, 7, canyonCoverGeometries);
createMapVariantCover('canyon', 5, 25, 4.2, 2.8, 7, canyonCoverGeometries);
addMapVariantMesh(canyonCoverGeometries, new THREE.MeshLambertMaterial({ color: 0x8d7358 }), 'canyon');

const industrialCoverGeometries: THREE.BufferGeometry[] = [];
const industrialTrimGeometries: THREE.BufferGeometry[] = [];
createMapVariantCover('industrial', -19, 5, 4.2, 2.6, 5.2, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', 19, -5, 4.2, 2.6, 5.2, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', -7, -29, 6.4, 2.2, 2.6, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', 7, 29, 6.4, 2.2, 2.6, industrialCoverGeometries, industrialTrimGeometries);
addMapVariantMesh(industrialCoverGeometries, new THREE.MeshLambertMaterial({ color: 0x343c49 }), 'industrial');
addMapVariantMesh(industrialTrimGeometries, new THREE.MeshLambertMaterial({ color: 0x677c87 }), 'industrial');

const snowCoverGeometries: THREE.BufferGeometry[] = [];
createMapVariantCover('snow', -17, -12, 5.8, 2.7, 3.4, snowCoverGeometries);
createMapVariantCover('snow', 17, 12, 5.8, 2.7, 3.4, snowCoverGeometries);
createMapVariantCover('snow', -23, 7, 3.2, 3.2, 7.4, snowCoverGeometries);
createMapVariantCover('snow', 23, -7, 3.2, 3.2, 7.4, snowCoverGeometries);
addMapVariantMesh(snowCoverGeometries, new THREE.MeshLambertMaterial({ color: 0xb6c4ca }), 'snow');

function setMapLayout(style: MapStyle) {
  for (const [variant, meshes] of Object.entries(mapVariantMeshes) as [MapStyle, THREE.Object3D[]][]) {
    for (const mesh of meshes) mesh.visible = variant === style;
  }
}

addMergedArenaMeshes(obstacleGeometryBatch, buildingMaterial);
addMergedArenaMeshes(obstacleTrimGeometryBatch, buildingTrimMaterial);


// Bases
const decorativeFlagPieces: THREE.Object3D[] = [];
function createBase(x: number, z: number, color: number) {
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(5, 5, 0.15, 20),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35
    })
  );
  base.position.set(x, 0.03, z);
  scene.add(base);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 4, 6),
    new THREE.MeshLambertMaterial({ color: 0xdddddd })
  );
  pole.position.set(x, 2, z);
  scene.add(pole);
  decorativeFlagPieces.push(pole);

  const flag = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 0.8, 0.08),
    new THREE.MeshBasicMaterial({ color })
  );
  flag.position.set(x + 0.75, 3.3, z);
  scene.add(flag);
  decorativeFlagPieces.push(flag);
}

function setDecorativeFlagsVisible(visible: boolean) {
  for (const piece of decorativeFlagPieces) piece.visible = visible;
}

createBase(-34, -34, 0x171717); // Time Preto
createBase(34, 34, 0xf2f2f2); // Time Branco

// Rampas decorativas
function createRamp(x: number, z: number, rotation: number) {
  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(7, 0.7, 5),
    new THREE.MeshLambertMaterial({ color: 0x8c927d })
  );
  ramp.position.set(x, 0.35, z);
  ramp.rotation.z = -0.13;
  ramp.rotation.y = rotation;
  scene.add(ramp);
}

createRamp(-30, 0, 0.3);
createRamp(30, 0, -0.3);

// Limites visuais
const boundaryMaterial = new THREE.MeshLambertMaterial({ color: 0x3f5140 });

for (const side of [-1, 1]) {
  const wallX = new THREE.Mesh(
    new THREE.BoxGeometry(1, 3, 112),
    boundaryMaterial
  );
  wallX.position.set(side * 56, 1.5, 0);
  scene.add(wallX);

  const wallZ = new THREE.Mesh(
    new THREE.BoxGeometry(112, 3, 1),
    boundaryMaterial
  );
  wallZ.position.set(0, 1.5, side * 56);
  scene.add(wallZ);
}

// Detalhes de cenário em lote: dezenas de objetos em apenas duas chamadas de desenho.
function addArenaInstancedDetails() {
  const rockGeometry = new THREE.DodecahedronGeometry(0.38, 1);
  const rockPosition = rockGeometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < rockPosition.count; i++) {
    const variation = 0.88 + ((i * 37) % 19) / 100;
    rockPosition.setXYZ(i, rockPosition.getX(i) * variation, rockPosition.getY(i) * (0.9 + variation * 0.1), rockPosition.getZ(i) * variation);
  }
  rockGeometry.computeVertexNormals();
  const rockMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const ROCK_COUNT = 60;
  const SCRUB_COUNT = 75;
  const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, ROCK_COUNT);
  const scrubGeometry = new THREE.BufferGeometry();
  const grassVertices: number[] = [];
  for (let blade = 0; blade < 3; blade++) {
    const angle = blade * Math.PI / 3;
    const sideX = Math.cos(angle) * 0.09, sideZ = Math.sin(angle) * 0.09;
    const tipX = Math.cos(angle + 0.85) * (0.12 + blade * 0.025);
    const tipZ = Math.sin(angle + 0.85) * (0.12 + blade * 0.025);
    const height = 0.42 + blade * 0.075;
    grassVertices.push(-sideX, 0, -sideZ, sideX, 0, sideZ, tipX, height, tipZ);
    grassVertices.push(sideX, 0, sideZ, tipX, height, tipZ, tipX + sideX * 0.35, height * 0.92, tipZ + sideZ * 0.35);
  }
  scrubGeometry.setAttribute('position', new THREE.Float32BufferAttribute(grassVertices, 3));
  scrubGeometry.computeVertexNormals();
  const scrubMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const scrub = new THREE.InstancedMesh(scrubGeometry, scrubMaterial, SCRUB_COUNT);
  const tint = new THREE.Color();
  const dummy = new THREE.Object3D();
  let seed = 74291;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let rockCount = 0, scrubCount = 0, attempts = 0;
  while ((rockCount < ROCK_COUNT || scrubCount < SCRUB_COUNT) && attempts++ < 1800) {
    const x = THREE.MathUtils.randFloat(-51, 51);
    const z = THREE.MathUtils.randFloat(-51, 51);
    if (Math.hypot(x + 34, z + 34) < 9 || Math.hypot(x - 34, z - 34) < 9) continue;
    if (!canMoveTo(new THREE.Vector3(x, 0, z))) continue;
    if (rockCount < ROCK_COUNT && random() < 0.5) {
      const scale = 0.45 + random() * 1.05;
      dummy.position.set(x, 0.12 * scale, z);
      dummy.rotation.set(random() * 0.35, random() * Math.PI, random() * 0.35);
      dummy.scale.set(scale, scale * (0.55 + random() * 0.45), scale);
      dummy.updateMatrix(); rocks.setMatrixAt(rockCount, dummy.matrix);
      tint.setHSL(0.10 + random() * 0.05, 0.08 + random() * 0.12, 0.22 + random() * 0.12); rocks.setColorAt(rockCount++, tint);
    } else if (scrubCount < SCRUB_COUNT) {
      const scale = 0.55 + random() * 0.85;
      dummy.position.set(x, 0.3 * scale, z);
      dummy.rotation.set(0, random() * Math.PI, 0);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix(); scrub.setMatrixAt(scrubCount, dummy.matrix);
      tint.setHSL(0.22 + random() * 0.07, 0.48 + random() * 0.24, 0.20 + random() * 0.13); scrub.setColorAt(scrubCount++, tint);
    }
  }
  rocks.count = rockCount; scrub.count = scrubCount;
  rocks.instanceMatrix.needsUpdate = true; scrub.instanceMatrix.needsUpdate = true;
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
  if (scrub.instanceColor) scrub.instanceColor.needsUpdate = true;
  // Bounds are calculated once after population so Three.js can skip each
  // foliage batch whenever its full bounds leave the camera frustum.
  rocks.computeBoundingSphere(); scrub.computeBoundingSphere();
  rocks.castShadow = false; rocks.receiveShadow = false;
  scrub.castShadow = false; scrub.receiveShadow = false;
  scene.add(rocks, scrub);
}

// =====================================================
// COLISÃO DO TANQUE COM AS CONSTRUÇÕES
// =====================================================

const TANK_RADIUS = 1.25;

function canMoveTo(position: THREE.Vector3): boolean {
  if (
    Math.abs(position.x) > 53 ||
    Math.abs(position.z) > 53
  ) {
    return false;
  }

  for (const obstacle of obstacles) {
    if (obstacle.style && obstacle.style !== mapStyleName) continue;
    const minX = obstacle.center.x - obstacle.halfX - TANK_RADIUS;
    const maxX = obstacle.center.x + obstacle.halfX + TANK_RADIUS;
    const minZ = obstacle.center.z - obstacle.halfZ - TANK_RADIUS;
    const maxZ = obstacle.center.z + obstacle.halfZ + TANK_RADIUS;

    if (
      position.x > minX &&
      position.x < maxX &&
      position.z > minZ &&
      position.z < maxZ
    ) {
      return false;
    }
  }

  return true;
}

// Só gerar os detalhes depois que TANK_RADIUS e canMoveTo estiverem inicializados.
addArenaInstancedDetails();

// =====================================================
// CONSTRUÇÃO DOS TANQUES
// =====================================================

type TankClass = 'light' | 'medium' | 'heavy' | 'artillery';

type TankClassStats = {
  label: string;
  maxHealth: number;
  speed: number;
  damage: number;
  fireRate: number;
  armor: number;
  acceleration: number;
  turnRate: number;
  hullScale: [number, number, number];
  turretScale: [number, number, number];
  barrelScale: [number, number, number];
};

const TANK_CLASSES: Record<TankClass, TankClassStats> = {
  light: { label: 'Leve', maxHealth: 75, speed: 1.28, damage: 0.85, fireRate: 0.78, armor: 0, acceleration: 1.45, turnRate: 1.35, hullScale: [0.88, 0.9, 0.9], turretScale: [0.82, 0.9, 0.82], barrelScale: [0.85, 0.85, 0.85] },
  medium: { label: 'Médio', maxHealth: 100, speed: 1, damage: 1, fireRate: 1, armor: 0.05, acceleration: 1, turnRate: 1, hullScale: [1, 1, 1], turretScale: [1, 1, 1], barrelScale: [1, 1, 1] },
  heavy: { label: 'Pesado', maxHealth: 160, speed: 0.72, damage: 1.35, fireRate: 1.35, armor: 0.22, acceleration: 0.68, turnRate: 0.66, hullScale: [1.18, 1.12, 1.12], turretScale: [1.28, 1.2, 1.28], barrelScale: [1.2, 1.2, 1.2] },
  artillery: { label: 'Artilharia', maxHealth: 85, speed: 0.82, damage: 1.65, fireRate: 1.55, armor: 0, acceleration: 0.78, turnRate: 0.72, hullScale: [1.05, 0.95, 1.12], turretScale: [0.92, 0.85, 0.92], barrelScale: [1.35, 1.1, 1.35] }
};

type ModelRig = {
  body: THREE.Object3D;
  turretNode: THREE.Object3D | null;
  materials: THREE.MeshStandardMaterial[];
  muzzle: THREE.Vector3;
};

type TankParts = {
  root: THREE.Group;
  turret: THREE.Group;
  hull: THREE.Mesh;
  turretBody: THREE.Mesh;
  barrel: THREE.Mesh;
  markings: [THREE.Mesh, THREE.Mesh];
  paintDetailsMaterial: THREE.MeshLambertMaterial;
  trackTreads: THREE.InstancedMesh;
  trackPhase: [number, number];
  wheelRoll: [number, number];
  wheels: THREE.InstancedMesh;
  wheelHubs: THREE.InstancedMesh;
  trackPrintDistance: number;
  unitNumber: number;
  gearSlot: number;
  gearRenderSlot: number;
  gearVisible: boolean;
  gearDetailsVisible: boolean;
  lodDetails: THREE.Object3D[];
  detailsVisible: boolean;
  model?: ModelRig;
};

// Materiais compartilhados por todos os tanques.
const trackDetailMaterial = new THREE.MeshLambertMaterial({ color: 0x55564f });
const darkMetalMaterial = new THREE.MeshLambertMaterial({ color: 0x252a2b });
const edgeMetalMaterial = new THREE.MeshLambertMaterial({ color: 0x89918e });
const glassMaterial = new THREE.MeshLambertMaterial({ color: 0xc98b31 });
const rubberMaterial = new THREE.MeshLambertMaterial({ color: 0x272a28 });
const armorBoltMaterial = new THREE.MeshLambertMaterial({ color: 0x9a958c });
const combinedTankMetalMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });

// Texturas de cor e relevo são compartilhadas pelas ferragens dos tanques.
// Os materiais foscos não carregam o mapa de rugosidade, que só serviria ao brilho PBR.
const tankMetalMaterials = [trackDetailMaterial, darkMetalMaterial, edgeMetalMaterial, armorBoltMaterial, combinedTankMetalMaterial];
const tankMetalLoader = new THREE.TextureLoader();
function loadTankMetalMap(file: string, apply: (texture: THREE.Texture) => void, isColor = false) {
  tankMetalLoader.load(`/textures/${file}`, texture => {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 2);
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    if (isColor) texture.colorSpace = THREE.SRGBColorSpace;
    apply(texture);
    for (const material of tankMetalMaterials) material.needsUpdate = true;
  });
}
loadTankMetalMap('tank_metal_albedo.jpg', texture => { for (const material of tankMetalMaterials) material.map = texture; }, true);
loadTankMetalMap('tank_metal_normal.jpg', texture => { for (const material of tankMetalMaterials) material.normalMap = texture; });

// Marcação de equipe discreta, sem o brilho de neon que deixava a pintura plástica.
const neonCache = new Map<number, THREE.MeshLambertMaterial>();
function neonMaterial(color: number): THREE.MeshLambertMaterial {
  let material = neonCache.get(color);
  if (!material) {
    material = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.52) });
    neonCache.set(color, material);
  }
  return material;
}
const accentFor = (team: 'black' | 'white'): number => team === 'black' ? 0xff7a1a : 0x2ad4ff;
const teamBodyColor = (team: 'black' | 'white'): number => team === 'black' ? 0x596064 : 0xe4e7e8;
const neonStripGeometry = new THREE.BoxGeometry(0.035, 0.07, 3.3);
const neonRingGeometry = new THREE.TorusGeometry(0.875, 0.02, 6, 48);
const neonBarrelRingGeometry = new THREE.TorusGeometry(0.215, 0.02, 6, 20);


// Peças pequenas (usadas só para montar as geometrias mescladas, uma vez).
// Elo de esteira: placa fina + garra (relevo) para fora. O lado de fora é o -Y local.
const treadGeometry = (() => {
  const link = new THREE.BoxGeometry(0.29, 0.10, 0.205);
  const grouser = new THREE.BoxGeometry(0.15, 0.045, 0.165);
  grouser.translate(0, -0.07, 0);
  const merged = mergeGeometries([link, grouser], false)!;
  link.dispose();
  grouser.dispose();
  return merged;
})();
const TRACK_STRAIGHT = 3.52;
const TRACK_RADIUS = 0.34;
const TRACK_LOOP_LENGTH = TRACK_STRAIGHT * 2 + Math.PI * TRACK_RADIUS * 2;
const TRACK_TREAD_COUNT = 44;
const MAX_ACTIVE_TANKS = 8;
const tankGearSlots = new Array<boolean>(MAX_ACTIVE_TANKS).fill(false);
const tankPartsByGearSlot = new Array<TankParts | null>(MAX_ACTIVE_TANKS).fill(null);
let sharedTankTreads: THREE.InstancedMesh;
let sharedTankWheels: THREE.InstancedMesh;
let sharedTankWheelHubs: THREE.InstancedMesh;
const trackInstanceDummy = new THREE.Object3D();
function positionTrackTreads(mesh: THREE.InstancedMesh, phases: [number, number]) {
  const spacing = TRACK_LOOP_LENGTH / TRACK_TREAD_COUNT;
  const frontCenterZ = -1.76;
  const rearCenterZ = 1.76;
  for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
    const side = sideIndex === 0 ? -1 : 1;
    for (let i = 0; i < TRACK_TREAD_COUNT; i++) {
      let distance = (i * spacing + phases[sideIndex]) % TRACK_LOOP_LENGTH;
      if (distance < 0) distance += TRACK_LOOP_LENGTH;
      let y: number, z: number, rotationX: number;
      if (distance < TRACK_STRAIGHT) {
        y = 0.95; z = rearCenterZ - distance; rotationX = Math.PI;
      } else if ((distance -= TRACK_STRAIGHT) < Math.PI * TRACK_RADIUS) {
        const angle = distance / TRACK_RADIUS;
        y = 0.61 + TRACK_RADIUS * Math.cos(angle);
        z = frontCenterZ - TRACK_RADIUS * Math.sin(angle);
        rotationX = Math.PI - angle;
      } else if ((distance -= Math.PI * TRACK_RADIUS) < TRACK_STRAIGHT) {
        y = 0.27; z = frontCenterZ + distance; rotationX = 0;
      } else {
        distance -= TRACK_STRAIGHT;
        const angle = distance / TRACK_RADIUS;
        y = 0.61 - TRACK_RADIUS * Math.cos(angle);
        z = rearCenterZ + TRACK_RADIUS * Math.sin(angle);
        rotationX = -angle;
      }
      trackInstanceDummy.position.set(side * 1.45, y, z);
      trackInstanceDummy.rotation.set(rotationX, 0, 0);
      trackInstanceDummy.updateMatrix();
      mesh.setMatrixAt(sideIndex * TRACK_TREAD_COUNT + i, trackInstanceDummy.matrix);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
}
function advanceTankTreads(parts: TankParts, distance: number, headingChange: number) {
  const leftDistance = distance - headingChange * 1.45;
  const rightDistance = distance + headingChange * 1.45;
  const sideDistances = [leftDistance, rightDistance];
  let rollingGearChanged = false;
  for (let side = 0; side < 2; side++) {
    const delta = sideDistances[side];
    if (Math.abs(delta) < 0.0002) continue;
    parts.trackPhase[side] = (parts.trackPhase[side] + delta + TRACK_LOOP_LENGTH) % TRACK_LOOP_LENGTH;
    parts.wheelRoll[side] += delta / 0.31;
    rollingGearChanged = true;
  }
  if (rollingGearChanged) {
    positionTrackTreads(parts.trackTreads, parts.trackPhase);
    updateTankRollingGear(parts);
    syncTankGearToWorld(parts);
  }
  parts.trackPrintDistance += Math.abs(distance) + Math.abs(headingChange) * 1.45;
  while (parts.trackPrintDistance >= 0.95) {
    addTrackImprintPair(parts.root.position, parts.root.rotation.y);
    parts.trackPrintDistance -= 0.95;
  }
}
function updateTankRollingGear(parts: TankParts) {
  let index = 0;
  for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
    const side = sideIndex === 0 ? -1 : 1;
    for (let wheel = 0; wheel < 6; wheel++) {
      const z = -1.38 + wheel * 0.55;
      trackInstanceDummy.position.set(side * 1.69, 0.57, z);
      trackInstanceDummy.rotation.set(0, -parts.wheelRoll[sideIndex], Math.PI / 2);
      trackInstanceDummy.updateMatrix();
      parts.wheels.setMatrixAt(index, trackInstanceDummy.matrix);
      trackInstanceDummy.position.x = side * 1.79;
      parts.wheelHubs.setMatrixAt(index, trackInstanceDummy.matrix);
      index++;
    }
  }
  parts.wheels.instanceMatrix.needsUpdate = true;
  parts.wheelHubs.instanceMatrix.needsUpdate = true;
}
function makeTrackLoopGeometry(): THREE.ExtrudeGeometry {
  const outer = new THREE.Shape();
  const roundedLoop = (path: THREE.Shape | THREE.Path, halfLength: number, halfHeight: number, radius: number, reverse = false) => {
    if (!reverse) {
      path.moveTo(-halfLength + radius, -halfHeight); path.lineTo(halfLength - radius, -halfHeight);
      path.quadraticCurveTo(halfLength, -halfHeight, halfLength, -halfHeight + radius);
      path.lineTo(halfLength, halfHeight - radius); path.quadraticCurveTo(halfLength, halfHeight, halfLength - radius, halfHeight);
      path.lineTo(-halfLength + radius, halfHeight); path.quadraticCurveTo(-halfLength, halfHeight, -halfLength, halfHeight - radius);
      path.lineTo(-halfLength, -halfHeight + radius); path.quadraticCurveTo(-halfLength, -halfHeight, -halfLength + radius, -halfHeight);
    } else {
      path.moveTo(-halfLength + radius, -halfHeight); path.lineTo(-halfLength, -halfHeight + radius);
      path.lineTo(-halfLength, halfHeight - radius); path.quadraticCurveTo(-halfLength, halfHeight, -halfLength + radius, halfHeight);
      path.lineTo(halfLength - radius, halfHeight); path.quadraticCurveTo(halfLength, halfHeight, halfLength, halfHeight - radius);
      path.lineTo(halfLength, -halfHeight + radius); path.quadraticCurveTo(halfLength, -halfHeight, halfLength - radius, -halfHeight);
      path.lineTo(-halfLength + radius, -halfHeight);
    }
    path.closePath();
  };
  roundedLoop(outer, 1.925, 0.41, 0.38);
  const inner = new THREE.Path();
  roundedLoop(inner, 1.70, 0.245, 0.22, true);
  outer.holes.push(inner);
  const geometry = new THREE.ExtrudeGeometry(outer, { depth: 0.28, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.025, bevelThickness: 0.025, curveSegments: 8 });
  geometry.translate(0, 0, -0.14);
  geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}
const tankTrackGeometry = makeTrackLoopGeometry();
const tankWheelGeometry = new THREE.CylinderGeometry(0.31, 0.31, 0.16, 12);
const wheelHubGeometry = new THREE.CylinderGeometry(0.135, 0.135, 0.174, 8);
function createSharedTankGearMesh(geometry: THREE.BufferGeometry, material: THREE.Material, perTank: number) {
  const mesh = new THREE.InstancedMesh(geometry, material, MAX_ACTIVE_TANKS * perTank);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  scene.add(mesh);
  return mesh;
}
sharedTankTreads = createSharedTankGearMesh(treadGeometry, trackDetailMaterial, TRACK_TREAD_COUNT * 2);
sharedTankWheels = createSharedTankGearMesh(tankWheelGeometry, trackDetailMaterial, 12);
sharedTankWheelHubs = createSharedTankGearMesh(wheelHubGeometry, edgeMetalMaterial, 12);
function allocateTankGearSlot(): number {
  const index = tankGearSlots.indexOf(false);
  if (index < 0) throw new Error('Limite de tanques renderizados excedido.');
  tankGearSlots[index] = true;
  return index;
}
function releaseTankGearSlot(index: number) {
  tankPartsByGearSlot[index] = null;
  tankGearSlots[index] = false;
  rebuildSharedTankGearInstances();
}
const gearLocalMatrix = new THREE.Matrix4();
const gearWorldMatrix = new THREE.Matrix4();
function writeTankGearMatrices(parts: TankParts, renderSlot: number) {
  parts.root.updateMatrixWorld(true);
  const treadOffset = renderSlot * TRACK_TREAD_COUNT * 2;
  for (let i = 0; i < TRACK_TREAD_COUNT * 2; i++) {
    parts.trackTreads.getMatrixAt(i, gearLocalMatrix);
    gearWorldMatrix.multiplyMatrices(parts.root.matrixWorld, gearLocalMatrix);
    sharedTankTreads.setMatrixAt(treadOffset + i, gearWorldMatrix);
  }
  const wheelOffset = renderSlot * 12;
  for (let i = 0; i < 12; i++) {
    parts.wheels.getMatrixAt(i, gearLocalMatrix);
    gearWorldMatrix.multiplyMatrices(parts.root.matrixWorld, gearLocalMatrix);
    sharedTankWheels.setMatrixAt(wheelOffset + i, gearWorldMatrix);
    parts.wheelHubs.getMatrixAt(i, gearLocalMatrix);
    gearWorldMatrix.multiplyMatrices(parts.root.matrixWorld, gearLocalMatrix);
    sharedTankWheelHubs.setMatrixAt(wheelOffset + i, gearWorldMatrix);
  }
}
function rebuildSharedTankGearInstances() {
  let renderSlot = 0;
  for (const parts of tankPartsByGearSlot) {
    if (!parts) continue;
    parts.gearVisible = parts.root.visible;
    if (!parts.gearVisible || !parts.gearDetailsVisible || parts.model) {
      parts.gearRenderSlot = -1;
      continue;
    }
    parts.gearRenderSlot = renderSlot;
    writeTankGearMatrices(parts, renderSlot++);
  }
  sharedTankTreads.count = renderSlot * TRACK_TREAD_COUNT * 2;
  sharedTankWheels.count = renderSlot * 12;
  sharedTankWheelHubs.count = renderSlot * 12;
  sharedTankTreads.instanceMatrix.needsUpdate = true;
  sharedTankWheels.instanceMatrix.needsUpdate = true;
  sharedTankWheelHubs.instanceMatrix.needsUpdate = true;
}
function syncTankGearToWorld(parts: TankParts) {
  if (!parts.root.visible || !parts.gearDetailsVisible || parts.model) {
    if (parts.gearVisible === parts.root.visible && parts.gearRenderSlot < 0) return;
    rebuildSharedTankGearInstances();
    return;
  }
  if (parts.gearRenderSlot < 0 || !parts.gearVisible) {
    rebuildSharedTankGearInstances();
    return;
  }
  parts.gearVisible = true;
  writeTankGearMatrices(parts, parts.gearRenderSlot);
  sharedTankTreads.instanceMatrix.needsUpdate = true;
  sharedTankWheels.instanceMatrix.needsUpdate = true;
  sharedTankWheelHubs.instanceMatrix.needsUpdate = true;
}
const hatchGeometry = new THREE.CylinderGeometry(0.36, 0.40, 0.14, 24);
const headlightGeometry = new THREE.SphereGeometry(0.13, 12, 8);
const boltGeometry = new THREE.SphereGeometry(0.045, 8, 6);
const antennaGeometry = new THREE.CylinderGeometry(0.018, 0.025, 1.05, 8);
const partGeo = {
  glacis: new THREE.BoxGeometry(1.95, 0.18, 0.62),
  rearDeck: new THREE.BoxGeometry(1.82, 0.13, 0.56),
  vent: new THREE.BoxGeometry(0.22, 0.035, 0.40),
  headlightGuard: new THREE.TorusGeometry(0.14, 0.025, 6, 16),
  hinge: new THREE.CylinderGeometry(0.055, 0.055, 0.20, 10),
  rail: new THREE.BoxGeometry(0.07, 0.07, 2.75),
  grille: new THREE.BoxGeometry(0.12, 0.035, 0.46),
  frontArmor: new THREE.BoxGeometry(0.72, 0.12, 0.34),
  marker: new THREE.BoxGeometry(0.16, 0.08, 0.08),
  turretRing: new THREE.TorusGeometry(0.91, 0.075, 10, 40),
  muzzleRing: new THREE.TorusGeometry(0.20, 0.035, 8, 20),
  hatchTop: new THREE.CylinderGeometry(0.29, 0.31, 0.055, 24),
  periscope: new THREE.BoxGeometry(0.22, 0.16, 0.18),
  mantlet: new THREE.SphereGeometry(0.34, 20, 14),
  sensorBody: new THREE.CylinderGeometry(0.09, 0.12, 0.10, 16),
  sensorGlass: new THREE.SphereGeometry(0.065, 12, 8),
  turretPlate: new THREE.BoxGeometry(0.16, 0.34, 0.92, 2, 2, 3)
};
const sideArmorGeometry = new THREE.BoxGeometry(0.20, 0.34, 1.02);

// Textura procedural de pintura militar: gerada uma vez em tom neutro e tingida por material.
// Tanques de todas as cores compartilham o mesmo mapa e o mesmo mapa de relevo.
type TankPaintTextures = { map: THREE.CanvasTexture; bump: THREE.CanvasTexture };
let tankPaintTextures: TankPaintTextures | null = null;
function getTankPaintTextures(): TankPaintTextures {
  if (tankPaintTextures) return tankPaintTextures;

  const size = 2048;
  const colorCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  for (const canvas of [colorCanvas, bumpCanvas]) {
    canvas.width = size;
    canvas.height = size;
  }

  const c = colorCanvas.getContext('2d')!;
  const b = bumpCanvas.getContext('2d')!;
  const rgb = [238, 238, 238];
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

  c.fillStyle = `rgb(${rgb.join(',')})`;
  c.fillRect(0, 0, size, size);
  b.fillStyle = '#808080';
  b.fillRect(0, 0, size, size);

  // Variação de tinta em nuvens largas.
  for (let i = 0; i < 260; i++) {
    const x = rand() * size, y = rand() * size;
    const rx = 22 + rand() * 115, ry = 12 + rand() * 72;
    const shade = 0.68 + rand() * 0.62;
    const alpha = 0.07 + rand() * 0.17;
    c.fillStyle = `rgba(${clamp(rgb[0] * shade)},${clamp(rgb[1] * shade)},${clamp(rgb[2] * shade)},${alpha})`;
    c.beginPath();
    c.ellipse(x, y, rx, ry, rand() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }

  // Manchas de camuflagem irregulares com bordas suaves.
  for (let i = 0; i < 170; i++) {
    const x = rand() * size, y = rand() * size;
    const rx = 18 + rand() * 78, ry = 10 + rand() * 44;
    const factor = rand() > 0.5 ? 0.42 : 1.48;
    c.save();
    c.translate(x, y);
    c.rotate((rand() - 0.5) * 1.2);
    const alpha = 0.24 + rand() * 0.26;
    c.fillStyle = `rgba(${clamp(rgb[0] * factor)},${clamp(rgb[1] * factor)},${clamp(rgb[2] * factor)},${alpha})`;
    c.beginPath();
    c.moveTo(-rx, 0);
    c.bezierCurveTo(-rx * 0.8, -ry * 1.2, rx * 0.35, -ry * 1.5, rx, -ry * 0.15);
    c.bezierCurveTo(rx * 1.25, ry * 0.6, -rx * 0.1, ry * 1.35, -rx, 0);
    c.fill();
    c.restore();
  }

  // Poeira acumulada nas áreas inferiores.
  const dust = c.createLinearGradient(0, size * 0.48, 0, size);
  dust.addColorStop(0, 'rgba(120,105,78,0)');
  dust.addColorStop(0.72, 'rgba(118,101,73,0.07)');
  dust.addColorStop(1, 'rgba(35,31,24,0.22)');
  c.fillStyle = dust;
  c.fillRect(0, 0, size, size);

  // Arranhões finos com brilho metálico nas bordas.
  for (let i = 0; i < 6200; i++) {
    const x = rand() * size, y = rand() * size;
    const len = 2 + rand() * 36;
    const dx = (rand() - 0.5) * len * 0.55;
    const dy = len;
    const alpha = 0.05 + rand() * 0.22;
    const bright = rand() > 0.52;
    c.strokeStyle = bright
      ? `rgba(218,211,190,${alpha})`
      : `rgba(15,19,17,${alpha * 1.2})`;
    c.lineWidth = 0.25 + rand() * 1.2;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + dx, y + dy);
    c.stroke();

    b.strokeStyle = `rgba(${bright ? 205 : 45},${bright ? 205 : 45},${bright ? 205 : 45},${0.16 + rand() * 0.2})`;
    b.lineWidth = 0.4 + rand() * 1.1;
    b.beginPath();
    b.moveTo(x, y);
    b.lineTo(x + dx, y + dy);
    b.stroke();
  }

  // Lascas pontuais: centro escuro e borda de metal exposto.
  for (let i = 0; i < 980; i++) {
    const x = rand() * size, y = rand() * size;
    const w = 1 + rand() * 4.5, h = 1 + rand() * 2.8;
    c.fillStyle = `rgba(15,18,17,${0.18 + rand() * 0.32})`;
    c.fillRect(x, y, w, h);
    c.fillStyle = `rgba(178,169,145,${0.12 + rand() * 0.24})`;
    c.fillRect(x, y, w * 0.65, Math.max(0.5, h * 0.35));
    b.fillStyle = `rgba(225,225,225,${0.22 + rand() * 0.24})`;
    b.fillRect(x, y, w, h);
  }

  // Parafusos/rebites impressos discretamente na textura para dar escala.
  for (let i = 0; i < 180; i++) {
    const x = rand() * size, y = rand() * size, radius = 1.2 + rand() * 1.8;
    c.fillStyle = 'rgba(18,22,22,0.32)';
    c.beginPath(); c.arc(x + 1, y + 1, radius, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(190,190,180,0.32)';
    c.beginPath(); c.arc(x, y, radius * 0.72, 0, Math.PI * 2); c.fill();
  }

  const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = maxAnisotropy;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;

  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = maxAnisotropy;
  bump.generateMipmaps = true;

  tankPaintTextures = { map, bump };
  return tankPaintTextures;
}

const tankPaintCache = new Map<number, THREE.MeshLambertMaterial[]>();
function makeTankPaintSet(baseColor: number): THREE.MeshLambertMaterial[] {
  const cached = tankPaintCache.get(baseColor);
  if (cached) return cached;

  const textures = getTankPaintTextures();
  const main = new THREE.MeshLambertMaterial({
    color: baseColor,
    map: textures.map,
    bumpMap: textures.bump,
    bumpScale: 0.055
  });
  const dark = main.clone();
  dark.color.setHex(baseColor).multiplyScalar(0.72);
  const light = main.clone();
  light.color.setHex(baseColor);
  const set = [main, dark, light];
  tankPaintCache.set(baseColor, set);
  return set;
}

function makeHullGeometry(profile: TankClass = 'medium'): THREE.BufferGeometry {
  // Carcaça por seções longitudinais: glacis dianteiro inclinado, teto e blindagem traseira.
  const baseSections = [
    { z: -1.74, width: 0.82, topWidth: 0.65, topY: -0.03 },
    { z: -1.30, width: 1.12, topWidth: 0.94, topY: 0.39 },
    { z: 0.86, width: 1.12, topWidth: 1.02, topY: 0.39 },
    { z: 1.52, width: 0.98, topWidth: 0.82, topY: 0.24 },
    { z: 1.74, width: 0.82, topWidth: 0.65, topY: -0.03 }
  ];
  // Cada classe recebe um casco com silhueta própria antes da escala de gameplay.
  const profileShape: Record<TankClass, { width: number; length: number; height: number; nose: number }> = {
    light: { width: 0.87, length: 0.88, height: 0.94, nose: 0.88 },
    medium: { width: 1, length: 1, height: 1, nose: 1 },
    heavy: { width: 1.10, length: 1.08, height: 1.08, nose: 1.12 },
    artillery: { width: 0.96, length: 1.20, height: 0.82, nose: 1.25 }
  };
  const shape = profileShape[profile];
  const sections = baseSections.map(section => ({
    z: section.z * shape.length,
    width: section.width * shape.width,
    topWidth: section.topWidth * shape.width,
    topY: section.topY * shape.height,
    nose: section.z < -1.3 ? shape.nose : 1
  }));
  const ring: Vec3[][] = sections.map(section => {
    const bottom = -0.34;
    const lower = bottom + 0.15;
    const w = section.width;
    const t = section.topWidth;
    const y = section.topY;
    return [
      [-w * 0.78, bottom, section.z], [w * 0.78, bottom, section.z],
      [w, lower, section.z], [w, y - 0.13 * section.nose, section.z],
      [t, y, section.z], [-t, y, section.z],
      [-w, y - 0.13 * section.nose, section.z], [-w, lower, section.z]
    ];
  });
  const positions: number[] = [];
  const indices: number[] = [];
  for (const section of ring) for (const point of section) positions.push(...point);
  const count = ring[0].length;
  for (let section = 0; section < ring.length - 1; section++) {
    for (let corner = 0; corner < count; corner++) {
      const a = section * count + corner;
      const b = section * count + (corner + 1) % count;
      const c = (section + 1) * count + corner;
      const d = (section + 1) * count + (corner + 1) % count;
      indices.push(a, b, c, b, d, c);
    }
  }
  // Fechamento dianteiro e traseiro.
  const frontCenter = positions.length / 3;
  positions.push(0, 0, sections[0].z);
  const backCenter = positions.length / 3;
  positions.push(0, 0, sections[sections.length - 1].z);
  for (let corner = 0; corner < count; corner++) {
    indices.push(frontCenter, (corner + 1) % count, corner);
    const base = (ring.length - 1) * count;
    indices.push(backCenter, base + corner, base + (corner + 1) % count);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  // Painéis chapados (cada face com sua própria luz) + UV para a textura de tinta aparecer no casco.
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  flat.computeVertexNormals();
  const pos = flat.attributes.position;
  const nor = flat.attributes.normal;
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u: number, v: number;
    if (ax >= ay && ax >= az) { u = pos.getZ(i); v = pos.getY(i); }
    else if (ay >= az) { u = pos.getX(i); v = pos.getZ(i); }
    else { u = pos.getX(i); v = pos.getY(i); }
    uvs[i * 2] = u * 0.4;
    uvs[i * 2 + 1] = v * 0.4;
  }
  flat.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return flat;
}

function makeAngularTurretGeometry(width: number, depth: number, height: number, bevel: number, profile: TankClass = 'medium'): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const outlines: Record<TankClass, Array<[number, number]>> = {
    light: [[-0.48, 0.78], [0.48, 0.78], [0.72, 0.44], [0.69, -0.42], [0.42, -0.72], [-0.42, -0.72], [-0.69, -0.42], [-0.72, 0.44]],
    medium: [[-0.50, 0.76], [0.50, 0.76], [0.83, 0.43], [0.88, -0.43], [0.55, -0.77], [-0.55, -0.77], [-0.88, -0.43], [-0.83, 0.43]],
    heavy: [[-0.70, 0.72], [0.70, 0.72], [0.96, 0.38], [1.00, -0.38], [0.72, -0.82], [-0.72, -0.82], [-1.00, -0.38], [-0.96, 0.38]],
    artillery: [[-0.42, 0.82], [0.42, 0.82], [0.72, 0.48], [0.92, -0.48], [0.82, -0.82], [-0.82, -0.82], [-0.92, -0.48], [-0.72, 0.48]]
  };
  outlines[profile].forEach(([x, y], index) => index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height, bevelEnabled: true, bevelSegments: 2,
    bevelSize: bevel, bevelThickness: bevel, curveSegments: 1
  });
  geometry.scale(width, depth, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -height / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}
const hullGeometryByClass: Record<TankClass, THREE.BufferGeometry> = {
  light: makeHullGeometry('light'),
  medium: makeHullGeometry('medium'),
  heavy: makeHullGeometry('heavy'),
  artillery: makeHullGeometry('artillery')
};
const turretGeometryByClass: Record<TankClass, THREE.ExtrudeGeometry> = {
  light: makeAngularTurretGeometry(0.95, 0.82, 0.50, 0.035, 'light'),
  medium: makeAngularTurretGeometry(1.02, 0.91, 0.60, 0.045, 'medium'),
  heavy: makeAngularTurretGeometry(1.10, 1.00, 0.68, 0.065, 'heavy'),
  artillery: makeAngularTurretGeometry(0.96, 1.08, 0.54, 0.035, 'artillery')
};
const turretTopGeometry = makeAngularTurretGeometry(0.82, 0.75, 0.14, 0.025);
const barrelGeometry = new THREE.CylinderGeometry(0.155, 0.225, 2.55, 32, 3);
const barrelSleeveGeometry = new THREE.CylinderGeometry(0.245, 0.245, 0.38, 20, 1);
const muzzleGeometry = new THREE.CylinderGeometry(0.22, 0.22, 0.32, 16, 1);

// ---- Mescla de peças: dezenas de detalhes viram poucos meshes (1 por material) ----
type PartSlot = 'paintDark' | 'paintLight' | 'rubber' | 'tread' | 'edge' | 'dark' | 'glass' | 'bolt' | 'neon';
type Vec3 = [number, number, number];

function createPartBatch() {
  const lists = new Map<PartSlot, THREE.BufferGeometry[]>();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();
  return {
    add(slot: PartSlot, source: THREE.BufferGeometry, pos: Vec3, rot: Vec3 = [0, 0, 0], scl: Vec3 = [1, 1, 1]) {
      position.set(pos[0], pos[1], pos[2]);
      quaternion.setFromEuler(euler.set(rot[0], rot[1], rot[2]));
      scale.set(scl[0], scl[1], scl[2]);
      matrix.compose(position, quaternion, scale);
      const geometry = source.clone().applyMatrix4(matrix);
      const list = lists.get(slot);
      if (list) list.push(geometry); else lists.set(slot, [geometry]);
    },
    build(): Map<PartSlot, THREE.BufferGeometry> {
      const result = new Map<PartSlot, THREE.BufferGeometry>();
      for (const [slot, list] of lists) {
        const merged = mergeGeometries(list, false);
        for (const geometry of list) geometry.dispose();
        if (merged) result.set(slot, merged);
      }
      return result;
    }
  };
}

let bodyPartsCache: Map<PartSlot, THREE.BufferGeometry> | null = null;
function getBodyParts(): Map<PartSlot, THREE.BufferGeometry> {
  if (bodyPartsCache) return bodyPartsCache;
  const batch = createPartBatch();
  for (const side of [-1, 1]) {
    // Esteira, rodas, cubos e elos.
    batch.add('rubber', tankTrackGeometry, [side * 1.43, 0.61, 0]);
    // Placas laterais.
    for (let i = 0; i < 3; i++) {
      batch.add('paintDark', sideArmorGeometry, [side * 1.56, 0.94, -0.95 + i * 0.95], [i === 0 ? -0.05 : i === 2 ? 0.05 : 0, 0, 0]);
    }

    // Faróis e aros.
    batch.add('glass', headlightGeometry, [side * 0.86, 0.98, -1.76]);
    batch.add('edge', partGeo.headlightGuard, [side * 0.86, 0.98, -1.76], [Math.PI / 2, 0, 0]);

    // Parafusos.
    for (let i = 0; i < 6; i++) batch.add('bolt', boltGeometry, [side * 1.68, 1.08, -1.28 + i * 0.48]);
    for (let i = 0; i < 6; i++) batch.add('bolt', boltGeometry, [side * 0.88, 1.23, -0.92 + i * 0.36]);

    // Dobradiças e trilhos.
    for (let i = 0; i < 4; i++) batch.add('edge', partGeo.hinge, [side * 1.72, 1.02, -1.05 + i * 0.67], [0, 0, Math.PI / 2]);
    batch.add('edge', partGeo.rail, [side * 1.72, 1.25, 0.05]);

    // Placas frontais e marcadores.
    batch.add('paintDark', partGeo.frontArmor, [side * 0.60, 1.18, -1.62], [-0.22, 0, 0]);
    batch.add('glass', partGeo.marker, [side * 0.98, 1.04, -1.76]);

    // Faixa neon lateral.
    batch.add('neon', neonStripGeometry, [side * 1.738, 0.93, 0]);
  }
  batch.add('paintLight', partGeo.glacis, [0, 1.10, -1.43], [-0.28, 0, 0]);
  batch.add('paintDark', partGeo.rearDeck, [0, 1.20, 1.40]);
  for (let i = 0; i < 5; i++) batch.add('dark', partGeo.vent, [-0.66 + i * 0.33, 1.29, 1.40]);
  for (let i = 0; i < 7; i++) batch.add('dark', partGeo.grille, [-0.72 + i * 0.24, 1.31, 1.49], [-0.08, 0, 0]);
  bodyPartsCache = batch.build();
  return bodyPartsCache;
}

const turretPartsCache = new Map<TankClass, Map<PartSlot, THREE.BufferGeometry>>();
function getTurretParts(tankClass: TankClass): Map<PartSlot, THREE.BufferGeometry> {
  const cached = turretPartsCache.get(tankClass);
  if (cached) return cached;
  const stats = TANK_CLASSES[tankClass];
  const batch = createPartBatch();

  batch.add('paintLight', turretTopGeometry, [0, 0.53, 0], [0, 0, 0], [stats.turretScale[0], 1, stats.turretScale[2]]);
  batch.add('edge', partGeo.turretRing, [0, -0.10, 0], [Math.PI / 2, 0, 0]);
  batch.add('edge', barrelSleeveGeometry, [0, 0.28, -0.48], [Math.PI / 2, 0, 0]);
  batch.add('neon', neonRingGeometry, [0, 0.43, 0], [Math.PI / 2, 0, 0], [stats.turretScale[0], stats.turretScale[2], 1]);
  batch.add('neon', neonBarrelRingGeometry, [0, 0.28, -1.9], [0, 0, 0], [stats.barrelScale[0], stats.barrelScale[0], 1]);
  batch.add('dark', muzzleGeometry, [0, 0.28, -2.58], [Math.PI / 2, 0, 0]);
  batch.add('edge', partGeo.muzzleRing, [0, 0.28, -2.73], [Math.PI / 2, 0, 0]);
  batch.add('dark', hatchGeometry, [0.48, 0.62, 0.20]);
  batch.add('paintDark', partGeo.hatchTop, [0.48, 0.72, 0.20]);
  batch.add('glass', partGeo.periscope, [-0.43, 0.67, 0.32]);
  batch.add('dark', antennaGeometry, [-0.68, 0.92, 0.48], [0, 0, -0.08]);
  batch.add('glass', boltGeometry, [-0.72, 1.45, 0.48]);
  batch.add('dark', partGeo.mantlet, [0, 0.28, -0.72], [0, 0, 0], [1.35, 0.78, 0.9]);

  for (const side of [-1, 1]) {
    batch.add('edge', partGeo.sensorBody, [side * 0.62, 0.61, -0.12]);
    batch.add('glass', partGeo.sensorGlass, [side * 0.62, 0.68, -0.12]);
    for (let section = 0; section < 2; section++) {
      batch.add('paintDark', partGeo.turretPlate, [side * 0.82, 0.19, section === 0 ? -0.18 : 0.70], [0, 0, side * -0.035], [1, 1, section === 0 ? 0.88 : 0.72]);
      for (let bolt = 0; bolt < 4; bolt++) {
        batch.add('bolt', boltGeometry,
          [side * 0.925, 0.08 + (bolt % 2) * 0.22, (section === 0 ? -0.48 : 0.42) + Math.floor(bolt / 2) * 0.30],
          [0, 0, 0], [0.72, 0.72, 0.72]);
      }
    }
  }
  const built = batch.build();
  turretPartsCache.set(tankClass, built);
  return built;
}

const combinedTankPartGeometryCache = new WeakMap<
  Map<PartSlot, THREE.BufferGeometry>,
  Map<string, THREE.BufferGeometry>
>();
function combineTankPartSlots(
  parts: Map<PartSlot, THREE.BufferGeometry>,
  key: string,
  slotTints: Partial<Record<PartSlot, THREE.Color>>
): THREE.BufferGeometry | null {
  let cache = combinedTankPartGeometryCache.get(parts);
  if (!cache) {
    cache = new Map();
    combinedTankPartGeometryCache.set(parts, cache);
  }
  const cached = cache.get(key);
  if (cached) return cached;

  const geometries: THREE.BufferGeometry[] = [];
  for (const [slot, tint] of Object.entries(slotTints) as Array<[PartSlot, THREE.Color]>) {
    const source = parts.get(slot);
    if (!source || !tint) continue;
    const geometry = source.clone();
    const color = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      color[i * 3] = tint.r;
      color[i * 3 + 1] = tint.g;
      color[i * 3 + 2] = tint.b;
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
    geometries.push(geometry);
  }
  if (!geometries.length) return null;
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (merged) cache.set(key, merged);
  return merged;
}

const markingMaterialCache = new Map<string, THREE.MeshBasicMaterial>();
function tankMarkingMaterial(accent: number, unitNumber: number): THREE.MeshBasicMaterial {
  const key = `${accent}:${unitNumber}`;
  const cached = markingMaterialCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(12,16,16,.82)';
  ctx.beginPath(); ctx.roundRect(5, 9, 246, 110, 9); ctx.fill();
  ctx.strokeStyle = `#${accent.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 6; ctx.stroke();
  ctx.fillStyle = `#${accent.toString(16).padStart(6, '0')}`;
  ctx.fillRect(14, 18, 12, 92);
  ctx.fillStyle = '#f0f1eb';
  ctx.font = 'bold 66px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(unitNumber).padStart(2, '0'), 145, 57);
  ctx.font = 'bold 15px Arial'; ctx.fillText('TANK ARENA', 145, 98);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  markingMaterialCache.set(key, material);
  return material;
}

function makeTankSideMarkingGeometry(x: number, y: number, z: number, width: number, height: number): THREE.BufferGeometry {
  const planes: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const plane = new THREE.PlaneGeometry(width, height);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * Math.PI / 2);
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(side * x, y, z), rotation, new THREE.Vector3(1, 1, 1));
    planes.push(plane.applyMatrix4(matrix));
  }
  const merged = mergeGeometries(planes, false)!;
  for (const plane of planes) plane.dispose();
  return merged;
}

function buildTank(color: number, tankClass: TankClass = 'medium', accent: number = 0xff7a1a, unitNumber = 1): TankParts {
  const root = new THREE.Group();
  const gearSlot = allocateTankGearSlot();
  const contactShadow = new THREE.Mesh(tankContactShadowGeometry, tankContactShadowMaterial);
  contactShadow.position.y = 0.012;
  contactShadow.scale.set(2.05, 1, 2.9);
  contactShadow.renderOrder = 1;
  contactShadow.castShadow = false;
  contactShadow.receiveShadow = false;
  contactShadow.userData.contactShadow = true;
  root.add(contactShadow);
  const lodDetails: THREE.Object3D[] = [];
  const classStats = TANK_CLASSES[tankClass];
  const [paint, paintDark, paintLight] = makeTankPaintSet(color);
  const paintDetailsMaterial = paint.clone();
  paintDetailsMaterial.vertexColors = true;
  const paintDarkTint = new THREE.Color(0xffffff).multiplyScalar(0.72);
  const bodyParts = getBodyParts();
  const bodyPaintGeometry = combineTankPartSlots(bodyParts, 'paint', {
    paintDark: paintDarkTint,
    paintLight: new THREE.Color(0xffffff)
  });
  const bodyMetalGeometry = combineTankPartSlots(bodyParts, 'metal', {
    edge: edgeMetalMaterial.color,
    dark: darkMetalMaterial.color,
    bolt: armorBoltMaterial.color,
    tread: trackDetailMaterial.color
  });
  const slotMaterial = (slot: PartSlot): THREE.Material => {
    switch (slot) {
      case 'paintDark': return paintDark;
      case 'paintLight': return paintLight;
      case 'rubber': return rubberMaterial;
      case 'tread': return trackDetailMaterial;
      case 'edge': return edgeMetalMaterial;
      case 'dark': return darkMetalMaterial;
      case 'glass': return glassMaterial;
      case 'neon': return neonMaterial(accent);
      default: return armorBoltMaterial;
    }
  };

  // Casco com blindagem inclinada.
  const hull = new THREE.Mesh(hullGeometryByClass[tankClass], paint);
  hull.position.y = 0.88;
  hull.scale.set(...classStats.hullScale);
  hull.castShadow = true;
  hull.receiveShadow = true;
  root.add(hull);

  const bodyHandledSlots = new Set<PartSlot>();
  if (bodyPaintGeometry) {
    root.add(new THREE.Mesh(bodyPaintGeometry, paintDetailsMaterial));
    bodyHandledSlots.add('paintDark'); bodyHandledSlots.add('paintLight');
  }
  if (bodyMetalGeometry) {
    const metal = new THREE.Mesh(bodyMetalGeometry, combinedTankMetalMaterial);
    root.add(metal);
    lodDetails.push(metal);
    bodyHandledSlots.add('edge'); bodyHandledSlots.add('dark'); bodyHandledSlots.add('bolt'); bodyHandledSlots.add('tread');
  }
  // Reúna placas por mapa de material; os detalhes usam LOD a curta distância.
  for (const [slot, geometry] of bodyParts) {
    if (bodyHandledSlots.has(slot)) continue;
    const part = new THREE.Mesh(geometry, slotMaterial(slot));
    if (slot === 'neon') part.userData.neon = true;
    root.add(part);
    if (slot !== 'rubber') lodDetails.push(part);
  }
  const trackTreads = new THREE.InstancedMesh(treadGeometry, trackDetailMaterial, TRACK_TREAD_COUNT * 2);
  trackTreads.visible = false;
  trackTreads.userData.garageGearProxy = true;
  trackTreads.frustumCulled = false;
  trackTreads.castShadow = false;
  trackTreads.receiveShadow = true;
  trackTreads.userData.tankRunningGear = true;
  root.add(trackTreads);
  const wheels = new THREE.InstancedMesh(tankWheelGeometry, trackDetailMaterial, 12);
  const wheelHubs = new THREE.InstancedMesh(wheelHubGeometry, edgeMetalMaterial, 12);
  for (const gear of [wheels, wheelHubs]) {
    gear.visible = false;
    gear.userData.garageGearProxy = true;
    gear.frustumCulled = false;
    gear.castShadow = false;
    gear.receiveShadow = true;
    gear.userData.tankRunningGear = true;
    root.add(gear);
  }
  const hullMarkings = new THREE.Mesh(makeTankSideMarkingGeometry(1.74, 1.00, 0.16, 0.72, 0.30), tankMarkingMaterial(accent, unitNumber));
  hullMarkings.renderOrder = 1;
  root.add(hullMarkings);

  const turret = new THREE.Group();
  turret.position.set(0, 1.38, 0);
  root.add(turret);

  const turretBody = new THREE.Mesh(turretGeometryByClass[tankClass], paint);
  turretBody.position.y = 0.18;
  turretBody.scale.set(...classStats.turretScale);
  turretBody.castShadow = true;
  turretBody.receiveShadow = true;
  turret.add(turretBody);

  const barrel = new THREE.Mesh(barrelGeometry, darkMetalMaterial);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.28, -1.27);
  barrel.scale.set(...classStats.barrelScale);
  barrel.castShadow = true;
  turret.add(barrel);

  const turretParts = getTurretParts(tankClass);
  const turretPaintGeometry = combineTankPartSlots(turretParts, 'paint', {
    paintDark: paintDarkTint,
    paintLight: new THREE.Color(0xffffff)
  });
  const turretMetalGeometry = combineTankPartSlots(turretParts, 'metal', {
    edge: edgeMetalMaterial.color,
    dark: darkMetalMaterial.color,
    bolt: armorBoltMaterial.color,
    tread: trackDetailMaterial.color
  });
  const turretHandledSlots = new Set<PartSlot>();
  if (turretPaintGeometry) {
    turret.add(new THREE.Mesh(turretPaintGeometry, paintDetailsMaterial));
    turretHandledSlots.add('paintDark'); turretHandledSlots.add('paintLight');
  }
  if (turretMetalGeometry) {
    const metal = new THREE.Mesh(turretMetalGeometry, combinedTankMetalMaterial);
    turret.add(metal);
    lodDetails.push(metal);
    turretHandledSlots.add('edge'); turretHandledSlots.add('dark'); turretHandledSlots.add('bolt'); turretHandledSlots.add('tread');
  }
  // Peças menores continuam em lotes separados só quando têm outro mapa ou cor.
  for (const [slot, geometry] of turretParts) {
    if (turretHandledSlots.has(slot)) continue;
    const part = new THREE.Mesh(geometry, slotMaterial(slot));
    if (slot === 'neon') part.userData.neon = true;
    turret.add(part);
    lodDetails.push(part);
  }
  const turretMarkings = new THREE.Mesh(makeTankSideMarkingGeometry(1.04 * classStats.turretScale[0], 0.22, 0.18, 0.62, 0.25), tankMarkingMaterial(accent, unitNumber));
  turretMarkings.renderOrder = 1;
  turret.add(turretMarkings);

  const parts: TankParts = {
    root, turret, hull, turretBody, barrel,
    markings: [hullMarkings, turretMarkings], paintDetailsMaterial,
    trackTreads, trackPhase: [0, 0], wheelRoll: [0, 0], wheels, wheelHubs,
    trackPrintDistance: 0, unitNumber, gearSlot, gearRenderSlot: -1,
    gearVisible: true, gearDetailsVisible: true, lodDetails, detailsVisible: true
  };
  positionTrackTreads(trackTreads, parts.trackPhase);
  updateTankRollingGear(parts);
  tankPartsByGearSlot[gearSlot] = parts;
  rebuildSharedTankGearInstances();
  return parts;
}

// Keep full tank details nearby. At range the continuous track shell replaces
// moving treads and wheels, which are too small to read and expensive to draw.
function updateTankDetailLod(parts: TankParts, cameraPosition: THREE.Vector3) {
  if (parts.model) return;
  const distanceSq = cameraPosition.distanceToSquared(parts.root.position);
  const detailThreshold = parts.detailsVisible ? 9 : 8;
  const showDetails = distanceSq < detailThreshold * detailThreshold;
  if (showDetails !== parts.detailsVisible) {
    parts.detailsVisible = showDetails;
    for (const object of parts.lodDetails) object.visible = showDetails;
  }
  const gearThreshold = parts.gearDetailsVisible ? 17 : 14;
  const showGearDetails = distanceSq < gearThreshold * gearThreshold;
  if (showGearDetails !== parts.gearDetailsVisible) {
    parts.gearDetailsVisible = showGearDetails;
    rebuildSharedTankGearInstances();
  }
}

// =====================================================
// MODELOS 3D REAIS (glTF/GLB) - OPCIONAIS, COM FALLBACK PROCEDURAL
// Coloque os arquivos em public/models/. Se um arquivo não existir, o tanque procedural continua.
// Convenções do modelo (veja LEIA-ME_ASSETS.md):
//   - frente do tanque apontando para -Z, chão em y = 0 (o jogo reescala e centraliza sozinho)
//   - um nó chamado "Turret" (ou torre/tower) com o pivô no centro da torre, contendo o canhão
//   - materiais com "Paint"/"Body" no nome recebem a cor do jogador/time; "Neon"/"Glow" recebem o neon da equipe
// =====================================================
const MODEL_URLS: Record<TankClass, string> = {
  // Modelos low-poly CC0 (Quaternius), já girados e dimensionados. Se faltar o arquivo, o tanque procedural continua.
  light: '/models/tank_light.glb',
  medium: '/models/tank_medium.glb',
  heavy: '/models/tank_heavy.glb',
  artillery: '/models/tank_artillery.glb'
};
const DEFAULT_MUZZLE = new THREE.Vector3(0, 0.2, -2.4);
const TURRET_NODE_NAME = /turret|torre|tower/i;
const PAINT_MATERIAL_NAME = /paint|body|camo|hull|pintura|tinta|sandpaint|^olive$/i;
const NEON_MATERIAL_NAME = /neon|glow|emiss/i;
const modelTemplates = new Map<TankClass, THREE.Group>();
let playerPaintColor = 0x5c6240;

function prepareModelTemplate(source: THREE.Object3D, _cls: TankClass, file: string): THREE.Group {
  // Os .glb já vêm centralizados, com a frente em -Z, chão em y = 0 e no tamanho final.
  const template = new THREE.Group();
  template.add(source);
  template.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(template).getSize(new THREE.Vector3());
  if (size.x > size.z * 1.15) console.warn(`[Tank Arena] ${file}: o modelo parece estar de lado. A frente deve apontar para -Z.`);
  return template;
}

function setProceduralVisible(parts: TankParts, visible: boolean) {
  for (const child of parts.root.children) {
    if (child === parts.turret || (child as THREE.Sprite).isSprite || child.userData.modelRoot || child.userData.contactShadow) continue;
    child.visible = visible;
  }
  for (const child of parts.turret.children) {
    if (child.userData.modelTurret) continue;
    child.visible = visible;
  }
}

function removeTankModel(parts: TankParts) {
  const rig = parts.model;
  if (!rig) return;
  parts.root.remove(rig.body);
  if (rig.turretNode) parts.turret.remove(rig.turretNode);
  parts.turret.position.set(0, 1.38, 0);
  for (const material of rig.materials) { releaseEnv(material); material.dispose(); }
  parts.model = undefined;
  setProceduralVisible(parts, true);
  parts.detailsVisible = true;
  rebuildSharedTankGearInstances();
}

function applyTankModel(parts: TankParts, cls: TankClass, color: number, accent: number) {
  removeTankModel(parts);
  const template = modelTemplates.get(cls);
  if (!template) return;

  const body = template.clone(true);
  body.userData.modelRoot = true;
  const rig: ModelRig = { body, turretNode: null, materials: [], muzzle: DEFAULT_MUZZLE.clone() };

  body.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.userData.modelMesh = true;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    const original = mesh.material;
    if (Array.isArray(original)) return;
    const name = original.name.toLowerCase();
    if (NEON_MATERIAL_NAME.test(name)) {
      mesh.material = neonMaterial(accent);
      mesh.userData.neon = true;
      return;
    }
    if (!(original as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
    const clone = (original as THREE.MeshStandardMaterial).clone();
    if (PAINT_MATERIAL_NAME.test(name)) clone.color.setHex(color).multiplyScalar(typeof original.userData.shade === 'number' ? original.userData.shade : 1);
    clone.userData.baseEmissive = clone.emissive.getHex();
    useEnv(clone, 0.55);
    mesh.material = clone;
    rig.materials.push(clone);
  });

  parts.root.add(body);
  setProceduralVisible(parts, false);

  // Anexa a torre do modelo ao pivô giratório do jogo (com casco e torre alinhados em zero).
  const savedRoot = parts.root.rotation.y;
  const savedTurret = parts.turret.rotation.y;
  parts.root.rotation.y = 0;
  parts.turret.rotation.y = 0;
  parts.root.updateMatrixWorld(true);
  const found: THREE.Object3D[] = [];
  body.traverse(object => { if (object !== body && TURRET_NODE_NAME.test(object.name)) found.push(object); });
  if (found.length > 0) {
    const pivot = parts.root.worldToLocal(found[0].getWorldPosition(new THREE.Vector3()));
    parts.turret.position.copy(pivot);
    parts.turret.updateMatrixWorld(true);
    const turretAssembly = new THREE.Group();
    turretAssembly.name = 'ImportedTurretAssembly';
    parts.turret.add(turretAssembly);
    for (const node of found) turretAssembly.attach(node);
    turretAssembly.userData.modelTurret = true;
    rig.turretNode = turretAssembly;
    const box = new THREE.Box3().setFromObject(turretAssembly);
    const front = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z - 0.25);
    parts.turret.worldToLocal(front);
    rig.muzzle.copy(front);
  } else {
    console.warn(`[Tank Arena] modelo ${cls}: nenhum nó "Turret" encontrado; a torre não vai girar.`);
  }
  parts.root.rotation.y = savedRoot;
  parts.turret.rotation.y = savedTurret;
  parts.model = rig;
  rebuildSharedTankGearInstances();
}

// Cenário militar estático. As fontes são modelos CC0 sem texturas; as malhas
// são agrupadas por material para que todo o conjunto consuma poucos draw calls.
const battlefieldThemeMeshes: Array<{ mesh: THREE.Mesh; baseColor: THREE.Color }> = [];
const battlefieldPlacements = [
  { file: 'command_tent.glb', x: -36, z: 16, yaw: 0, sx: 1, sz: 1 },
  { file: 'guard_tower.glb', x: 35, z: -20, yaw: 0, sx: 1, sz: 1 },
  { file: 'supply_truck.glb', x: 39, z: 18, yaw: Math.PI, sx: 1, sz: 1 },
  { file: 'camp_gate_with_barrier.glb', x: 0, z: -46, yaw: Math.PI / 2, sx: 1, sz: 1 },
  { file: 'sandbag_wall_straight.glb', x: -19, z: 41, yaw: 0, sx: 1, sz: 1 },
  { file: 'basket_wall_straight.glb', x: 18, z: 42, yaw: 0, sx: 1, sz: 1 },
  { file: 'fuel_dump_berm.glb', x: 29, z: -39, yaw: Math.PI / 2, sx: 0.8, sz: 0.8 },
];

function updateBattlefieldTheme() {
  const roadTint = mapStyleName === 'desert' || mapStyleName === 'canyon' ? new THREE.Color(1.15, 0.96, 0.76)
    : mapStyleName === 'snow' ? new THREE.Color(0.9, 0.96, 1)
    : mapStyleName === 'industrial' ? new THREE.Color(0.82, 0.86, 0.88)
    : new THREE.Color(1, 0.93, 0.82);
  dirtRoadMaterial.color.copy(roadTint);
  hillMaterial.color.setHex(mapStyleName === 'desert' || mapStyleName === 'canyon' ? 0xd7c39a : mapStyleName === 'snow' ? 0xc3d2dc : 0xffffff);
  const assetTint = mapStyleName === 'desert' || mapStyleName === 'canyon' ? new THREE.Color(1.12, 0.98, 0.82)
    : mapStyleName === 'snow' ? new THREE.Color(0.82, 0.9, 0.98)
    : mapStyleName === 'industrial' ? new THREE.Color(0.9, 0.94, 0.98)
    : new THREE.Color(0.84, 0.86, 0.78);
  for (const entry of battlefieldThemeMeshes) {
    (entry.mesh.material as THREE.MeshStandardMaterial).color.copy(entry.baseColor).multiply(assetTint);
  }
}

function loadBattlefieldAssets() {
  const loader = new GLTFLoader();
  const simplify = new SimplifyModifier();
  const files = [...new Set(battlefieldPlacements.map(item => item.file))];
  const models = new Map<string, THREE.Group>();
  let loaded = 0;
  for (const file of files) {
    loader.load(`/models/environment/${file}`, async gltf => {
      models.set(file, gltf.scene);
      if (++loaded !== files.length) return;

      const propPositions: number[] = [];
      const propNormals: number[] = [];
      const propColors: number[] = [];
      const worldBounds: THREE.Box3[] = [];
      const point = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const vertexColor = new THREE.Color();
      const normalMatrix = new THREE.Matrix3();
      for (const placement of battlefieldPlacements) {
        const source = models.get(placement.file);
        if (!source) continue;
        const instance = source.clone(true);
        instance.position.set(placement.x, 0, placement.z);
        instance.rotation.y = placement.yaw;
        instance.scale.set(placement.sx, Math.min(placement.sx, placement.sz), placement.sz);
        instance.updateMatrixWorld(true);
        const bounds = new THREE.Box3().setFromObject(instance);
        const size = bounds.getSize(new THREE.Vector3());
        const center = bounds.getCenter(new THREE.Vector3());
        worldBounds.push(bounds);
        obstacles.push({ center, halfX: size.x / 2, halfZ: size.z / 2, height: size.y });

        instance.traverse(object => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) return;
          const sourceMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          const standard = sourceMaterial as THREE.MeshStandardMaterial;
          const baseColor = standard.color ?? new THREE.Color(0xffffff);
          const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
          const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
          if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
          const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
          const colors = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
          normalMatrix.getNormalMatrix(mesh.matrixWorld);
          for (let vertex = 0; vertex < positions.count; vertex++) {
            point.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld);
            normal.fromBufferAttribute(normals, vertex).applyMatrix3(normalMatrix).normalize();
            if (colors) vertexColor.setRGB(colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex));
            else vertexColor.setRGB(1, 1, 1);
            propPositions.push(point.x, point.y, point.z);
            propNormals.push(normal.x, normal.y, normal.z);
            propColors.push(baseColor.r * vertexColor.r, baseColor.g * vertexColor.g, baseColor.b * vertexColor.b);
          }
          if (geometry !== mesh.geometry) geometry.dispose();
        });
      }

      // A paleta original vai em vertex colors: um único material/draw para o cenário.
      const propGeometry = new THREE.BufferGeometry();
      propGeometry.setAttribute('position', new THREE.Float32BufferAttribute(propPositions, 3));
      propGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(propNormals, 3));
      propGeometry.setAttribute('color', new THREE.Float32BufferAttribute(propColors, 3));
      const propMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
      if (propPositions.length > 0) {
        let renderGeometry = propGeometry;
        try {
          const removeVertices = Math.floor(propGeometry.attributes.position.count * 0.50);
          const simplified = await simplify.modify(propGeometry, removeVertices);
          propGeometry.dispose();
          renderGeometry = simplified;
        } catch (error) {
          console.warn('[Tank Arena] mantendo a geometria original do cenário:', error);
        }
        renderGeometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(renderGeometry, propMaterial);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        scene.add(mesh);
        battlefieldThemeMeshes.push({ mesh, baseColor: new THREE.Color(0xffffff) });
      } else {
        propGeometry.dispose();
        propMaterial.dispose();
      }
      for (const source of models.values()) source.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      updateBattlefieldTheme();
      console.info(`[Tank Arena] cenário carregado e agrupado: ${files.length} modelos / ${worldBounds.length} peças`);
    }, undefined, error => console.warn(`[Tank Arena] falha no cenário ${file}`, error));
  }
}

function refreshAllModels() {
  applyTankModel(playerParts, selectedTankClass, playerPaintColor, accentFor(playerTeam));
  for (const bot of enemies) applyTankModel(bot.parts, bot.tankClass, teamBodyColor(bot.team), accentFor(bot.team));
  rebuildGaragePreview();
}

function loadTankModels() {
  const loader = new GLTFLoader();
  for (const cls of Object.keys(MODEL_URLS) as TankClass[]) {
    if (!MODEL_URLS[cls]) continue;
    loader.load(
      MODEL_URLS[cls],
      gltf => {
        modelTemplates.set(cls, prepareModelTemplate(gltf.scene, cls, MODEL_URLS[cls]));
        console.info(`[Tank Arena] modelo carregado: ${MODEL_URLS[cls]}`);
        refreshAllModels();
      },
      undefined,
      () => { /* arquivo ausente: continua com o tanque procedural */ }
    );
  }
}

// =====================================================
// TIMES E BARRAS DE VIDA: identidade preta/branca sem círculo no chão
// =====================================================

type Team = 'black' | 'white';
let playerTeam: Team = 'black';
const oppositeTeam = (team: Team): Team => team === 'black' ? 'white' : 'black';
const TEAM_BASES: Record<Team, THREE.Vector3> = {
  black: new THREE.Vector3(-34, 0, -34),
  white: new THREE.Vector3(34, 0, 34)
};
function teamBasePosition(team: Team): THREE.Vector3 {
  return TEAM_BASES[team];
}
function playerArenaHeading(): number {
  // O modelo olha para -Z; alinhar a câmera para o centro mostra a arena logo no spawn.
  return Math.atan2(player.position.x, player.position.z);
}

type TeamHealthBar = { sprite: THREE.Sprite; update: (health: number, maxHealth: number) => void; setTeam: (team: Team) => void };
function createTeamHealthBar(root: THREE.Group, team: Team): TeamHealthBar {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 16;
  const context = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(0, 3.35, 0);
  sprite.scale.set(2.15, 0.30, 1);
  root.add(sprite);
  let currentTeam = team;
  let lastHealth = 1, lastMaxHealth = 1;
  let lastRatioKey = -1;
  const update = (health: number, maxHealth: number) => {
    lastHealth = health; lastMaxHealth = maxHealth;
    const ratio = THREE.MathUtils.clamp(health / Math.max(1, maxHealth), 0, 1);
    // Só redesenha a barra quando ela realmente muda (evita reenviar textura à GPU toa).
    const key = Math.round(ratio * 100) + (currentTeam === 'black' ? 1000 : 2000);
    if (key === lastRatioKey) return;
    lastRatioKey = key;
    context.clearRect(0, 0, 128, 16);
    context.fillStyle = 'rgba(8,12,14,.92)'; context.fillRect(1, 1, 126, 14);
    const hue = Math.round(ratio * 118);
    context.fillStyle = `hsl(${hue} 88% 48%)`;
    context.fillRect(4, 4, 120 * ratio, 8);
    context.fillStyle = currentTeam === 'black' ? '#ff9b42' : '#47d8ee';
    context.fillRect(3, 3, 2, 10);
    context.strokeStyle = currentTeam === 'black' ? '#f0ad67' : '#72ddec';
    context.lineWidth = 1;
    context.strokeRect(1, 1, 126, 14);
    texture.needsUpdate = true;
  };
  const setTeam = (nextTeam: Team) => {
    currentTeam = nextTeam;
    lastRatioKey = -1;
    update(lastHealth, lastMaxHealth);
  };
  update(1, 1);
  return { sprite, update, setTeam };
}

// =====================================================
// JOGADOR
// =====================================================

const playerParts = buildTank(0x5c6240, 'medium', accentFor('black'));
const player = playerParts.root;
const playerTurret = playerParts.turret;
const playerTeamHealthBar = createTeamHealthBar(player, playerTeam);
player.traverse(object => {
  if ((object as THREE.Mesh).isMesh) {
    const mesh = object as THREE.Mesh;
    mesh.castShadow = mesh === playerParts.hull || mesh === playerParts.turretBody || mesh === playerParts.barrel;
    mesh.receiveShadow = !!mesh.userData.tankRunningGear;
  }
});
scene.add(player);

player.position.copy(teamBasePosition(playerTeam));
syncTankGearToWorld(playerParts);

let selectedTankClass: TankClass = 'medium';
let playerHealth = TANK_CLASSES.medium.maxHealth;
let playerMaxHealth = TANK_CLASSES.medium.maxHealth;
let playerHealthBonus = 0;
let playerSpeedBonus = 0;
let playerArmorBonus = 0;
let playerKills = 0;
let playerCredits = 0;
const CRYSTALS_STORAGE_KEY = 'tank-arena-crystals-v1';
const PAINTS_STORAGE_KEY = 'tank-arena-paints-v1';
const startingCrystals = Number(localStorage.getItem(CRYSTALS_STORAGE_KEY));
let playerCrystals = Number.isFinite(startingCrystals) && startingCrystals >= 0 ? startingCrystals : 500;
const startingPaints = (() => {
  try {
    const saved = localStorage.getItem(PAINTS_STORAGE_KEY);
    return saved ? JSON.parse(saved) as string[] : ['0x5c6240', '0x2867b2', '0xe5e5e5'];
  } catch { return ['0x5c6240', '0x2867b2', '0xe5e5e5']; }
})();
const ownedPaints = new Set<string>(startingPaints);
function saveLocalEconomy() {
  localStorage.setItem(CRYSTALS_STORAGE_KEY, String(playerCrystals));
  localStorage.setItem(PAINTS_STORAGE_KEY, JSON.stringify([...ownedPaints]));
}
const rankNames = ['Recruta', 'Soldado', 'Cabo', 'Sargento', 'Tenente', 'Capitão', 'Major', 'Coronel', 'General'];
const rankThresholds = [0, 5, 15, 30, 50, 80, 120, 175, 250];
let playerRankIndex = 0;
function updateRank() {
  playerRankIndex = 0;
  for (let i = 0; i < rankThresholds.length; i++) {
    if (playerKills >= rankThresholds[i]) playerRankIndex = i;
  }
}
let playerMoveMultiplier = 1;
let playerDamageMultiplier = 1;
let playerArmor = 0;
let selectedWeapon: 'cannon' | 'rapid' = 'cannon';
let respawnTimer = 0;
let playerAlive = true;
let invulnerability = 0;
let playerSpawnGrace = 3;
let selfDestructTimer = 0;

// =====================================================
// INIMIGOS E NAVEGAÇÃO
// =====================================================

type Enemy = {
  parts: TankParts;
  team: Team;
  health: number;
  maxHealth: number;
  healthBar: TeamHealthBar;
  respawnTimer: number;
  alive: boolean;
  shootTimer: number;
  navTimer: number;
  navAngle: number;
  strafe: number;
  lastPosition: THREE.Vector3;
  stuckTimer: number;
  recoveryTimer: number;
  recoveryAngle: number;
  flankTimer: number;
  spawnGrace: number;
  tankClass: TankClass;
  lastSeenPosition: THREE.Vector3;
  memoryTimer: number;
  dodgeTimer: number;
  dodgeAngle: number;
  barrelRecoil: number;
};

const enemies: Enemy[] = [];

// O ponto de nascimento só é aceito se estiver livre de construções,
// do jogador e dos outros tanques.
function findSafeEnemySpawn(team: Team): THREE.Vector3 | null {
  const base = teamBasePosition(team);
  const sign = team === 'black' ? -1 : 1;
  const isSpawnClear = (candidate: THREE.Vector3, minTankGap: number, minPlayerGap: number) => {
    if (!canMoveTo(candidate)) return false;
    if (playerAlive && candidate.distanceTo(player.position) < minPlayerGap) return false;
    for (const enemy of enemies) {
      if (enemy.alive && candidate.distanceTo(enemy.parts.root.position) < minTankGap) return false;
    }
    return true;
  };

  // Primeiro tenta o setor da equipe com separação normal entre tanques.
  for (let attempt = 0; attempt < 180; attempt++) {
    const candidate = new THREE.Vector3(
      sign * THREE.MathUtils.randFloat(19, 48), 0,
      sign * THREE.MathUtils.randFloat(19, 48)
    );
    if (isSpawnClear(candidate, 5.5, team === playerTeam ? 9 : 5)) return candidate;
  }

  // Segunda tentativa: anéis ao redor da base, evitando pontos ocupados e obstáculos.
  for (const minGap of [4, 2.2, 0]) {
    for (let radius = 5; radius <= 18; radius += 2.5) {
      for (let i = 0; i < 24; i++) {
        const angle = i * Math.PI * 2 / 24;
        const candidate = new THREE.Vector3(
          base.x + Math.cos(angle) * radius, 0,
          base.z + Math.sin(angle) * radius
        );
        if (isSpawnClear(candidate, minGap, team === playerTeam ? 6 : 2.5)) return candidate;
      }
    }
  }

  // Último recurso: pontos fixos livres perto da base.
  const fallbackOffsets = [
    [0, 13], [13, 0], [-13, 0], [0, -13],
    [9, 9], [-9, 9], [9, -9], [-9, -9],
    [16, 0], [0, 16], [-16, 0], [0, -16]
  ];
  for (const [ox, oz] of fallbackOffsets) {
    const candidate = new THREE.Vector3(base.x + ox, 0, base.z + oz);
    if (canMoveTo(candidate)) return candidate;
  }
  const emergency = new THREE.Vector3(sign * 46, 0, sign * 46);
  return canMoveTo(emergency) ? emergency : base.clone();
}

function createEnemy(team: Team = oppositeTeam(playerTeam)): boolean {
  const spawn = findSafeEnemySpawn(team);
  if (!spawn) return false;

  const enemyClasses: TankClass[] = ['light', 'medium', 'medium', 'heavy', 'artillery'];
  const tankClass = enemyClasses[Math.floor(Math.random() * enemyClasses.length)];
  const parts = buildTank(teamBodyColor(team), tankClass, accentFor(team), enemies.length + 2);
  // Material próprio por bot para permitir paletas e pinturas independentes.
  parts.hull.material = (parts.hull.material as THREE.MeshLambertMaterial).clone();
  const maxHealth = tankClass === 'heavy' ? 5 : tankClass === 'light' ? 2 : 3;
  const healthBar = createTeamHealthBar(parts.root, team);
  parts.root.traverse(object => {
    if ((object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh;
      mesh.castShadow = mesh === parts.hull || mesh === parts.turretBody || mesh === parts.barrel;
      mesh.receiveShadow = !!mesh.userData.tankRunningGear;
    }
  });
  parts.root.position.copy(spawn);
  scene.add(parts.root);
  syncTankGearToWorld(parts);
  applyTankModel(parts, tankClass, teamBodyColor(team), accentFor(team));

  enemies.push({
    parts,
    team,
    health: maxHealth,
    maxHealth,
    healthBar,
    respawnTimer: 0,
    alive: true,
    shootTimer: 1 + Math.random() * 2,
    navTimer: 0,
    navAngle: 0,
    strafe: Math.random() > 0.5 ? 1 : -1,
    lastPosition: spawn.clone(),
    stuckTimer: 0,
    recoveryTimer: 0,
    recoveryAngle: Math.random() * Math.PI * 2,
    flankTimer: Math.random() * 2,
    spawnGrace: 3,
    tankClass,
    lastSeenPosition: player.position.clone(),
    memoryTimer: 0,
    dodgeTimer: 0,
    dodgeAngle: 0,
    barrelRecoil: 0
  });

  return true;
}

function clearEnemyRoster() {
  for (const bot of enemies) {
    scene.remove(bot.parts.root);
    releaseTankGearSlot(bot.parts.gearSlot);
    const material = bot.healthBar.sprite.material as THREE.SpriteMaterial;
    material.map?.dispose();
    material.dispose();
    removeTankModel(bot.parts);
    releaseEnv(bot.parts.hull.material as THREE.Material);
    (bot.parts.hull.material as THREE.Material).dispose();
  }
  enemies.length = 0;
}

function respawnEnemy(enemy: Enemy): boolean {
  const spawn = findSafeEnemySpawn(enemy.team);
  if (!spawn) return false;
  enemy.alive = true;
  enemy.health = enemy.maxHealth;
  enemy.parts.root.position.copy(spawn);
  enemy.parts.root.rotation.set(0, 0, 0);
  enemy.parts.turret.rotation.set(0, 0, 0);
  enemy.parts.root.visible = true;
  syncTankGearToWorld(enemy.parts);
  enemy.spawnGrace = 3;
  enemy.shootTimer = 1.2 + Math.random() * 1.5;
  enemy.navTimer = 0;
  enemy.navAngle = 0;
  enemy.stuckTimer = 0;
  enemy.recoveryTimer = 0;
  enemy.recoveryAngle = Math.random() * Math.PI * 2;
  enemy.flankTimer = 1 + Math.random() * 2;
  enemy.memoryTimer = 0;
  enemy.lastSeenPosition.copy(spawn);
  enemy.lastPosition.copy(spawn);
  enemy.dodgeTimer = 0;
  enemy.barrelRecoil = 0;
  enemy.parts.barrel.position.z = -1.27;
  enemy.healthBar.update(enemy.health, enemy.maxHealth);
  updateHUD();
  return true;
}

let currentWave = 1;
let gameMode: 'survival' | 'deathmatch' | 'ctf' = 'ctf';
let matchTime = 180;
let matchEnded = false;
let battleFund = 0;
let playerBattleScore = 0;
let battleScoreTotal = 0;
let playerBattleKills = 0;
let waveTimer = 0;
let waitingForNextWave = false;
let waveBannerTimer = 0;

function addBattleFund(points: number, playerAction = false) {
  battleFund += points;
  battleScoreTotal += points;
  if (playerAction) playerBattleScore += points;
  updateHUD();
}

function finishBattle(message: string) {
  if (matchEnded) return;
  matchEnded = true;
  clearProjectiles();
  const share = battleScoreTotal > 0 ? playerBattleScore / battleScoreTotal : 0;
  const reward = Math.floor(battleFund * share);
  playerCrystals += reward;
  waveBanner.textContent = `${message} · FUNDO ${battleFund} ◈ · SUA PARTE ${reward} ◈`;
  waveBannerTimer = 999999;
  updateHUD();
}

function spawnWave(amount: number) {
  let spawned = 0;
  const alliedCount = Math.floor(amount * 0.4);
  for (let i = 0; i < amount; i++) {
    const team = i < alliedCount ? playerTeam : oppositeTeam(playerTeam);
    if (createEnemy(team)) spawned++;
  }
  return spawned;
}

spawnWave(5);

// =====================================================
// ROUBA-BANDEIRA: duas bases, coleta, transporte e pontuação
// =====================================================

type FlagState = { team: Team; home: THREE.Vector3; mesh: THREE.Group; carrier: Enemy | 'player' | null; dropped: boolean };
const ctfScore: Record<Team, number> = { black: 0, white: 0 };
let playerFlagCarrying = false;
const flags = {} as Record<Team, FlagState>;

function makeFlag(team: Team): FlagState {
  const home = teamBasePosition(team).clone();
  const mesh = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.3, 6), darkMetalMaterial);
  pole.position.y = 1.65; mesh.add(pole);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 320;
  const context = canvas.getContext('2d')!;
  const accent = team === 'black' ? '#e18b39' : '#3daac8';
  context.fillStyle = team === 'black' ? '#292c2a' : '#e9e5d8';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = accent;
  context.fillRect(0, 0, 24, canvas.height);
  context.fillRect(24, 0, canvas.width - 24, 18);
  context.fillRect(24, canvas.height - 18, canvas.width - 24, 18);
  context.globalAlpha = 0.78;
  context.beginPath();
  context.moveTo(84, 70); context.lineTo(150, 254); context.lineTo(184, 254);
  context.lineTo(252, 70); context.lineTo(213, 70); context.lineTo(168, 201);
  context.lineTo(121, 70); context.closePath();
  context.fillStyle = accent; context.fill();
  context.globalAlpha = 1;
  context.fillStyle = team === 'black' ? '#d5d0c2' : '#303a3d';
  context.font = 'bold 62px sans-serif'; context.textAlign = 'center';
  context.fillText(team === 'black' ? 'A' : 'B', 368, 210);
  const flagTexture = new THREE.CanvasTexture(canvas);
  flagTexture.colorSpace = THREE.SRGBColorSpace;
  flagTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const clothGeometry = new THREE.PlaneGeometry(1.5, 0.9, 14, 8);
  const baseZ = new Float32Array(clothGeometry.attributes.position.count);
  const cloth = new THREE.Mesh(clothGeometry, new THREE.MeshLambertMaterial({
    color: 0xffffff, map: flagTexture,
    side: THREE.DoubleSide, emissive: team === 'black' ? 0x100804 : 0x030b0d, emissiveIntensity: 0.08
  }));
  cloth.userData.flagBaseZ = baseZ;
  cloth.castShadow = true;
  cloth.position.set(0.72, 2.75, 0); mesh.add(cloth);
  mesh.position.copy(home); mesh.visible = false; scene.add(mesh);
  return { team, home, mesh, carrier: null, dropped: false };
}
flags.black = makeFlag('black');
flags.white = makeFlag('white');


function resetCaptureTheFlag() {
  ctfScore.black = 0; ctfScore.white = 0; playerFlagCarrying = false;
  for (const team of ['black', 'white'] as Team[]) {
    const flag = flags[team]; flag.carrier = null; flag.dropped = false; flag.mesh.visible = gameMode === 'ctf'; flag.mesh.position.copy(flag.home);
  }
  updateHUD();
}

function dropFlag(team: Team) {
  const flag = flags[team];
  if (!flag || !flag.carrier) return;
  const carrier = flag.carrier;
  if (carrier === 'player') { flag.mesh.position.copy(player.position); playerFlagCarrying = false; }
  else { flag.mesh.position.copy(carrier.parts.root.position); }
  flag.carrier = null; flag.dropped = true; flag.mesh.visible = true;
}

function updateCaptureTheFlag() {
  if (gameMode !== 'ctf' || matchEnded) return;

  const teams: Team[] = ['black', 'white'];
  const carriers: Array<{ flag: FlagState; team: Team; position: THREE.Vector3; alive: boolean; participant: Enemy | 'player' }> = [];

  // Primeiro atualiza o estado físico das duas bandeiras e resolve coletas/devoluções.
  for (const flagTeam of teams) {
    const flag = flags[flagTeam];
    const cloth = flag.mesh.children[1];
    if (cloth instanceof THREE.Mesh) {
      const positions = cloth.geometry.attributes.position as THREE.BufferAttribute;
      const baseZ = cloth.userData.flagBaseZ as Float32Array;
      const phase = clock.elapsedTime * 3.8 + (flagTeam === 'black' ? 0 : Math.PI);
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const y = positions.getY(i);
        const progress = THREE.MathUtils.clamp((x + 0.75) / 1.5, 0, 1);
        positions.setZ(i, baseZ[i] + Math.sin(phase - progress * 5 + y * 2) * 0.12 * progress);
      }
      positions.needsUpdate = true;
      cloth.geometry.computeVertexNormals();
    }

    if (flag.carrier && flag.carrier !== 'player' && !flag.carrier.alive) {
      dropFlag(flagTeam);
    }

    // Se o jogador morrer carregando a bandeira, ela cai no local da destruição.
    if (flag.carrier === 'player' && !playerAlive) {
      dropFlag(flagTeam);
    }

    if (flag.carrier === 'player') {
      flag.mesh.visible = true;
      flag.mesh.position.set(player.position.x, 2.15, player.position.z);
      carriers.push({ flag, team: playerTeam, position: player.position, alive: true, participant: 'player' });
      continue;
    }

    if (flag.carrier) {
      const bot = flag.carrier as Enemy;
      flag.mesh.visible = bot.alive;
      if (bot.alive) {
        flag.mesh.position.set(bot.parts.root.position.x, 2.15, bot.parts.root.position.z);
        carriers.push({ flag, team: bot.team, position: bot.parts.root.position, alive: true, participant: bot });
      }
      continue;
    }

    flag.mesh.visible = true;
    const candidates: Array<{ team: Team; position: THREE.Vector3; bot: Enemy | 'player' }> = [];
    if (playerAlive) candidates.push({ team: playerTeam, position: player.position, bot: 'player' });
    for (const bot of enemies) if (bot.alive) candidates.push({ team: bot.team, position: bot.parts.root.position, bot });

    // Bandeira caída volta ao pedestal quando um aliado toca nela.
    let returnedThisFrame = false;
    if (flag.dropped) {
      const returner = candidates.find(candidate => candidate.team === flagTeam &&
        ((candidate.position.x - flag.mesh.position.x) ** 2 + (candidate.position.z - flag.mesh.position.z) ** 2) <= 9.0);
      if (returner) {
        returnedThisFrame = true;
        flag.dropped = false;
        flag.mesh.position.copy(flag.home);
        waveBanner.textContent = `BANDEIRA ${flagTeam === 'black' ? 'PRETA' : 'BRANCA'} DEVOLVIDA`;
        waveBannerTimer = 1.8;
      }
    }

    if (!returnedThisFrame && !flag.dropped && !flag.carrier) {
      const thief = candidates.find(candidate => candidate.team !== flagTeam &&
        ((candidate.position.x - flag.mesh.position.x) ** 2 + (candidate.position.z - flag.mesh.position.z) ** 2) <= 9.0);
      if (thief) {
        flag.carrier = thief.bot;
        flag.dropped = false;
        if (thief.bot === 'player') playerFlagCarrying = true;
        flag.mesh.position.set(thief.position.x, 2.15, thief.position.z);
        carriers.push({ flag, team: thief.team, position: thief.position, alive: true, participant: thief.bot });
        waveBanner.textContent = thief.bot === 'player' ? 'BANDEIRA CAPTURADA! VOLTE À SUA BASE' : 'BANDEIRA INIMIGA CAPTURADA';
        waveBannerTimer = 1.8;
      }
    }
  }

  // Pontua somente ao entrar na zona da própria base com a bandeira inimiga.
  // A própria bandeira precisa estar no pedestal (não caída nem carregada).
  for (const carrier of carriers) {
    if (!carrier.alive || carrier.flag.team === carrier.team) continue;
    const ownFlag = flags[carrier.team];
    const base = teamBasePosition(carrier.team);
    const distanceToBase = Math.hypot(carrier.position.x - base.x, carrier.position.z - base.z);
    const ownFlagIsHome = !ownFlag.dropped && ownFlag.carrier === null;
    if (distanceToBase <= 12 && ownFlagIsHome) {
      ctfScore[carrier.team]++;
      addBattleFund(30, carrier.participant === 'player');
      carrier.flag.carrier = null;
      carrier.flag.dropped = false;
      carrier.flag.mesh.visible = true;
      carrier.flag.mesh.position.copy(carrier.flag.home);
      if (carrier.team === playerTeam) {
        playerFlagCarrying = false;
        waveBanner.textContent = `PONTO DO TIME ${playerTeam === 'black' ? 'PRETO' : 'BRANCO'}!`;
      } else {
        waveBanner.textContent = `PONTO DO TIME ${carrier.team === 'black' ? 'PRETO' : 'BRANCO'}!`;
      }
      waveBannerTimer = 2.4;
      updateHUD();
    }
  }

  if (ctfScore.black >= 3 || ctfScore.white >= 3) {
    finishBattle(`FIM DE JOGO · PRETO ${ctfScore.black} x BRANCO ${ctfScore.white}`);
  }

  setText(waveText, `PLACAR — PRETO ${ctfScore.black} x BRANCO ${ctfScore.white} · META: 3`);
  const ownFlag = flags[playerTeam];
  setText(ctfObjective, playerFlagCarrying
    ? 'OBJETIVO: leve a bandeira até sua base para marcar 1 ponto!'
    : ownFlag.dropped || (ownFlag.carrier !== null && ownFlag.carrier !== 'player')
      ? 'OBJETIVO: recupere sua bandeira; depois roube a inimiga'
      : 'OBJETIVO: aproxime-se da bandeira inimiga para roubá-la');
}

// =====================================================
// HUD
// =====================================================

const hud = document.createElement('div');
hud.id = 'hud';
hud.innerHTML = `
  <div class="hud-panel">
    <strong>TANK ARENA 3D</strong>
    <span id="team-text">Time: Preto</span>
    <span id="health-text">Vida: 100 / 100</span>
    <div class="health-track"><div id="health-fill"></div></div>
    <span id="kills-text">Eliminações: 0</span>
    <span id="credits-text">Créditos: 0 · Patente: Recruta</span>
    <span id="weapon-text">Arma: Canhão (1)</span>
    <span id="wave-text">Onda: 1</span>
    <span id="ctf-objective">Objetivo: elimine os adversários</span>
    <span id="enemy-text">Inimigos: 5</span>
    <span id="power-text">Caixas: aguardando queda</span>
  </div>

  <div id="crosshair">+</div>
  <div id="hit-marker"></div>
  <div id="damage-flash"></div>

  <div id="help">
    WASD: movimentar · A/D: girar casco<br>
    Mouse: mirar · Espaço: disparo contínuo · 1/2: armas<br>
    Z/X: girar torre · C: centralizar · Q/E: baixar/elevar câmera<br>
    Botão direito + mouse: olhar ao redor sem mover a torre<br>
    G: garagem · M: menu principal · Delete: autodestruição (3s) · Rouba-Bandeira: capture a bandeira inimiga e retorne à sua base<br>
    Clique: capturar mouse · ESC: liberar
  </div>

  <div id="respawn-message"></div>
  <div id="wave-banner"></div>

  <div id="garage" class="hidden">
    <div class="garage-shell">
      <header class="garage-topbar">
        <div class="garage-brand"><span class="garage-brand-mark">T</span><div><b>TANK ARENA</b><small>CENTRO DE COMANDO</small></div></div>
        <div class="garage-top-stats"><span>CRISTAIS <b id="garage-crystals">500</b></span><span>CRÉDITOS <b id="garage-credits">0</b></span><span>ELIMINAÇÕES <b id="garage-kills">0</b></span><span>EQUIPE <b id="garage-team-label">PRETO</b></span></div>
        <button id="garage-close" class="garage-return">FECHAR GARAGEM</button>
      </header>
      <div class="garage-layout">
        <nav class="garage-nav">
          <div class="garage-nav-title">OFICINA</div>
          <button class="garage-nav-item active" data-garage-tab="vehicle"><i>▣</i><span>TANQUE</span></button>
          <button class="garage-nav-item" data-garage-tab="armament"><i>⌁</i><span>ARMAMENTO</span></button>
          <button class="garage-nav-item" data-garage-tab="paint"><i>◈</i><span>PINTURA</span></button>
          <button class="garage-nav-item" data-garage-tab="equipment"><i>⚙</i><span>EQUIPAMENTO</span></button>
          <button class="garage-nav-item" data-garage-tab="rank"><i>★</i><span>PATENTES</span></button>
          <button class="garage-nav-item" data-garage-tab="graphics"><i>◉</i><span>GRÁFICOS</span></button>
          <button class="garage-nav-item" data-garage-tab="battle"><i>⌖</i><span>BATALHA</span></button>
          <div class="garage-nav-foot"><span class="garage-status-dot"></span> PERFIL LOCAL</div>
        </nav>
        <main class="garage-main">
          <section class="garage-showcase">
            <div class="garage-showcase-head"><div><small>HANGAR / VISUALIZAÇÃO</small><h2>MEU TANQUE</h2></div><span class="garage-live"><i></i> CAMPO ATIVO</span></div>
            <div id="garage-preview" class="garage-preview">
              <div class="preview-grid"></div><div class="preview-crosshair"></div>
              <div class="preview-label">VISUALIZAÇÃO 3D · MODELO ATUAL</div>
              <div class="preview-bottom"><span id="preview-class">TANQUE MÉDIO</span><span>↻ MODELO ROTATIVO</span></div>
            </div>
            <div class="garage-condition"><span>CONDIÇÃO DO VEÍCULO</span><div class="condition-bar"><i></i></div><b id="garage-condition-text">OPERACIONAL</b></div>
            <section class="garage-rank-card" data-garage-section="rank" aria-label="Progresso de patente">
              <div class="garage-rank-medal" aria-hidden="true">★</div>
              <div class="garage-rank-info"><div><small>CARREIRA DE COMBATE</small><b id="garage-rank-name">RECRUTA</b></div>
                <div class="garage-rank-next"><span id="garage-rank-progress-label">0 / 5 eliminações</span><span id="garage-rank-next-name">PRÓXIMA: SOLDADO</span></div>
                <div class="garage-rank-track"><i id="garage-rank-progress"></i></div>
                <div id="garage-rank-ladder" class="garage-rank-ladder" aria-label="Lista de patentes"></div>
              </div>
            </section>
          </section>
          <section class="garage-controls">
            <div class="garage-section active" data-garage-section="vehicle">
              <div class="garage-section-head"><small>01 / CONFIGURAÇÃO</small><h3>Plataforma do tanque</h3><p>Escolha a configuração que combina com seu estilo de combate.</p></div>
              <label for="tank-class">CLASSE DO VEÍCULO</label>
              <select id="tank-class"><option value="light">Leve — rápido, pouca blindagem</option><option value="medium" selected>Médio — equilibrado</option><option value="heavy">Pesado — blindado e forte</option><option value="artillery">Artilharia — alcance e dano altos</option></select>
              <div class="garage-stat-grid"><div><small>FUNÇÃO</small><b id="garage-role">VERSÁTIL</b></div><div><small>RESISTÊNCIA</small><b id="garage-health-stat">100 HP</b></div></div>
            </div>
            <div class="garage-section" data-garage-section="armament">
              <div class="garage-section-head"><small>02 / ARMAMENTO</small><h3>Torre instalada</h3><p>Escolha entre impacto pesado e disparo rápido. A seleção vale imediatamente na partida local.</p></div>
              <label for="tank-weapon">ARMA PRINCIPAL</label>
              <select id="tank-weapon"><option value="cannon">Canhão · impacto e recarga lenta</option><option value="rapid">Autocanhão · disparo rápido</option></select>
              <div class="garage-stat-grid"><div><small>MUNIÇÃO</small><b>INFINITA</b></div><div><small>ALTERAÇÃO</small><b>SEM CUSTO</b></div></div>
            </div>
            <div class="garage-section" data-garage-section="paint">
              <div class="garage-section-head"><small>03 / IDENTIDADE VISUAL</small><h3>Pintura e equipe</h3><p>A pintura é independente do time e não altera os atributos.</p></div>
              <label for="team-select">EQUIPE DE COMBATE</label>
              <select id="team-select"><option value="black" selected>Time Preto</option><option value="white">Time Branco</option></select>
              <label for="tank-color">COR DA CARROCERIA</label>
              <select id="tank-color"><option value="0x5c6240">Oliva fosco</option><option value="0x2867b2">Azul</option><option value="0xb33a32">Vermelho</option><option value="0xaaaaaa">Prata</option><option value="0xd1a52c">Dourado</option><option value="0x663399">Roxo</option><option value="0xe5e5e5">Branco</option><option value="0x171717">Preto</option><option value="0xe87524">Laranja</option></select>
              <label for="tank-style">ESTILO DA TORRE</label>
              <select id="tank-style"><option value="normal">Padrão</option><option value="heavy">Pesada</option><option value="slim">Compacta</option></select>
            </div>
            <div class="garage-section" data-garage-section="equipment">
              <div class="garage-section-head"><small>04 / MELHORIAS</small><h3>Equipamentos</h3><p>Instale melhorias permanentes usando seus créditos locais.</p></div>
              <label for="tank-upgrade">MELHORIA · 50 CRÉDITOS</label>
              <select id="tank-upgrade"><option value="none">Selecionar equipamento...</option><option value="engine">Motor: +10% velocidade</option><option value="armor">Blindagem: +20 vida máxima</option><option value="damage">Canhão: +15% dano</option></select>
              <button id="upgrade-buy" class="garage-secondary-action">INSTALAR MELHORIA</button>
            </div>
            <div class="garage-section" data-garage-section="graphics">
              <div class="garage-section-head"><small>05 / RENDERIZAÇÃO</small><h3>Qualidade gráfica</h3><p>Máximo prioriza a taxa de quadros e mantém a resolução nativa e as texturas originais.</p></div>
              <label for="graphics-quality">PREDEFINIÇÃO VISUAL</label>
              <select id="graphics-quality"><option value="balanced">Equilibrado</option><option value="high">Alto</option><option value="maximum" selected>Máximo FPS</option></select>
            </div>
            <div class="garage-section" data-garage-section="battle">
              <div class="garage-section-head"><small>06 / OPERAÇÃO</small><h3>Configuração da partida</h3><p>Rouba-Bandeira: equipes equilibradas, três veículos por lado contando com você.</p></div>
              <label for="map-style">ARENA</label>
              <select id="map-style"><option value="field">Campo de operações</option><option value="desert">Dunas</option><option value="industrial">Complexo industrial</option><option value="canyon">Desfiladeiro</option><option value="snow">Base glacial</option></select>
              <label for="lighting-mode">ILUMINAÇÃO</label>
              <select id="lighting-mode"><option value="day">Dia</option><option value="night">Noite</option></select>
              <label for="game-mode">MODO DE JOGO</label>
              <select id="game-mode"><option value="ctf" selected>Rouba-Bandeira (3 vs 3)</option><option value="survival">Sobrevivência (ondas)</option><option value="deathmatch">Mata-mata (3 minutos)</option></select>
            </div>
            <div class="garage-footnote"><b>PROTOCOLO DE COMBATE</b><br>Oficina opcional · respawn automático por equipe · fogo amigo desativado · equipes preto e branco · bots preparados para alvos humanos e IA.</div>
          </section>
        </main>
      </div>
      <footer class="garage-footer"><span> TANK ARENA 3D <small>· OFICINA DE CAMPO</small></span><span id="garage-status">PRONTO PARA COMBATE</span></footer>
    </div>
  </div>
`;
document.body.appendChild(hud);
// Modais precisam ficar fora do contexto de empilhamento do HUD para cobrir minimapa e overlays da partida.
const garageModal = document.getElementById('garage');
if (garageModal) document.body.appendChild(garageModal);

const menuButton = document.createElement('button');
menuButton.id = 'main-menu-open';
menuButton.className = 'main-menu-open';
menuButton.type = 'button';
menuButton.textContent = '☰ MENU';
menuButton.setAttribute('aria-label', 'Abrir menu principal');
hud.appendChild(menuButton);

const mainMenu = document.createElement('div');
mainMenu.id = 'main-menu';
mainMenu.className = 'hidden';
mainMenu.setAttribute('role', 'dialog');
mainMenu.setAttribute('aria-modal', 'true');
mainMenu.setAttribute('aria-label', 'Menu principal');
mainMenu.innerHTML = `
  <div class="main-menu-shell">
    <header class="main-menu-header">
      <div class="main-menu-brand"><span class="main-menu-mark">T</span><div><b>TANK ARENA</b><small>PROTOCOLO OFFLINE</small></div></div>
      <div class="main-menu-profile"><span class="main-menu-medal">★</span><div><small>PATENTE</small><b id="main-menu-rank">RECRUTA</b></div><div class="main-menu-xp"><small id="main-menu-xp-label">0 / 5 ELIMINAÇÕES</small><i><b id="main-menu-xp-bar"></b></i></div></div>
      <div class="main-menu-wallet"><small>CRISTAIS · CRÉDITOS</small><b><span id="main-menu-crystals">500</span> ◈ · <span id="main-menu-credits">0</span></b></div>
      <button id="main-menu-resume" type="button">VOLTAR À BATALHA</button>
    </header>
    <div class="main-menu-body">
      <nav class="main-menu-nav" aria-label="Navegação principal">
        <button class="active" data-menu-panel="battle"><i>⌖</i><span>BATALHA</span></button>
        <button data-menu-action="garage"><i>▣</i><span>GARAGEM</span></button>
        <button data-menu-panel="ranks"><i>★</i><span>PATENTES</span></button>
        <button data-menu-panel="settings"><i>◉</i><span>OPÇÕES</span></button>
        <button data-menu-panel="containers"><i>▤</i><span>CONTÊINERES</span></button>
        <div class="main-menu-nav-footer"><i></i> PARTIDA LOCAL</div>
      </nav>
      <main class="main-menu-content">
        <section class="main-menu-panel active" data-menu-section="battle">
          <div class="main-menu-eyebrow">CENTRO DE COMBATE / CAMPO DE TREINO</div>
          <h1>Escolha sua batalha</h1>
          <p>Configure a arena e entre no combate. Seu progresso desta sessão fica no perfil local.</p>
          <div class="main-menu-battle-grid">
            <label class="main-menu-mode-card"><small>MODO DE JOGO</small><select id="main-menu-mode"><option value="ctf">Rouba-Bandeira · 3 vs 3</option><option value="deathmatch">Mata-mata · 3 minutos</option><option value="survival">Sobrevivência · ondas</option></select></label>
            <label class="main-menu-mode-card"><small>ARENA</small><select id="main-menu-map"><option value="field">Campo de operações</option><option value="desert">Dunas</option><option value="industrial">Complexo industrial</option><option value="canyon">Desfiladeiro</option><option value="snow">Base glacial</option></select></label>
            <label class="main-menu-mode-card"><small>ILUMINAÇÃO</small><select id="main-menu-lighting"><option value="day">Dia</option><option value="night">Noite</option></select></label>
          </div>
          <div class="main-menu-action-row"><button id="main-menu-play" class="main-menu-play" type="button"><span>▶</span> INICIAR BATALHA</button><button id="main-menu-garage" class="main-menu-secondary" type="button">CONFIGURAR TANQUE</button></div>
          <div class="main-menu-briefing"><small>OBJETIVO ATUAL</small><b>Capture a bandeira inimiga e retorne à sua base</b><span>Eliminações e capturas aumentam o fundo, distribuído no fim da batalha.</span></div>
        </section>
        <section class="main-menu-panel" data-menu-section="ranks">
          <div class="main-menu-eyebrow">CARREIRA / PROGRESSÃO LOCAL</div><h1>Patentes de combate</h1><p>Suba de patente eliminando tanques adversários durante esta sessão.</p>
          <div id="main-menu-rank-list" class="main-menu-rank-list"></div>
          <button class="main-menu-secondary" data-menu-action="garage" type="button">ABRIR GARAGEM</button>
        </section>
        <section class="main-menu-panel" data-menu-section="settings">
          <div class="main-menu-eyebrow">SISTEMA / CONFIGURAÇÃO LOCAL</div><h1>Opções do jogo</h1>
          <p>Ajustes aplicados imediatamente nesta sessão. A resolução nativa e as texturas são preservadas em todos os perfis.</p>
          <label class="main-menu-mode-card"><small>DESEMPENHO E QUALIDADE</small><select id="main-menu-quality"><option value="maximum">Máximo FPS</option><option value="high">Alto</option><option value="balanced">Equilibrado</option></select></label>
          <div class="main-menu-briefing"><small>CONTROLES</small><b>WASD movimenta · mouse mira · espaço dispara</b><span>1/2 alterna armas · G abre a garagem · M abre o menu</span></div>
        </section>
        <section class="main-menu-panel" data-menu-section="containers">
          <div class="main-menu-eyebrow">SUPRIMENTOS / RECOMPENSAS LOCAIS</div><h1>Contêineres</h1>
          <p>Use cristais conquistados nas partidas para receber uma pintura da coleção local.</p>
          <div class="container-card"><div class="container-crate-art">✚</div><div><small>CONTÊINER DE CAMPO</small><b>Uma pintura aleatória</b><span>Itens duplicados devolvem parte do custo em cristais.</span></div><strong>100 ◈</strong></div>
          <button id="open-container" class="main-menu-play" type="button">ABRIR CONTÊINER · 100 CRISTAIS</button>
          <div id="container-result" class="container-result" aria-live="polite">Cristais: <b id="container-crystals">500</b></div>
        </section>
      </main>
    </div>
  </div>`;
document.body.appendChild(mainMenu);
const battleScoreboard = document.createElement('div');
battleScoreboard.id = 'battle-scoreboard';
battleScoreboard.className = 'hidden';
battleScoreboard.innerHTML = '<div class="battle-scoreboard-card"><header><b>PLACAR DA BATALHA</b><span>LIBERE TAB PARA FECHAR</span></header><div class="battle-scoreboard-fund"></div><div class="battle-scoreboard-columns"><span>JOGADOR</span><span>EQUIPE</span><span>ELIMINAÇÕES</span><span>PONTOS</span></div><div class="battle-scoreboard-rows"></div></div>';
document.body.appendChild(battleScoreboard);
const battleScoreboardStyle = document.createElement('style');
battleScoreboardStyle.textContent = '#battle-scoreboard{position:fixed;inset:0;z-index:1050;display:grid;place-items:center;background:#05090bc9;color:#edf1ef;font:12px Arial,sans-serif;pointer-events:none}#battle-scoreboard.hidden{display:none}.battle-scoreboard-card{width:min(760px,92vw);padding:18px 22px;border:1px solid #697980;background:linear-gradient(145deg,#182329f5,#0b1115f5);box-shadow:0 24px 65px #0009}.battle-scoreboard-card header{display:flex;justify-content:space-between;align-items:center;padding-bottom:14px;border-bottom:1px solid #526167;letter-spacing:1px}.battle-scoreboard-card header b{font-size:16px;color:#e6c98e}.battle-scoreboard-card header span{font-size:9px;color:#91a0a3}.battle-scoreboard-fund{padding:13px 0;color:#f0d49c;font-size:14px;font-weight:bold}.battle-scoreboard-columns,.battle-scoreboard-row{display:grid;grid-template-columns:1.5fr .8fr 1fr .7fr;gap:10px;align-items:center}.battle-scoreboard-columns{padding:9px;background:#253238;color:#a7b5b5;font-size:9px;letter-spacing:.8px}.battle-scoreboard-row{min-height:35px;padding:6px 9px;border-bottom:1px solid #344148}.battle-scoreboard-row.player{color:#f2d39b;background:#68502a44}.battle-scoreboard-row span:last-child{text-align:right}';
document.head.appendChild(battleScoreboardStyle);
function refreshBattleScoreboard() {
  battleScoreboard.querySelector('.battle-scoreboard-fund')!.textContent = `FUNDO DE BATALHA: ${battleFund} ◈`;
  const rows = battleScoreboard.querySelector('.battle-scoreboard-rows')!;
  rows.replaceChildren();
  const participants = [{ name: 'Você', team: playerTeam, kills: playerBattleKills, score: playerBattleScore, player: true },
    ...enemies.map((bot, i) => ({ name: `Tanque ${i + 1}`, team: bot.team, kills: 0, score: 0, player: false }))];
  for (const participant of participants) {
    const row = document.createElement('div');
    row.className = `battle-scoreboard-row${participant.player ? ' player' : ''}`;
    for (const value of [participant.name, participant.team === 'black' ? 'PRETO' : 'BRANCO', String(participant.kills), String(participant.score)]) {
      const cell = document.createElement('span'); cell.textContent = value; row.appendChild(cell);
    }
    rows.appendChild(row);
  }
}
const mainMenuStyle = document.createElement('style');
mainMenuStyle.textContent = `
  #main-menu{position:fixed;inset:0;z-index:1100;display:grid;place-items:center;padding:clamp(10px,3vw,34px);background:rgba(3,8,10,.70);color:#e9edf0;font-family:Arial,Helvetica,sans-serif;pointer-events:auto}
  #main-menu.hidden{display:none!important}#main-menu *{box-sizing:border-box}
  .main-menu-shell{width:min(1180px,100%);height:min(760px,92vh);min-height:500px;display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(159,180,190,.35);background:linear-gradient(145deg,#192329f5,#091115f7);box-shadow:0 28px 100px #000b}
  .main-menu-header{height:76px;flex:0 0 76px;display:flex;align-items:center;gap:28px;padding:0 24px;border-bottom:1px solid #3a494f;background:linear-gradient(90deg,#222e34,#131c21)}
  .main-menu-brand{display:flex;align-items:center;gap:11px;min-width:220px}.main-menu-mark{width:40px;height:40px;display:grid;place-items:center;background:#c18b36;color:#101416;font-size:25px;font-weight:900;transform:skew(-8deg)}.main-menu-brand b,.main-menu-brand small{display:block}.main-menu-brand b{font-size:15px;letter-spacing:2px}.main-menu-brand small{margin-top:3px;color:#95a4a9;font-size:8px;letter-spacing:2px}
  .main-menu-profile{display:flex;align-items:center;gap:10px;min-width:250px}.main-menu-medal{width:34px;height:34px;display:grid;place-items:center;background:#574327;color:#f3d69a;clip-path:polygon(50% 0,93% 20%,82% 75%,50% 100%,18% 75%,7% 20%)}.main-menu-profile>div:nth-child(2) small,.main-menu-profile>div:nth-child(2) b,.main-menu-wallet small,.main-menu-wallet b{display:block}.main-menu-profile>div:nth-child(2) small,.main-menu-wallet small{color:#91a0a4;font-size:8px;letter-spacing:1.4px}.main-menu-profile>div:nth-child(2) b{margin-top:4px;color:#efd39b;font-size:11px;letter-spacing:1px}.main-menu-xp{min-width:100px;flex:1}.main-menu-xp small{color:#9aa8ac;font-size:7px;white-space:nowrap}.main-menu-xp i{display:block;height:4px;margin-top:5px;background:#303b40}.main-menu-xp i b{display:block;height:100%;background:#c8a25c}
  .main-menu-wallet{margin-left:auto;min-width:112px}.main-menu-wallet b{margin-top:5px;color:#e9d4a7;font-size:14px}.main-menu-header>button{height:36px;padding:0 15px;border:1px solid #9b7945;background:#483920;color:#f1d49a;font-size:9px;font-weight:bold;letter-spacing:1px;cursor:pointer}
  .main-menu-body{display:grid;grid-template-columns:180px minmax(0,1fr);min-height:0;flex:1}.main-menu-nav{display:flex;flex-direction:column;gap:6px;padding:20px 12px;border-right:1px solid #344148;background:#0b1216aa}.main-menu-nav button{height:48px;display:flex;align-items:center;gap:12px;padding:0 12px;border:1px solid transparent;background:transparent;color:#a2afb2;text-align:left;font-size:10px;font-weight:bold;letter-spacing:1px;cursor:pointer}.main-menu-nav button i{width:22px;color:#c59a58;font-size:17px;font-style:normal;text-align:center}.main-menu-nav button.active{border-color:#bd914b66;background:#bd914b22;color:#f2d39b}.main-menu-nav-footer{display:flex;align-items:center;gap:8px;margin-top:auto;padding:10px 4px;color:#91a099;font-size:8px;letter-spacing:1px}.main-menu-nav-footer i{width:7px;height:7px;border-radius:50%;background:#8bbd72;box-shadow:0 0 8px #8bbd72}
  .main-menu-content{min-width:0;overflow:auto;padding:clamp(24px,5vw,64px);background:radial-gradient(ellipse at 80% 10%,#30434b55,transparent 55%)}.main-menu-panel{display:none;max-width:760px}.main-menu-panel.active{display:block}.main-menu-eyebrow{color:#c59a58;font-size:9px;letter-spacing:2px}.main-menu-panel h1{margin:10px 0;color:#f0f2ef;font-size:clamp(25px,3vw,38px);letter-spacing:.5px}.main-menu-panel>p{max-width:620px;color:#a5b1b3;font-size:13px;line-height:1.6}.main-menu-battle-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:26px}.main-menu-mode-card{display:flex;flex-direction:column;gap:9px;min-height:104px;padding:16px;border:1px solid #425158;background:#111a1fbb}.main-menu-mode-card small{color:#b59760;font-size:8px;font-weight:bold;letter-spacing:1.5px}.main-menu-mode-card b{color:#e5d0a4;font-size:11px;letter-spacing:.8px}.main-menu-mode-card span{color:#9aa7aa;font-size:10px}.main-menu-mode-card select{height:38px;padding:0 10px;border:1px solid #596970;background:#1b282e;color:#e7ecea;font-size:11px}
  .main-menu-action-row{display:flex;gap:10px;margin-top:22px}.main-menu-play,.main-menu-secondary{min-height:44px;padding:0 18px;border:1px solid #c39a54;background:linear-gradient(110deg,#876432,#574226);color:#fff0ca;font-size:10px;font-weight:bold;letter-spacing:1px;cursor:pointer}.main-menu-play span{margin-right:8px}.main-menu-secondary{border-color:#536269;background:#182328;color:#d9e0df}.main-menu-briefing{display:flex;flex-direction:column;gap:7px;margin-top:26px;padding:15px 17px;border-left:2px solid #bd914b;background:#bd914b12}.main-menu-briefing small{color:#b59760;font-size:8px;letter-spacing:1.4px}.main-menu-briefing b{color:#e6e8e2;font-size:12px}.main-menu-briefing span{color:#91a0a3;font-size:10px}.main-menu-rank-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:24px 0}.main-menu-rank-step{padding:13px;border:1px solid #37474d;background:#111a1f;color:#8b989b;font-size:10px}.main-menu-rank-step b{display:block;margin-bottom:6px;color:#aeb9b8;font-size:16px}.main-menu-rank-step small{display:block;margin-top:5px;color:#758489;font-size:8px}.main-menu-rank-step.active{border-color:#c59a58;background:#48392066;color:#f1d49a}.main-menu-rank-step.complete{border-color:#647752;background:#243222;color:#d3e2bf}
  .main-menu-open{position:absolute;top:15px;right:205px;pointer-events:auto;padding:8px 12px;border:1px solid rgba(190,210,207,.42);border-radius:4px;background:rgba(5,12,10,.82);color:#f0d39b;font:bold 10px/1 Arial,sans-serif;letter-spacing:1px;cursor:pointer;text-shadow:0 1px 3px #000}
  @media(max-width:700px){.main-menu-shell{height:96vh;min-height:0}.main-menu-header{height:62px;flex-basis:62px;gap:10px;padding:0 12px}.main-menu-brand{min-width:0}.main-menu-profile{min-width:0;flex:1}.main-menu-wallet{display:none}.main-menu-header>button{padding:0 8px;font-size:8px}.main-menu-body{grid-template-columns:56px minmax(0,1fr)}.main-menu-nav{padding:12px 5px}.main-menu-nav button{justify-content:center;padding:0}.main-menu-nav button span,.main-menu-nav-footer{display:none}.main-menu-content{padding:20px}.main-menu-battle-grid{grid-template-columns:1fr}.main-menu-rank-list{grid-template-columns:repeat(2,minmax(0,1fr))}.main-menu-open{right:190px}}
`;
document.head.appendChild(mainMenuStyle);

// Garagem translúcida: a batalha continua visível ao fundo, sem blur pesado.
const garageOverlayStyle = document.createElement('style');
garageOverlayStyle.textContent = `
  #garage{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:clamp(8px,2vw,24px);box-sizing:border-box;background:rgba(4,8,10,.48);font-family:Arial,Helvetica,sans-serif;color:#e9edf0}
  #garage.hidden{display:none!important}#garage *{box-sizing:border-box}
  .garage-shell{width:min(1220px,100%);height:min(820px,94vh);min-height:540px;display:flex;flex-direction:column;overflow:hidden;background:linear-gradient(145deg,rgba(22,29,34,.98),rgba(10,15,19,.98));border:1px solid rgba(174,194,202,.28);box-shadow:0 22px 70px rgba(0,0,0,.62);clip-path:polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,0 100%)}
  .garage-topbar{height:68px;flex:0 0 68px;display:flex;align-items:center;gap:22px;padding:0 22px;background:linear-gradient(90deg,#202b31,#151d22);border-bottom:1px solid #39464c}
  .garage-brand{display:flex;align-items:center;gap:11px;min-width:225px}.garage-brand-mark{width:38px;height:38px;display:grid;place-items:center;background:#c18b36;color:#111;font-size:25px;font-weight:900;transform:skew(-8deg)}.garage-brand b{display:block;font-size:15px;letter-spacing:2px}.garage-brand small{display:block;margin-top:3px;color:#9ba9ad;font-size:9px;letter-spacing:2px}
  .garage-top-stats{display:flex;gap:24px;margin-left:auto;color:#8e9ca1;font-size:9px;letter-spacing:1.2px}.garage-top-stats span{display:flex;flex-direction:column;gap:4px}.garage-top-stats b{color:#f0c36f;font-size:13px;letter-spacing:.5px}
  .garage-return{min-width:190px;height:39px;border:1px solid #d6a44c;background:linear-gradient(#d5a44d,#a9772d);color:#171b1d;font-size:11px;font-weight:900;letter-spacing:1px;cursor:pointer}.garage-return:hover,.garage-secondary-action:hover{filter:brightness(1.12)}
  .garage-layout{display:grid;grid-template-columns:160px minmax(0,1fr);min-height:0;flex:1}.garage-nav{display:flex;flex-direction:column;gap:7px;padding:20px 12px;background:rgba(6,11,14,.42);border-right:1px solid #344148}.garage-nav-title{padding:0 10px 12px;color:#78888e;font-size:9px;letter-spacing:2px}.garage-nav-item{height:48px;display:flex;align-items:center;gap:12px;padding:0 12px;border:1px solid transparent;background:transparent;color:#9eacb1;text-align:left;font-size:10px;font-weight:bold;letter-spacing:1px;cursor:pointer}.garage-nav-item i{width:22px;color:#c29a55;font-size:17px;font-style:normal;text-align:center}.garage-nav-item.active{background:linear-gradient(90deg,rgba(190,139,57,.2),rgba(190,139,57,.04));border-color:rgba(202,157,83,.42);color:#f2d39b}.garage-nav-foot{margin-top:auto;padding:12px 6px;color:#819096;font-size:8px;letter-spacing:1px}.garage-status-dot,.garage-live i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#8bbd72;box-shadow:0 0 8px #8bbd72;margin-right:6px}
  .garage-main{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);grid-template-rows:minmax(0,1fr);align-items:stretch;gap:18px;min-height:0;padding:20px;overflow:hidden}.garage-showcase{display:flex;flex-direction:column;min-width:0;min-height:0}.garage-showcase-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.garage-showcase-head small,.garage-section-head small{color:#c59a58;font-size:9px;letter-spacing:1.7px}.garage-showcase-head h2{margin:5px 0 0;font-size:21px;letter-spacing:2px}.garage-live{color:#a9c49c;font-size:9px;letter-spacing:1px}.garage-preview{position:relative;isolation:isolate;min-height:300px;flex:1;overflow:hidden;border:1px solid #45545a;background:transparent;}
  .preview-grid{z-index:1;position:absolute;inset:0;opacity:.22;background-image:linear-gradient(rgba(168,187,183,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(168,187,183,.16) 1px,transparent 1px);background-size:34px 34px;transform:perspective(280px) rotateX(56deg) scale(1.5);transform-origin:center 65%;pointer-events:none}.preview-crosshair{z-index:1;position:absolute;left:50%;top:50%;width:190px;height:190px;transform:translate(-50%,-50%);border:1px solid rgba(201,171,115,.12);border-radius:50%;pointer-events:none}.preview-crosshair:before,.preview-crosshair:after{content:"";position:absolute;background:rgba(201,171,115,.16)}.preview-crosshair:before{width:1px;height:230px;left:50%;top:-20px}.preview-crosshair:after{height:1px;width:230px;top:50%;left:-20px}.preview-label{z-index:2;position:absolute;top:12px;left:14px;color:#91a0a3;font-size:8px;letter-spacing:1.4px;pointer-events:none}.preview-bottom{z-index:2;position:absolute;bottom:12px;left:14px;right:14px;display:flex;justify-content:space-between;color:#d8b878;font-size:9px;letter-spacing:1.1px;pointer-events:none}.garage-condition{display:flex;align-items:center;gap:12px;padding:13px 4px;color:#89999e;font-size:8px;letter-spacing:1px}.condition-bar{height:5px;flex:1;background:#344247}.condition-bar i{display:block;width:100%;height:100%;background:#83aa6c}.garage-condition b{color:#9fbd8d;font-size:9px}
  .garage-controls{display:flex;flex-direction:column;gap:14px;min-width:0}.garage-section{padding:14px;background:rgba(4,9,12,.38);border:1px solid #34434a}.garage-section-head{margin-bottom:12px}.garage-section-head h3{margin:5px 0;color:#e5e9e8;font-size:16px}.garage-section-head p{margin:0;color:#8c9a9f;font-size:10px;line-height:1.45}.garage-section label{display:block;margin:11px 0 5px;color:#9ba9ad;font-size:8px;font-weight:bold;letter-spacing:1.2px}.garage-section select{width:100%;height:36px;padding:0 10px;border:1px solid #4b5b61;border-radius:0;background:#1c292f;color:#e5e9e8;font-size:11px;outline:none}.garage-section select:focus{border-color:#c59a58}.garage-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.garage-stat-grid div{padding:9px;background:#172228;border-left:2px solid #b88b49}.garage-stat-grid small{display:block;color:#7f9095;font-size:8px;letter-spacing:1px}.garage-stat-grid b{display:block;margin-top:5px;color:#e3c58e;font-size:11px}.garage-secondary-action{width:100%;height:37px;margin-top:12px;border:1px solid #b78c4b;background:#594528;color:#f2d39b;font-size:10px;font-weight:bold;letter-spacing:1px;cursor:pointer}.garage-footnote{padding:10px 12px;border-left:2px solid #b78c4b;background:rgba(183,140,75,.08);color:#9aa8ac;font-size:9px;line-height:1.5}.garage-footer{height:32px;flex:0 0 32px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-top:1px solid #344148;background:#10171b;color:#a7b2b5;font-size:8px;letter-spacing:1.2px}.garage-footer small{color:#728187}.garage-footer #garage-status{color:#9fbd8d}
  @media(max-width:850px){.garage-shell{height:96vh;min-height:0}.garage-topbar{padding:0 12px;gap:10px}.garage-brand{min-width:0}.garage-top-stats{gap:9px}.garage-return{min-width:145px}.garage-layout{grid-template-columns:58px minmax(0,1fr)}.garage-nav{padding:12px 5px}.garage-nav-title,.garage-nav-item span,.garage-nav-foot{display:none}.garage-nav-item{justify-content:center;padding:0}.garage-main{grid-template-columns:1fr;grid-template-rows:auto;padding:12px;gap:12px;overflow:auto}.garage-preview{min-height:210px;flex:none}.garage-controls{display:grid;grid-template-columns:1fr 1fr}.garage-footnote{grid-column:1/-1}}
  @media(max-width:560px){#garage{padding:0}.garage-shell{width:100%;height:100vh;clip-path:none}.garage-topbar{height:58px;flex-basis:58px}.garage-brand-mark{width:30px;height:30px}.garage-brand b{font-size:11px}.garage-brand small{font-size:7px}.garage-top-stats{display:none}.garage-return{margin-left:auto;min-width:132px;height:35px;font-size:9px}.garage-layout{grid-template-columns:48px minmax(0,1fr)}.garage-main{padding:8px}.garage-preview{min-height:170px}.garage-controls{grid-template-columns:1fr}.garage-footer{padding:0 8px;font-size:7px}}
`;
document.head.appendChild(garageOverlayStyle);
const garageExtremeStyle=document.createElement('style');
garageExtremeStyle.textContent=`
#hud.overlay-open .hud-panel,#hud.overlay-open #help,#hud.overlay-open #wave-banner{visibility:hidden!important}
.garage-shell{background:linear-gradient(145deg,#172126,#0b1115);border-color:rgba(183,207,218,.35);box-shadow:0 30px 70px rgba(0,0,0,.72)}
#garage{padding:0}
.garage-shell{width:100%;height:100%;min-height:0;border:0;clip-path:none}
#main-menu{padding:0}
.main-menu-shell{width:100%;height:100%;min-height:0;border:0}
.main-menu-panel>label.main-menu-mode-card{max-width:420px;margin-top:24px}
.garage-main>.garage-controls{min-height:0;overflow:auto;scrollbar-color:#52626a #172126;scrollbar-width:thin}
.garage-controls{min-height:0!important;overflow:auto!important;scrollbar-width:thin}
.garage-section{display:none!important}
.garage-section.active{display:block!important;animation:garage-panel-in .16s ease-out}
.garage-section>label{margin-top:18px!important}
.garage-native-choice{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.garage-item-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}
.garage-item-card{position:relative;min-width:0;min-height:76px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:5px;padding:12px 11px;border:1px solid #3b4b52;background:linear-gradient(145deg,#1b292f,#121c21);color:#dce2df;text-align:left;cursor:pointer;transition:border-color .12s,background .12s}
.garage-item-card:hover{border-color:#9d8051;background:#243238}
.garage-item-card.selected{border-color:#c59a58;background:linear-gradient(110deg,#40331f,#1a2529);box-shadow:inset 2px 0 #d7ad64}
.garage-item-card b{max-width:100%;font-size:10px;letter-spacing:.7px;text-transform:uppercase}
.garage-item-card small{color:#9ca9aa;font-size:8px;line-height:1.35}
.garage-item-card em{color:#d3b477;font-size:8px;font-style:normal;letter-spacing:.6px}
.garage-item-equipped{position:absolute;right:7px;top:7px;color:#a9ca8f;font-size:7px;font-weight:bold;letter-spacing:.8px}
.garage-paint-chip{width:100%;height:22px;border:1px solid #ffffff44;box-shadow:inset 0 0 0 1px #0005}
.garage-item-grid[data-grid-for="tank-color"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.garage-item-grid[data-grid-for="tank-color"] .garage-item-card{min-height:68px;padding:8px}
.garage-item-grid[data-grid-for="tank-color"] .garage-item-card b{font-size:8px}
.garage-item-grid[data-grid-for="map-style"],.garage-item-grid[data-grid-for="game-mode"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.garage-item-grid[data-grid-for="map-style"] .garage-item-card,.garage-item-grid[data-grid-for="game-mode"] .garage-item-card{min-height:66px;padding:9px}
.garage-item-grid[data-grid-for="map-style"] .garage-item-card b,.garage-item-grid[data-grid-for="game-mode"] .garage-item-card b{font-size:8px}
.garage-section[data-garage-section="paint"] .garage-item-grid{max-height:218px;overflow:auto;padding-right:3px;scrollbar-color:#52626a #172126;scrollbar-width:thin}
.garage-section[data-garage-section="rank"]{display:none!important}
.garage-selection-summary{margin-top:14px;padding:11px 12px;border-left:2px solid #bc914d;background:#bd914b12;color:#aeb9b9;font-size:9px;line-height:1.5}
.garage-selection-summary b{display:block;margin-bottom:3px;color:#e4c98f;font-size:9px;letter-spacing:.8px}
.garage-rank-card{display:none!important}
.garage-rank-card.active{display:flex!important}
.garage-footnote{display:none!important}
@keyframes garage-panel-in{from{opacity:.6;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.garage-preview{background:linear-gradient(155deg,#19262c,#10171b);position:relative}
.garage-section{background:linear-gradient(145deg,rgba(24,36,43,.78),rgba(7,13,17,.7));border-color:rgba(135,162,172,.34);box-shadow:inset 0 1px rgba(255,255,255,.035)}
.garage-nav-item.active{box-shadow:inset 3px 0 #d5aa63,0 0 22px rgba(202,157,83,.12)}
.garage-rank-card{display:flex;align-items:center;gap:13px;padding:14px 16px;border:1px solid rgba(183,140,75,.38);background:linear-gradient(110deg,rgba(70,53,30,.34),rgba(9,15,19,.44));}
.garage-rank-medal{width:42px;height:42px;flex:0 0 42px;display:grid;place-items:center;clip-path:polygon(50% 0,91% 17%,85% 73%,50% 100%,15% 73%,9% 17%);background:linear-gradient(145deg,#e4c274,#87602c);color:#fff1c7;font-size:20px;text-shadow:0 1px 3px #3a2710}
.garage-rank-info{min-width:0;flex:1}.garage-rank-info>div:first-child{display:flex;align-items:baseline;justify-content:space-between;gap:10px}.garage-rank-info small{color:#a99878;font-size:8px;letter-spacing:1.4px}.garage-rank-info b{color:#f0d59e;font-size:11px;letter-spacing:1px}.garage-rank-next{display:flex;justify-content:space-between;gap:8px;margin-top:7px;color:#9aa7aa;font-size:8px;letter-spacing:.5px}.garage-rank-track{height:4px;margin-top:6px;background:#283238}.garage-rank-track i{display:block;width:0;height:100%;background:linear-gradient(90deg,#98713c,#e2bd71);transition:width .25s ease}
.garage-rank-ladder{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:4px;margin-top:10px}.garage-rank-step{min-width:0;padding:5px 2px;border:1px solid #344148;background:#121a1f;text-align:center;color:#78868a;font-size:7px;line-height:1.3}.garage-rank-step b{display:block;color:inherit;font-size:9px}.garage-rank-step small{display:block;margin-top:2px;font-size:6px;letter-spacing:0}.garage-rank-step.active{border-color:#c39a54;background:#4a3924;color:#f0d59e}.garage-rank-step.complete{border-color:#617351;background:#243222;color:#c1d6a6}
`;document.head.appendChild(garageExtremeStyle);

const healthText = document.getElementById('health-text')!;
const healthFill = document.getElementById('health-fill')!;
const killsText = document.getElementById('kills-text')!;
const creditsText = document.getElementById('credits-text')!;
const weaponText = document.getElementById('weapon-text')!;
const enemyText = document.getElementById('enemy-text')!;
const teamText = document.getElementById('team-text')!;
const powerText = document.getElementById('power-text')!;
const waveText = document.getElementById('wave-text')!;
const ctfObjective = document.getElementById('ctf-objective')!;
const waveBanner = document.getElementById('wave-banner')!;
const hitMarker = document.getElementById('hit-marker')!;
const damageFlash = document.getElementById('damage-flash')!;
const respawnMessage = document.getElementById('respawn-message')!;
const garage = document.getElementById('garage')!;
const garagePreviewElement = document.getElementById('garage-preview')!;

// Prévia 3D isolada da arena: usa outro renderer e outra cena.
// Isso impede que o passe da garagem altere fundo, neblina, viewport ou camadas da batalha.
const garagePreviewScene = new THREE.Scene();
garagePreviewScene.background = null;
garagePreviewScene.add(new THREE.HemisphereLight(0xdcecff, 0x354044, 2.25));
const garageFill = new THREE.PointLight(0x6da9c9, 70, 24, 2); garageFill.position.set(-5,4,3); garagePreviewScene.add(garageFill);
const garageRim = new THREE.DirectionalLight(0x8fbaff, 2.4); garageRim.position.set(-4,7,-6); garagePreviewScene.add(garageRim);
const garagePreviewSun = new THREE.DirectionalLight(0xfff3dc, 2.6);
garagePreviewSun.position.set(5, 10, 4);
garagePreviewSun.castShadow = false;
garagePreviewScene.add(garagePreviewSun);
const garagePreviewRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
garagePreviewRenderer.outputColorSpace = THREE.SRGBColorSpace;
garagePreviewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
garagePreviewRenderer.toneMappingExposure = 1.18;
garagePreviewRenderer.shadowMap.enabled = false;
garagePreviewRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
garagePreviewRenderer.info.autoReset = false;
garagePreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
garagePreviewRenderer.setClearColor(0x000000, 0);
Object.assign(garagePreviewRenderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', zIndex: '1', pointerEvents: 'none' });
garagePreviewElement.appendChild(garagePreviewRenderer.domElement);
let garagePreviewTank: THREE.Object3D = new THREE.Group();
let garagePreviewTurret: THREE.Object3D | undefined;
let garagePreviewRadius = 2.4;
const garagePreviewFocus = new THREE.Vector3(0, 0.85, 0);
const garagePreviewBounds = new THREE.Box3();
const garagePreviewSphere = new THREE.Sphere();
const playerPreviewPairs: Array<{ source: THREE.Object3D; target: THREE.Object3D }> = [];
function rebuildGaragePreview() {
  const yaw = garagePreviewTank.rotation.y || -0.45;
  garagePreviewScene.remove(garagePreviewTank);
  const clone = player.clone(true);
  clone.visible = true;
  clone.position.set(0, 0, 0);
  clone.rotation.y = yaw;
  clone.traverse(object => {
    if ((object as THREE.Sprite).isSprite) object.visible = false;
    if ((object as THREE.Mesh).isMesh) {
      const mesh = object as THREE.Mesh;
      if (mesh.userData.garageGearProxy) mesh.visible = true;
      mesh.castShadow = !!mesh.userData.modelMesh || Object.values(hullGeometryByClass).includes(mesh.geometry) || Object.values(turretGeometryByClass).includes(mesh.geometry as THREE.ExtrudeGeometry) || mesh.geometry === barrelGeometry;
      mesh.receiveShadow = false;
    }
  });
  garagePreviewScene.add(clone);
  clone.updateMatrixWorld(true);
  garagePreviewBounds.makeEmpty();
  clone.traverse(object => {
    if ((object as THREE.Mesh).isMesh && object.visible) garagePreviewBounds.expandByObject(object);
  });
  if (!garagePreviewBounds.isEmpty()) {
    garagePreviewBounds.getBoundingSphere(garagePreviewSphere);
    garagePreviewRadius = Math.max(garagePreviewSphere.radius, 1);
    garagePreviewFocus.copy(garagePreviewSphere.center);
  }
  garagePreviewTank = clone;
  const turretIndex = player.children.indexOf(playerTurret);
  garagePreviewTurret = turretIndex >= 0 ? clone.children[turretIndex] : undefined;
  const sourceNodes: THREE.Object3D[] = [];
  const targetNodes: THREE.Object3D[] = [];
  player.traverse(object => sourceNodes.push(object));
  clone.traverse(object => targetNodes.push(object));
  playerPreviewPairs.length = 0;
  for (let i = 1; i < Math.min(sourceNodes.length, targetNodes.length); i++) {
    playerPreviewPairs.push({ source: sourceNodes[i], target: targetNodes[i] });
  }
}
rebuildGaragePreview();
const garagePreviewFloor = new THREE.Mesh(
  new THREE.CircleGeometry(4.8, 64),
  new THREE.MeshBasicMaterial({ color: 0x202a2e, transparent: true, opacity: 0.94 })
);
garagePreviewFloor.rotation.x = -Math.PI / 2;
garagePreviewFloor.position.set(0, -0.035, 0);
garagePreviewFloor.receiveShadow = false;
garagePreviewScene.add(garagePreviewFloor);
// Plataforma de hangar com anéis metálicos.
const garagePreviewRingMaterial = new THREE.MeshBasicMaterial({ color: 0x594a32 });
const garagePreviewRing = new THREE.Mesh(new THREE.TorusGeometry(4.05, 0.045, 6, 56), garagePreviewRingMaterial);
garagePreviewRing.rotation.x = Math.PI / 2;
garagePreviewRing.position.set(0, 0.025, 0);
garagePreviewScene.add(garagePreviewRing);
const garagePreviewInnerRing = new THREE.Mesh(new THREE.TorusGeometry(3.35, 0.018, 5, 48), new THREE.MeshBasicMaterial({ color: 0x3e4a4e, transparent: true, opacity: 0.65 }));
garagePreviewInnerRing.rotation.x = Math.PI / 2;
garagePreviewInnerRing.position.set(0, 0.018, 0);
garagePreviewScene.add(garagePreviewInnerRing);
const garagePreviewCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 80);
garagePreviewCamera.position.set(6.8, 4.8, -8.0);
garagePreviewCamera.lookAt(0, 0.85, 0);
function resizeGaragePreview() {
  const width = Math.max(1, Math.floor(garagePreviewElement.clientWidth));
  const height = Math.max(1, Math.floor(garagePreviewElement.clientHeight));
  if (width < 2 || height < 2) return;
  garagePreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
  garagePreviewRenderer.setSize(width, height, false);
  garagePreviewCamera.aspect = width / height;
  garagePreviewCamera.updateProjectionMatrix();
  // Enquadra o tanque INTEIRO, mesmo se a caixa da prévia for estreita ou baixa.
  const vFov = THREE.MathUtils.degToRad(garagePreviewCamera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * garagePreviewCamera.aspect);
  const distance = garagePreviewRadius * 0.95 / Math.sin(Math.min(vFov, hFov) / 2);
  garagePreviewCamera.position.copy(new THREE.Vector3(6.8, 3.95, -8.0).normalize().multiplyScalar(distance)).add(garagePreviewFocus);
  const lookAt = garagePreviewFocus.clone();
  lookAt.y -= garagePreviewRadius * 0.8;
  garagePreviewCamera.lookAt(lookAt);
}
function syncGaragePreview() {
  for (const pair of playerPreviewPairs) {
    if ((pair.target as THREE.Sprite).isSprite) {
      pair.target.visible = false;
      continue;
    }
    pair.target.scale.copy(pair.source.scale);
    pair.target.visible = pair.source.userData.garageGearProxy || pair.source.visible;
    pair.target.position.copy(pair.source.position);
    if ((pair.source as THREE.InstancedMesh).isInstancedMesh && pair.source.userData.garageGearProxy && (pair.target as THREE.InstancedMesh).isInstancedMesh) {
      const sourceGear = pair.source as THREE.InstancedMesh;
      const targetGear = pair.target as THREE.InstancedMesh;
      targetGear.instanceMatrix.array.set(sourceGear.instanceMatrix.array);
      targetGear.instanceMatrix.needsUpdate = true;
    }
    if ((pair.source as THREE.Mesh).isMesh && (pair.target as THREE.Mesh).isMesh) (pair.target as THREE.Mesh).material = (pair.source as THREE.Mesh).material;
  }
}


Object.assign(waveBanner.style, {
  position: 'fixed',
  left: '50%',
  top: '24%',
  transform: 'translateX(-50%)',
  color: '#ffffff',
  fontFamily: 'Arial, sans-serif',
  fontSize: '22px',
  fontWeight: 'bold',
  textShadow: '2px 2px 4px #000000',
  zIndex: '30',
  pointerEvents: 'none',
  textAlign: 'center'
});

// Minimapa leve em canvas 2D, sem depender de bibliotecas extras.
const minimap = document.createElement('canvas');
minimap.width = 190;
minimap.height = 190;
minimap.id = 'minimap';
Object.assign(minimap.style, {
  position: 'fixed',
  right: '16px',
  top: '16px',
  width: '190px',
  height: '190px',
  zIndex: '20',
  background: 'rgba(15, 25, 18, 0.82)',
  border: '2px solid rgba(255,255,255,0.65)',
  borderRadius: '8px',
  imageRendering: 'pixelated',
  pointerEvents: 'none'
});
document.body.appendChild(minimap);
const minimapContext = minimap.getContext('2d')!;
let minimapTimer = 0;

function drawMinimap(delta: number) {
  minimapTimer -= delta;
  if (minimapTimer > 0) return;
  minimapTimer = 0.10;

  const ctx = minimapContext;
  const size = minimap.width;
  const margin = 9;
  const usable = size - margin * 2;
  const scale = usable / 112;
  const mapX = (x: number) => margin + (x + 56) * scale;
  const mapZ = (z: number) => margin + (z + 56) * scale;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#27352b';
  ctx.fillRect(margin, margin, usable, usable);

  ctx.fillStyle = '#a6aaa0';
  for (const obstacle of obstacles) {
    if (obstacle.style && obstacle.style !== mapStyleName) continue;
    ctx.fillRect(
      mapX(obstacle.center.x - obstacle.halfX),
      mapZ(obstacle.center.z - obstacle.halfZ),
      obstacle.halfX * 2 * scale,
      obstacle.halfZ * 2 * scale
    );
  }

  ctx.fillStyle = 'rgba(20,20,20,0.9)';
  ctx.beginPath();
  ctx.arc(mapX(-34), mapZ(-34), 5 * scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(245,245,245,0.95)';
  ctx.beginPath();
  ctx.arc(mapX(34), mapZ(34), 5 * scale, 0, Math.PI * 2);
  ctx.fill();

  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    ctx.fillStyle = playerTeam === 'black' ? '#f4f4f4' : '#171717';
    ctx.beginPath();
    ctx.arc(
      mapX(enemy.parts.root.position.x),
      mapZ(enemy.parts.root.position.z),
      3.2, 0, Math.PI * 2
    );
    ctx.fill();
  }

  if (playerAlive) {
    const px = mapX(player.position.x);
    const pz = mapZ(player.position.z);
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(-player.rotation.y);
    ctx.fillStyle = playerTeam === 'black' ? '#ffffff' : '#111111';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(margin, margin, usable, usable);
}

function updateHUD() {
  const garageCredits = document.getElementById('garage-credits');
  const garageCrystals = document.getElementById('garage-crystals');
  const garageKills = document.getElementById('garage-kills');
  const garageTeamLabel = document.getElementById('garage-team-label');
  const garageRankName = document.getElementById('garage-rank-name');
  const garageRankProgress = document.getElementById('garage-rank-progress') as HTMLElement | null;
  const garageRankProgressLabel = document.getElementById('garage-rank-progress-label');
  const garageRankNextName = document.getElementById('garage-rank-next-name');
  const garageRankLadder = document.getElementById('garage-rank-ladder');
  if (garageCredits) garageCredits.textContent = String(playerCredits);
  if (garageCrystals) garageCrystals.textContent = String(playerCrystals);
  if (garageKills) garageKills.textContent = String(playerKills);
  if (garageTeamLabel) garageTeamLabel.textContent = playerTeam === 'black' ? 'PRETO' : 'BRANCO';
  if (garageRankName) garageRankName.textContent = rankNames[playerRankIndex].toUpperCase();
  const nextRankThreshold = rankThresholds[playerRankIndex + 1];
  const rankProgress = nextRankThreshold === undefined ? 100 : THREE.MathUtils.clamp(
    ((playerKills - rankThresholds[playerRankIndex]) / (nextRankThreshold - rankThresholds[playerRankIndex])) * 100, 0, 100
  );
  if (garageRankProgress) garageRankProgress.style.width = `${rankProgress}%`;
  if (garageRankProgressLabel) garageRankProgressLabel.textContent = nextRankThreshold === undefined
    ? `${playerKills} eliminações · patente máxima`
    : `${playerKills - rankThresholds[playerRankIndex]} / ${nextRankThreshold - rankThresholds[playerRankIndex]} eliminações`;
  if (garageRankNextName) garageRankNextName.textContent = nextRankThreshold === undefined
    ? 'PATENTE MÁXIMA'
    : `PRÓXIMA: ${rankNames[playerRankIndex + 1].toUpperCase()}`;
  if (garageRankLadder) {
    garageRankLadder.innerHTML = rankNames.map((name, index) => {
      const state = index < playerRankIndex ? 'complete' : index === playerRankIndex ? 'active' : '';
      return `<div class="garage-rank-step ${state}"><b>${index + 1}</b>${name}<small>${rankThresholds[index]} K</small></div>`;
    }).join('');
  }
  const menuRank = document.getElementById('main-menu-rank');
  const menuCredits = document.getElementById('main-menu-credits');
  const menuCrystals = document.getElementById('main-menu-crystals');
  const containerCrystals = document.getElementById('container-crystals');
  const menuXpLabel = document.getElementById('main-menu-xp-label');
  const menuXpBar = document.getElementById('main-menu-xp-bar') as HTMLElement | null;
  const menuRankList = document.getElementById('main-menu-rank-list');
  if (menuRank) menuRank.textContent = rankNames[playerRankIndex].toUpperCase();
  if (menuCredits) menuCredits.textContent = String(playerCredits);
  if (menuCrystals) menuCrystals.textContent = String(playerCrystals);
  if (containerCrystals) containerCrystals.textContent = String(playerCrystals);
  if (menuXpLabel) menuXpLabel.textContent = nextRankThreshold === undefined
    ? 'PATENTE MÁXIMA'
    : `${playerKills - rankThresholds[playerRankIndex]} / ${nextRankThreshold - rankThresholds[playerRankIndex]} ELIMINAÇÕES`;
  if (menuXpBar) menuXpBar.style.width = `${rankProgress}%`;
  if (menuRankList) {
    menuRankList.innerHTML = rankNames.map((name, index) => {
      const state = index < playerRankIndex ? 'complete' : index === playerRankIndex ? 'active' : '';
      return `<div class="main-menu-rank-step ${state}"><b>${index + 1}. ${name}</b>${index === playerRankIndex ? 'PATENTE ATUAL' : index < playerRankIndex ? 'CONCLUÍDA' : 'BLOQUEADA'}<small>${rankThresholds[index]} eliminações</small></div>`;
    }).join('');
  }
  healthText.textContent =
    `Vida: ${Math.ceil(playerHealth)} / ${playerMaxHealth}`;

  healthFill.style.width = `${THREE.MathUtils.clamp(
    (playerHealth / playerMaxHealth) * 100, 0, 100
  )}%`;
  playerTeamHealthBar.update(playerHealth, playerMaxHealth);

  killsText.textContent = `Eliminações: ${playerKills}`;
  creditsText.textContent = `Cristais: ${playerCrystals} · Patente: ${rankNames[playerRankIndex]}`;
  weaponText.textContent = selectedWeapon === 'cannon'
    ? 'Arma: Canhão (1)'
    : 'Arma: Metralhadora (2)';
  enemyText.textContent =
    `Bots vivos: ${enemies.filter(e => e.alive).length} · Preto ${enemies.filter(e => e.alive && e.team === 'black').length} / Branco ${enemies.filter(e => e.alive && e.team === 'white').length}`;
  teamText.textContent = `Time: ${playerTeam === 'black' ? 'Preto' : 'Branco'}`;
  const activePowers = [
    powerDamageTimer > 0 ? `Dano 2x ${Math.ceil(powerDamageTimer)}s` : '',
    powerArmorTimer > 0 ? `Blindagem 2x ${Math.ceil(powerArmorTimer)}s` : '',
    powerSpeedTimer > 0 ? `Velocidade 2x ${Math.ceil(powerSpeedTimer)}s` : ''
  ].filter(Boolean);
  powerText.textContent = activePowers.length ? activePowers.join(' · ') : `Caixas restantes: ${crateQueue.length + crates.length}`;
  waveText.textContent = gameMode === 'survival' ? `Onda: ${currentWave}` : gameMode === 'ctf' ? `PLACAR — PRETO ${ctfScore.black} x BRANCO ${ctfScore.white} · FUNDO ${battleFund} ◈` : `FUNDO ${battleFund} ◈ · TEMPO ${Math.ceil(matchTime)}s`;
  const ownFlag = flags[playerTeam];
  ctfObjective.textContent = gameMode !== 'ctf' ? 'Objetivo: elimine os adversários' : playerFlagCarrying ? 'OBJETIVO: volte à sua base com a bandeira!' : ownFlag.dropped ? 'OBJETIVO: recupere a bandeira da sua equipe!' : 'OBJETIVO: encoste na bandeira inimiga e retorne à sua base';
  saveLocalEconomy();
}

function refreshPaintAvailability() {
  const paintSelect = document.getElementById('tank-color') as HTMLSelectElement | null;
  if (!paintSelect) return;
  for (const option of Array.from(paintSelect.options)) {
    if (!option.dataset.baseLabel) option.dataset.baseLabel = option.textContent ?? '';
    const owned = ownedPaints.has(option.value);
    option.disabled = !owned;
    option.textContent = owned ? option.dataset.baseLabel : `${option.dataset.baseLabel} · CONTÊINER`;
  }
}

function showHitMarker() {
  hitMarker.classList.remove('hit');
  void hitMarker.offsetWidth;
  hitMarker.classList.add('hit');
}

function showDamageFlash() {
  damageFlash.classList.remove('damage');
  void damageFlash.offsetWidth;
  damageFlash.classList.add('damage');
}

// =====================================================
// GARAGEM
// =====================================================

let garageOpen = false;
let mainMenuOpen = false;

function setLobbyOverlayVisibility(visible: boolean) {
  hud.classList.toggle('overlay-open', visible);
  minimap.style.visibility = visible ? 'hidden' : 'visible';
  fpsHud.style.visibility = visible ? 'hidden' : 'visible';
}

function showMainMenu() {
  if (garageOpen) closeGarage();
  mainMenuOpen = true;
  setLobbyOverlayVisibility(true);
  mainMenu.classList.remove('hidden');
  mainMenu.querySelectorAll('.main-menu-nav button').forEach(button => button.classList.remove('active'));
  mainMenu.querySelectorAll('.main-menu-panel').forEach(section => section.classList.remove('active'));
  mainMenu.querySelector('[data-menu-panel="battle"]')?.classList.add('active');
  mainMenu.querySelector('[data-menu-section="battle"]')?.classList.add('active');
  (document.getElementById('main-menu-mode') as HTMLSelectElement).value = (document.getElementById('game-mode') as HTMLSelectElement).value;
  (document.getElementById('main-menu-map') as HTMLSelectElement).value = mapStyleName;
  (document.getElementById('main-menu-lighting') as HTMLSelectElement).value = lightingStyle;
  (document.getElementById('main-menu-quality') as HTMLSelectElement).value = graphicsQuality;
  document.exitPointerLock?.();
  firing = false;
  mouseFiring = false;
  fpsFrameCount = 0;
  fpsWindowStart = performance.now();
  updateHUD();
}

function hideMainMenu() {
  mainMenuOpen = false;
  mainMenu.classList.add('hidden');
  if (!garageOpen) setLobbyOverlayVisibility(false);
  fpsFrameCount = 0;
  fpsWindowStart = performance.now();
}

function openGarage() {
  hideMainMenu();
  garageOpen = true;
  setLobbyOverlayVisibility(true);
  garage.classList.remove('hidden');
  setGarageTab('vehicle');
  requestAnimationFrame(resizeGaragePreview);
  const returnButton = document.getElementById('garage-close') as HTMLButtonElement;
  (document.getElementById('tank-weapon') as HTMLSelectElement).value = selectedWeapon;
  returnButton.textContent = 'FECHAR GARAGEM';
  const status = document.getElementById('garage-status');
  const condition = document.getElementById('garage-condition-text');
  const liveStatus = garage.querySelector('.garage-live');
  if (status) status.textContent = 'COMBATE ATIVO · CONFIGURE SEU TANQUE';
  if (liveStatus) liveStatus.innerHTML = '<i></i> COMBATE ATIVO';
  if (condition) condition.textContent = playerAlive ? 'OPERACIONAL' : 'RETORNO EM CURSO';
  firing = false;
  mouseFiring = false;
  document.exitPointerLock?.();
}

function closeGarage() {
  // Garagem é opcional; o combate e o respawn continuam normalmente.
  garageOpen = false;
  garage.classList.add('hidden');
  if (!mainMenuOpen) setLobbyOverlayVisibility(false);
  // Zera a janela de FPS para a garagem aberta não contaminar a medição.
  fpsFrameCount = 0;
  fpsWindowStart = performance.now();
}

function returnToBattle() {
  closeGarage();
}

menuButton.addEventListener('click', showMainMenu);
(document.getElementById('open-container') as HTMLButtonElement).addEventListener('click', () => {
  const result = document.getElementById('container-result');
  if (playerCrystals < 100) {
    if (result) result.textContent = 'Cristais insuficientes para abrir este contêiner.';
    return;
  }
  const paintSelect = document.getElementById('tank-color') as HTMLSelectElement;
  const lockedPaints = Array.from(paintSelect.options).filter(option => !ownedPaints.has(option.value));
  playerCrystals -= 100;
  let rewardText: string;
  if (lockedPaints.length > 0) {
    const reward = lockedPaints[Math.floor(Math.random() * lockedPaints.length)];
    ownedPaints.add(reward.value);
    refreshPaintAvailability();
    rewardText = `Nova pintura desbloqueada: ${reward.dataset.baseLabel ?? reward.textContent}`;
  } else {
    playerCrystals += 25;
    rewardText = 'Todas as pinturas liberadas: compensação de 25 cristais.';
  }
  saveLocalEconomy();
  updateHUD();
  if (result) result.textContent = `${rewardText} Saldo: ${playerCrystals} cristais.`;
});
(document.getElementById('main-menu-resume') as HTMLButtonElement).addEventListener('click', hideMainMenu);
document.querySelectorAll<HTMLButtonElement>('[data-menu-panel]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('[data-menu-panel]').forEach(item => item.classList.remove('active'));
    document.querySelectorAll<HTMLElement>('[data-menu-section]').forEach(section => section.classList.remove('active'));
    button.classList.add('active');
    const section = mainMenu.querySelector(`[data-menu-section="${button.dataset.menuPanel}"]`);
    section?.classList.add('active');
  });
});
const openMenuGarage = () => { hideMainMenu(); openGarage(); };
document.querySelectorAll<HTMLButtonElement>('[data-menu-action="garage"], #main-menu-garage').forEach(button => button.addEventListener('click', openMenuGarage));
(document.getElementById('main-menu-quality') as HTMLSelectElement).addEventListener('change', event => {
  const garageQuality = document.getElementById('graphics-quality') as HTMLSelectElement;
  garageQuality.value = (event.target as HTMLSelectElement).value;
  garageQuality.dispatchEvent(new Event('change', { bubbles: true }));
});
(document.getElementById('main-menu-play') as HTMLButtonElement).addEventListener('click', () => {
  const menuMode = document.getElementById('main-menu-mode') as HTMLSelectElement;
  const battleMode = document.getElementById('game-mode') as HTMLSelectElement;
  const mapSelect = document.getElementById('map-style') as HTMLSelectElement;
  mapSelect.value = (document.getElementById('main-menu-map') as HTMLSelectElement).value;
  mapSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const lightingSelect = document.getElementById('lighting-mode') as HTMLSelectElement;
  lightingSelect.value = (document.getElementById('main-menu-lighting') as HTMLSelectElement).value;
  lightingSelect.dispatchEvent(new Event('change', { bubbles: true }));
  battleMode.value = menuMode.value;
  battleMode.dispatchEvent(new Event('change', { bubbles: true }));
  hideMainMenu();
});

document.querySelectorAll<HTMLButtonElement>('.garage-nav-item').forEach(button => {
  button.addEventListener('click', () => {
    const target = button.dataset.garageTab;
    if (target) setGarageTab(target);
  });
});

function setGarageTab(target: string) {
  garage.dataset.activeTab = target;
  garage.querySelectorAll<HTMLButtonElement>('.garage-nav-item').forEach(item => {
    const selected = item.dataset.garageTab === target;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', String(selected));
  });
  garage.querySelectorAll<HTMLElement>('[data-garage-section]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.garageSection === target);
  });
}

document.getElementById('garage-close')!.addEventListener('click', returnToBattle);

document.getElementById('team-select')!.addEventListener('change', event => {
  const nextTeam = (event.target as HTMLSelectElement).value as Team;
  if (nextTeam !== 'black' && nextTeam !== 'white') return;
  playerTeam = nextTeam;
  player.position.copy(findSafePlayerSpawn());
  playerLinearSpeed = 0;
  player.position.y = 0;
  previousPlayerPosition.copy(player.position);
  player.rotation.set(0, playerArenaHeading(), 0);
  syncTankGearToWorld(playerParts);
  playerTeamHealthBar.setTeam(playerTeam);
  player.traverse(object => { if (object.userData.neon) (object as THREE.Mesh).material = neonMaterial(accentFor(playerTeam)); });
  const playerMarking = tankMarkingMaterial(accentFor(playerTeam), playerParts.unitNumber);
  for (const marking of playerParts.markings) marking.material = playerMarking;
  syncGaragePreview();

  // Mantém três veículos por equipe: jogador + 2 aliados contra 3 bots.
  clearProjectiles();
  clearEnemyRoster();
  for (let i = 0; i < 2; i++) createEnemy(playerTeam);
  for (let i = 0; i < 3; i++) createEnemy(oppositeTeam(playerTeam));
  resetCaptureTheFlag();
  updateHUD();
  respawnMessage.textContent = `VOCÊ ESTÁ NO TIME ${playerTeam === 'black' ? 'PRETO' : 'BRANCO'}`;
  window.setTimeout(() => { respawnMessage.textContent = ''; }, 1400);
});

document.getElementById('tank-weapon')!.addEventListener('change', event => {
  selectedWeapon = (event.target as HTMLSelectElement).value === 'rapid' ? 'rapid' : 'cannon';
  updateHUD();
  const status = document.getElementById('garage-status');
  if (status) status.textContent = `ARMAMENTO EQUIPADO: ${selectedWeapon === 'rapid' ? 'AUTOCANHÃO' : 'CANHÃO'}`;
});

document.getElementById('tank-class')!.addEventListener('change', event => {
  const nextClass = (event.target as HTMLSelectElement).value as TankClass;
  if (!(nextClass in TANK_CLASSES)) return;
  const oldMax = playerMaxHealth;
  selectedTankClass = nextClass;
  const stats = TANK_CLASSES[selectedTankClass];
  playerMaxHealth = stats.maxHealth + playerHealthBonus;
  playerHealth = Math.min(playerMaxHealth, Math.round(playerHealth * (playerMaxHealth / Math.max(1, oldMax))));
  playerParts.hull.scale.set(...stats.hullScale);
  playerParts.turretBody.scale.set(...stats.turretScale);
  playerParts.barrel.scale.set(...stats.barrelScale);
  playerMoveMultiplier = Math.min(1.3, stats.speed + playerSpeedBonus);
  playerArmor = Math.min(0.35, stats.armor + playerArmorBonus);
  if (modelTemplates.size > 0) {
    applyTankModel(playerParts, selectedTankClass, playerPaintColor, accentFor(playerTeam));
    rebuildGaragePreview();
  }
  syncGaragePreview();
  const previewClass = document.getElementById('preview-class');
  const garageRole = document.getElementById('garage-role');
  const garageHealthStat = document.getElementById('garage-health-stat');
  if (previewClass) previewClass.textContent = `TANQUE ${stats.label.toUpperCase()}`;
  if (garageRole) garageRole.textContent = stats.label.toUpperCase();
  if (garageHealthStat) garageHealthStat.textContent = `${playerMaxHealth} HP`;
  updateHUD();
  respawnMessage.textContent = `CLASSE ${stats.label.toUpperCase()} EQUIPADA`;
  window.setTimeout(() => { respawnMessage.textContent = ''; }, 1300);
});

document.getElementById('tank-color')!.addEventListener('change', event => {
  const value = Number((event.target as HTMLSelectElement).value);

  // As 3 variações de pintura do jogador (principal, escura, clara) são tingidas juntas.
  const [paintMain, paintDark, paintLight] = makeTankPaintSet(0x5c6240);
  paintMain.color.setHex(value);
  paintDark.color.setHex(value).multiplyScalar(0.72);
  paintLight.color.setHex(value);
  playerParts.paintDetailsMaterial.color.setHex(value);
  playerPaintColor = value;
  if (playerParts.model) {
    applyTankModel(playerParts, selectedTankClass, playerPaintColor, accentFor(playerTeam));
    rebuildGaragePreview();
  }
  syncGaragePreview();
});

document.getElementById('tank-style')!.addEventListener('change', event => {
  const style = (event.target as HTMLSelectElement).value;

  const base = TANK_CLASSES[selectedTankClass];
  const factor = style === 'heavy' ? 1.18 : style === 'slim' ? 0.82 : 1;
  playerParts.turretBody.scale.set(base.turretScale[0] * factor, base.turretScale[1] * factor, base.turretScale[2] * factor);
  playerParts.barrel.scale.set(base.barrelScale[0] * factor, base.barrelScale[1] * factor, base.barrelScale[2] * factor);
  syncGaragePreview();
});

document.getElementById('upgrade-buy')!.addEventListener('click', () => {
  const selector = document.getElementById('tank-upgrade') as HTMLSelectElement;
  const upgrade = selector.value;
  if (upgrade === 'none') return;

  if (playerCredits < 50) {
    respawnMessage.textContent = 'CRÉDITOS INSUFICIENTES';
    window.setTimeout(() => { respawnMessage.textContent = ''; }, 1200);
    return;
  }

  playerCredits -= 50;

  if (upgrade === 'engine') {
    const oldSpeed = playerMoveMultiplier;
    playerMoveMultiplier = Math.min(1.3, playerMoveMultiplier + 0.1);
    playerSpeedBonus += playerMoveMultiplier - oldSpeed;
  } else if (upgrade === 'armor') {
    playerHealthBonus += 20;
    playerMaxHealth += 20;
    playerHealth = Math.min(playerMaxHealth, playerHealth + 20);
    const oldArmor = playerArmor;
    playerArmor = Math.min(0.35, playerArmor + 0.1);
    playerArmorBonus += playerArmor - oldArmor;
  } else if (upgrade === 'damage') {
    playerDamageMultiplier = Math.min(1.6, playerDamageMultiplier + 0.15);
  }

  selector.value = 'none';
  updateHUD();
  respawnMessage.textContent = 'MELHORIA INSTALADA!';
  window.setTimeout(() => { respawnMessage.textContent = ''; }, 1200);
});

function applyQuality() {
  renderer.shadowMap.enabled = false;
  sun.castShadow = false;
  const terrainAnisotropy = Math.min(
    graphicsQuality === 'maximum' ? 4 : graphicsQuality === 'high' ? 4 : 2,
    renderer.capabilities.getMaxAnisotropy()
  );
  for (const texture of [groundMaterial.map]) {
    if (!texture) continue;
    texture.anisotropy = terrainAnisotropy;
    texture.needsUpdate = true;
  }
  setupPostFx();
  applyPixelRatio();
}

document.getElementById('graphics-quality')!.addEventListener('change', event => {
  const quality = (event.target as HTMLSelectElement).value as QualityLevel;
  graphicsQuality = quality;
  fxAutoDisabled = false;
  applyQuality();
  const status = document.getElementById('garage-status');
  if (status) status.textContent = `GRÁFICOS: ${quality === 'maximum' ? 'MÁXIMO FPS' : quality === 'high' ? 'ALTO' : 'EQUILIBRADO'}`;
});

function applyBattleLighting() {
  const night = lightingStyle === 'night';
  const skyStyle: SkyStyle = night ? 'night' : mapStyleName === 'desert' ? 'desert' : 'field';
  skyMaterial.map = getSkyTexture(skyStyle);
  skyMaterial.needsUpdate = true;
  hemi.color.setHex(night ? 0x8fa8d8 : 0xffffff);
  hemi.groundColor.setHex(night ? 0x1a2230 : mapStyleName === 'desert' || mapStyleName === 'canyon' ? 0x7a6a45 : mapStyleName === 'snow' ? 0x91a4b0 : 0x526044);
  hemi.intensity = night ? 1.15 : mapStyleName === 'desert' ? 1.7 : 1.8;
  sun.color.setHex(night ? 0x9db8ff : mapStyleName === 'desert' ? 0xffe2b0 : 0xfff3dc);
  sun.intensity = night ? 1.25 : mapStyleName === 'desert' ? 2.7 : 2.4;
  fxLightGain = night ? 0.42 : 1;
  if (night) {
    scene.background = new THREE.Color(0x111827);
    scene.fog = new THREE.Fog(0x111827, 45, 115);
    setGridColor(0x40546b);
  } else if (mapStyleName === 'desert' || mapStyleName === 'canyon') {
    scene.background = new THREE.Color(0xe0bd83);
    scene.fog = new THREE.Fog(0xe0bd83, 55, 125);
    setGridColor(0x8c754e);
  } else if (mapStyleName === 'snow') {
    scene.background = new THREE.Color(0xb8d0df);
    scene.fog = new THREE.Fog(0xb8d0df, 55, 125);
    setGridColor(0x8099a6);
  } else {
    scene.background = new THREE.Color(0x87b9d9);
    scene.fog = new THREE.Fog(0x87b9d9, 55, 125);
    setGridColor(mapStyleName === 'industrial' ? 0x63727b : 0x526b40);
  }
  applyAtmosphere();
  updateBattlefieldTheme();
}

document.getElementById('map-style')!.addEventListener('change', event => {
  mapStyleName = (event.target as HTMLSelectElement).value as MapStyle;
  setMapLayout(mapStyleName);
  clearBattlefieldMarks();
  if (mapStyleName === 'desert' || mapStyleName === 'canyon') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0xb9a06f : 0xb49a63);
    dustColor.setHex(0xc9a66b);
    hillMaterial.color.setHex(0x9c8456);
  } else if (mapStyleName === 'snow') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0xc0ccd2 : 0x9cabb5);
    dustColor.setHex(0xaabac2);
    hillMaterial.color.setHex(0xc2d1dc);
  } else if (mapStyleName === 'industrial') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0x737d80 : 0x485459);
    dustColor.setHex(0x777a72);
    hillMaterial.color.setHex(0x59636a);
  } else {
    groundMaterial.color.setHex(groundTextureLoaded ? 0xa0aa8a : 0x657d4b);
    dustColor.setHex(0x8a7d62);
    hillMaterial.color.setHex(0x56694b);
  }
  applyBattleLighting();
});

document.getElementById('lighting-mode')!.addEventListener('change', event => {
  lightingStyle = (event.target as HTMLSelectElement).value === 'night' ? 'night' : 'day';
  applyBattleLighting();
});

document.getElementById('game-mode')!.addEventListener('change', event => {
  gameMode = (event.target as HTMLSelectElement).value as 'survival' | 'deathmatch' | 'ctf';
  clearBattlefieldMarks();
  matchTime = 180;
  matchEnded = false;
  battleFund = 0;
  playerBattleScore = 0;
  battleScoreTotal = 0;
  playerBattleKills = 0;
  currentWave = 1;
  waitingForNextWave = false;
  waveTimer = 0;

  waveBanner.textContent = gameMode === 'survival'
    ? 'MODO SOBREVIVÊNCIA'
    : gameMode === 'ctf' ? 'ROUBA-BANDEIRA — 3 PONTOS PARA VENCER' : 'MATA-MATA — 3 MINUTOS';
  waveBannerTimer = 2.5;

  setDecorativeFlagsVisible(gameMode !== 'ctf');
  resetCaptureTheFlag();
  clearProjectiles();
  if (gameMode === 'ctf' || gameMode === 'deathmatch') {
    clearEnemyRoster();
    if (gameMode === 'ctf') {
      // Ao entrar no Rouba-Bandeira, o jogador sempre começa no seu próprio lado.
      playerAlive = true;
      playerHealth = playerMaxHealth;
      player.visible = true;
      player.position.copy(findSafePlayerSpawn());
      previousPlayerPosition.copy(player.position);
      player.rotation.set(0, playerArenaHeading(), 0);
      syncTankGearToWorld(playerParts);
      playerSpawnGrace = 3;
      invulnerability = 3;
      respawnTimer = 0;
      playerTeamHealthBar.update(playerHealth, playerMaxHealth);
    }
    for (let i = 0; i < 2; i++) createEnemy(playerTeam);
    for (let i = 0; i < 3; i++) createEnemy(oppositeTeam(playerTeam));
  }
  if (gameMode === 'survival' && enemies.filter(e => e.alive).length === 0) {
    for (let i = 0; i < 2; i++) createEnemy(playerTeam);
    for (let i = 0; i < 3; i++) createEnemy(oppositeTeam(playerTeam));
  }

  updateHUD();
});

// =====================================================
// PARTÍCULAS (GPU, 1 chamada de desenho por camada) E EFEITOS
// =====================================================

let fxLightGain = 1; // escurece fumaça/poeira à noite
let cameraShake = 0;
let dustColor = new THREE.Color(0x8a7d62);
const fxScaleUniform = { value: 600 };

function makeFxMaterial(additive: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: fxScaleUniform },
    vertexShader: `uniform float uScale; attribute vec4 aColor; attribute float aSize; varying vec4 vColor;
      void main(){
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 256.0);
      }`,
    fragmentShader: `varying vec4 vColor;
      void main(){
        float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float a = 1.0 - smoothstep(0.0, 1.0, d);
        a *= a;
        gl_FragColor = vec4(vColor.rgb, vColor.a * a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
  });
}

class PointFx {
  readonly points: THREE.Points;
  private n = 0;
  private readonly cap: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly vel: Float32Array;
  private readonly rgb: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly grav: Float32Array;
  private readonly grow: Float32Array;
  private readonly size0: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly additive: boolean;

  constructor(cap: number, additive: boolean) {
    this.cap = cap;
    this.additive = additive;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.rgb = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.grow = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.alpha0 = new Float32Array(cap);
    const posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    const sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', posAttr);
    this.geometry.setAttribute('aColor', colAttr);
    this.geometry.setAttribute('aSize', sizeAttr);
    this.geometry.setDrawRange(0, 0);
    this.points = new THREE.Points(this.geometry, makeFxMaterial(additive));
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number,
        color: THREE.Color, gain: number, alpha: number, size: number, growth: number, life: number, gravity: number) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    const i3 = i * 3;
    const g = gain * (this.additive ? 1 : fxLightGain);
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.rgb[i3] = color.r * g; this.rgb[i3 + 1] = color.g * g; this.rgb[i3 + 2] = color.b * g;
    this.life[i] = life; this.maxLife[i] = life;
    this.grav[i] = gravity; this.grow[i] = growth;
    this.size0[i] = size; this.alpha0[i] = alpha;
    this.size[i] = size;
    const i4 = i * 4;
    this.col[i4] = this.rgb[i3]; this.col[i4 + 1] = this.rgb[i3 + 1]; this.col[i4 + 2] = this.rgb[i3 + 2]; this.col[i4 + 3] = 0;
  }

  private move(from: number, to: number) {
    const f3 = from * 3, t3 = to * 3, f4 = from * 4, t4 = to * 4;
    for (let k = 0; k < 3; k++) { this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k]; this.rgb[t3 + k] = this.rgb[f3 + k]; }
    for (let k = 0; k < 4; k++) this.col[t4 + k] = this.col[f4 + k];
    this.size[to] = this.size[from]; this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.grav[to] = this.grav[from]; this.grow[to] = this.grow[from]; this.size0[to] = this.size0[from]; this.alpha0[to] = this.alpha0[from];
  }

  update(dt: number) {
    const drag = 1 - Math.min(0.9, dt * 0.9);
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.move(this.n - 1, i); this.n--; continue; }
      const i3 = i * 3, i4 = i * 4;
      this.vel[i3 + 1] -= this.grav[i] * dt;
      this.vel[i3] *= drag; this.vel[i3 + 1] *= drag; this.vel[i3 + 2] *= drag;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.05) { this.pos[i3 + 1] = 0.05; this.vel[i3 + 1] = Math.abs(this.vel[i3 + 1]) * 0.25; }
      const t = 1 - this.life[i] / this.maxLife[i];
      const fade = t < 0.12 ? t / 0.12 : (1 - t) / 0.88;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * t);
      this.col[i4] = this.rgb[i3]; this.col[i4 + 1] = this.rgb[i3 + 1]; this.col[i4 + 2] = this.rgb[i3 + 2];
      this.col[i4 + 3] = this.alpha0[i] * fade;
      i++;
    }
    this.geometry.setDrawRange(0, this.n);
    const position = this.geometry.attributes.position as THREE.BufferAttribute;
    const color = this.geometry.attributes.aColor as THREE.BufferAttribute;
    const size = this.geometry.attributes.aSize as THREE.BufferAttribute;
    position.clearUpdateRanges();
    color.clearUpdateRanges();
    size.clearUpdateRanges();
    if (this.n > 0) {
      position.addUpdateRange(0, this.n * 3);
      color.addUpdateRange(0, this.n * 4);
      size.addUpdateRange(0, this.n);
      position.needsUpdate = true;
      color.needsUpdate = true;
      size.needsUpdate = true;
    }
  }
}

const smokeFx = new PointFx(700, false);
const fireFx = new PointFx(500, true);
scene.add(smokeFx.points, fireFx.points);
const fxTmpColor = new THREE.Color();

// Flashes (clarões) em sprites aditivos reutilizáveis.
const fxGlowCanvas = document.createElement('canvas');
fxGlowCanvas.width = fxGlowCanvas.height = 64;
{
  const g = fxGlowCanvas.getContext('2d')!;
  const gradient = g.createRadialGradient(32, 32, 1, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gradient; g.fillRect(0, 0, 64, 64);
}
const fxGlowTexture = new THREE.CanvasTexture(fxGlowCanvas);
type FlashSlot = { sprite: THREE.Sprite; life: number; maxLife: number; size0: number; size1: number };
const flashPool: FlashSlot[] = [];
for (let i = 0; i < 24; i++) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: fxGlowTexture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sprite.visible = false;
  sprite.renderOrder = 7;
  scene.add(sprite);
  flashPool.push({ sprite, life: 0, maxLife: 1, size0: 1, size1: 1 });
}
let flashCursor = 0;
function spawnFlash(position: THREE.Vector3, size0: number, size1: number, life: number, color: number, gain = 3) {
  const slot = flashPool[flashCursor++ % flashPool.length];
  slot.sprite.position.copy(position);
  (slot.sprite.material as THREE.SpriteMaterial).color.setHex(color).multiplyScalar(gain);
  slot.sprite.visible = true;
  slot.life = life; slot.maxLife = life; slot.size0 = size0; slot.size1 = size1;
  slot.sprite.scale.set(size0, size0, 1);
}

// Marcas de queimado no chão (anel circular de 48 instâncias).
const scorchCanvas = document.createElement('canvas');
scorchCanvas.width = scorchCanvas.height = 128;
{
  const g = scorchCanvas.getContext('2d')!;
  const gradient = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(8,7,6,.82)');
  gradient.addColorStop(0.55, 'rgba(14,12,10,.5)');
  gradient.addColorStop(1, 'rgba(14,12,10,0)');
  g.fillStyle = gradient; g.fillRect(0, 0, 128, 128);
}
const SCORCH_CAP = 48;
const scorchGeometry = new THREE.CircleGeometry(1, 24);
scorchGeometry.rotateX(-Math.PI / 2);
const scorchMesh = new THREE.InstancedMesh(
  scorchGeometry,
  new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(scorchCanvas), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  SCORCH_CAP
);
scorchMesh.count = 0;
scorchMesh.frustumCulled = false;
scorchMesh.renderOrder = 1;
scene.add(scorchMesh);
let scorchCursor = 0;
const scorchDummy = new THREE.Object3D();
function addScorch(position: THREE.Vector3, radius: number) {
  scorchDummy.position.set(position.x, 0.03, position.z);
  scorchDummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
  scorchDummy.scale.set(radius, 1, radius * (0.85 + Math.random() * 0.3));
  scorchDummy.updateMatrix();
  scorchMesh.setMatrixAt(scorchCursor % SCORCH_CAP, scorchDummy.matrix);
  scorchCursor++;
  scorchMesh.count = Math.min(SCORCH_CAP, scorchCursor);
  scorchMesh.instanceMatrix.needsUpdate = true;
}

// Sulcos de esteira reutilizáveis: marcas novas substituem as mais antigas,
// sem criar meshes ou texturas durante a partida.
const TRACK_PRINT_CAP = 512;
const trackPrintCanvas = document.createElement('canvas');
trackPrintCanvas.width = 128; trackPrintCanvas.height = 256;
{
  const context = trackPrintCanvas.getContext('2d')!;
  context.fillStyle = 'rgba(26,24,19,0.34)';
  for (let y = 5; y < 256; y += 24) {
    context.fillRect(9, y, 110, 12);
    context.clearRect(15, y + 3, 98, 5);
  }
  context.fillStyle = 'rgba(18,18,15,0.18)';
  context.fillRect(6, 0, 7, 256);
  context.fillRect(115, 0, 7, 256);
}
const trackPrintTexture = new THREE.CanvasTexture(trackPrintCanvas);
trackPrintTexture.wrapS = trackPrintTexture.wrapT = THREE.RepeatWrapping;
trackPrintTexture.colorSpace = THREE.SRGBColorSpace;
const trackPrintGeometry = new THREE.PlaneGeometry(0.46, 0.92);
const trackPrintMesh = new THREE.InstancedMesh(
  trackPrintGeometry,
  new THREE.MeshBasicMaterial({ map: trackPrintTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  TRACK_PRINT_CAP
);
trackPrintMesh.count = 0;
trackPrintMesh.frustumCulled = false;
trackPrintMesh.renderOrder = 1.1;
trackPrintMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(trackPrintMesh);
let trackPrintCount = 0;
const trackPrintCreatedAt = new Float32Array(TRACK_PRINT_CAP);
const trackPrintMatrix = new THREE.Matrix4();
const trackPrintDummy = new THREE.Object3D();
function addTrackImprintPair(position: THREE.Vector3, heading: number) {
  if (trackPrintCount + 2 > TRACK_PRINT_CAP) return;
  const firstNewInstance = trackPrintCount;
  const sideCos = Math.cos(heading);
  const sideSin = Math.sin(heading);
  const createdAt = clock.elapsedTime;
  for (const side of [-1, 1]) {
    trackPrintDummy.position.set(position.x + sideCos * side * 1.45, -0.01, position.z - sideSin * side * 1.45);
    trackPrintDummy.rotation.set(-Math.PI / 2, heading, 0);
    const scale = 0.88 + Math.random() * 0.24;
    trackPrintDummy.scale.set(scale, scale, 1);
    trackPrintDummy.updateMatrix();
    trackPrintMesh.setMatrixAt(trackPrintCount, trackPrintDummy.matrix);
    trackPrintCreatedAt[trackPrintCount] = createdAt;
    trackPrintCount++;
  }
  trackPrintMesh.count = trackPrintCount;
  trackPrintMesh.instanceMatrix.clearUpdateRanges();
  trackPrintMesh.instanceMatrix.addUpdateRange(firstNewInstance * 16, 2 * 16);
  trackPrintMesh.instanceMatrix.needsUpdate = true;
}
function expireTrackImprints() {
  let i = 0;
  let firstModified = trackPrintCount;
  const oldCount = trackPrintCount;
  while (i < trackPrintCount) {
    if (clock.elapsedTime - trackPrintCreatedAt[i] < 4) { i++; continue; }
    const last = --trackPrintCount;
    if (i !== last) {
      trackPrintMesh.getMatrixAt(last, trackPrintMatrix);
      trackPrintMesh.setMatrixAt(i, trackPrintMatrix);
      trackPrintCreatedAt[i] = trackPrintCreatedAt[last];
      firstModified = Math.min(firstModified, i);
    }
  }
  if (trackPrintCount !== oldCount) {
    trackPrintMesh.count = trackPrintCount;
    if (firstModified < oldCount) {
      trackPrintMesh.instanceMatrix.clearUpdateRanges();
      trackPrintMesh.instanceMatrix.addUpdateRange(firstModified * 16, (oldCount - firstModified) * 16);
      trackPrintMesh.instanceMatrix.needsUpdate = true;
    }
  }
}
function clearBattlefieldMarks() {
  scorchCursor = 0;
  scorchMesh.count = 0;
  scorchMesh.instanceMatrix.needsUpdate = true;
  trackPrintCount = 0;
  trackPrintMesh.count = 0;
  trackPrintMesh.instanceMatrix.needsUpdate = true;
}

function emitDust(position: THREE.Vector3, yaw: number) {
  const bx = Math.sin(yaw), bz = Math.cos(yaw);
  const side = (Math.random() < 0.5 ? -1 : 1) * 1.45;
  const x = position.x + bx * 1.9 + Math.cos(yaw) * side;
  const z = position.z + bz * 1.9 - Math.sin(yaw) * side;
  smokeFx.spawn(x, 0.22, z,
    (Math.random() - 0.5) * 0.8 + bx * 0.9, 0.45 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8 + bz * 0.9,
    dustColor, 1, 0.34, 0.75, 2.4, 0.9 + Math.random() * 0.6, -0.05);
}

function createParticles(position: THREE.Vector3, color: number, amount = 7) {
  fxTmpColor.setHex(color);
  if (color === 0x55504a) {
    for (let i = 0; i < amount; i++) {
      smokeFx.spawn(position.x, position.y, position.z,
        (Math.random() - 0.5) * 3.2, 0.8 + Math.random() * 2.4, (Math.random() - 0.5) * 3.2,
        fxTmpColor, 1, 0.55, 1.1 + Math.random() * 0.9, 2.8, 1.1 + Math.random() * 1.2, -0.35);
    }
  } else if (color === 0xff5a16 || color === 0xffb52e || color === 0xffe7a0) {
    for (let i = 0; i < amount; i++) {
      fireFx.spawn(position.x, position.y, position.z,
        (Math.random() - 0.5) * 7, 0.5 + Math.random() * 5, (Math.random() - 0.5) * 7,
        fxTmpColor, 2.4, 0.9, 0.9 + Math.random() * 1.1, 1.4, 0.35 + Math.random() * 0.45, 0.5);
    }
  } else {
    // Faíscas brilhantes (estouram o bloom).
    for (let i = 0; i < amount; i++) {
      fireFx.spawn(position.x, position.y, position.z,
        (Math.random() - 0.5) * 8, Math.random() * 5.5, (Math.random() - 0.5) * 8,
        fxTmpColor, 3.2, 1, 0.16 + Math.random() * 0.12, -0.5, 0.3 + Math.random() * 0.45, 9);
    }
  }
}

function updateParticles(delta: number) {
  expireTrackImprints();
  smokeFx.update(delta);
  fireFx.update(delta);
  for (const flash of flashPool) {
    if (!flash.sprite.visible) continue;
    flash.life -= delta;
    if (flash.life <= 0) { flash.sprite.visible = false; continue; }
    const t = 1 - flash.life / flash.maxLife;
    const s = THREE.MathUtils.lerp(flash.size0, flash.size1, t);
    flash.sprite.scale.set(s, s, 1);
    (flash.sprite.material as THREE.SpriteMaterial).opacity = (1 - t) * (1 - t);
  }
  // Escala de pontos em pixels (tamanho do ponto em metros -> pixels).
  fxScaleUniform.value = renderer.getPixelRatio() * window.innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}

let audioContext: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

function playSound(frequency: number, duration: number, volume: number) {
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === 'suspended') void audioContext.resume();
    const now=audioContext.currentTime;
    const master=audioContext.createGain(); master.gain.setValueAtTime(Math.max(0.0001,volume),now); master.gain.exponentialRampToValueAtTime(0.0001,now+duration*1.45);
    const filter=audioContext.createBiquadFilter(); filter.type='lowpass'; filter.frequency.setValueAtTime(Math.max(260,frequency*7),now); filter.frequency.exponentialRampToValueAtTime(Math.max(100,frequency*1.8),now+duration);
    master.connect(filter); filter.connect(audioContext.destination);
    // Camada grave do disparo + corpo metálico curto.
    for(const [type,mult,detune,level] of [['sawtooth',1,0,0.72],['triangle',2.02,-7,0.25]] as const) {
      const osc=audioContext.createOscillator(), gain=audioContext.createGain(); osc.type=type; osc.frequency.setValueAtTime(frequency*mult,now); osc.frequency.exponentialRampToValueAtTime(Math.max(28,frequency*mult*0.24),now+duration); osc.detune.value=detune;
      gain.gain.setValueAtTime(level,now); gain.gain.exponentialRampToValueAtTime(0.0001,now+duration*1.15); osc.connect(gain); gain.connect(master); osc.start(now); osc.stop(now+duration*1.2);
    }
    // Ruído filtrado para o estalo/impacto do canhão (buffer criado uma única vez e reutilizado).
    if (!noiseBuffer) {
      const length = Math.max(1, Math.floor(audioContext.sampleRate * 0.22));
      noiseBuffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }
    const noise=audioContext.createBufferSource(), noiseGain=audioContext.createGain(), noiseFilter=audioContext.createBiquadFilter();
    noise.buffer=noiseBuffer; noiseFilter.type='bandpass'; noiseFilter.frequency.value=Math.max(180,frequency*3.2); noiseFilter.Q.value=0.7; noiseGain.gain.setValueAtTime(volume*0.42,now); noiseGain.gain.exponentialRampToValueAtTime(0.0001,now+Math.min(0.2,duration));
    noise.connect(noiseFilter); noiseFilter.connect(noiseGain); noiseGain.connect(audioContext.destination); noise.start(now); noise.stop(now+Math.min(0.2,duration)+0.03);
  } catch { /* áudio opcional; não interrompe a partida */ }
}

// =====================================================
// PROJÉTEIS
// =====================================================

type Projectile = {
  mesh: THREE.Mesh;
  direction: THREE.Vector3;
  velocity: THREE.Vector3;
  gravity: number;
  splashRadius: number;
  splashScale: number;
  weapon: 'cannon' | 'rapid';
  owner: 'player' | 'enemy';
  team: Team;
  shooter: Enemy | null;
  damage: number;
  alive: boolean;
};

const projectiles: Projectile[] = [];

function clearProjectiles() {
  for (const projectile of projectiles) scene.remove(projectile.mesh);
  projectiles.length = 0;
}

const projectileGeometry = new THREE.SphereGeometry(0.13, 20, 14);
const cannonShellGeometry = new THREE.CylinderGeometry(0.075, 0.115, 0.40, 14, 1);
cannonShellGeometry.rotateX(Math.PI / 2);
const playerProjectileMaterial = new THREE.MeshLambertMaterial({ color:0xffe58a, emissive:0xff8a18, emissiveIntensity:2.8 });
const enemyProjectileMaterial = new THREE.MeshLambertMaterial({ color:0xff8585, emissive:0xff1616, emissiveIntensity:2.6 });
const playerRapidProjectileMaterial = new THREE.MeshLambertMaterial({ color: 0xffedbd, emissive: 0xffa329, emissiveIntensity: 1.6 });
const enemyRapidProjectileMaterial = new THREE.MeshLambertMaterial({ color: 0xffb7ad, emissive: 0xff3026, emissiveIntensity: 1.7 });
const projectileCoreGeometry = new THREE.SphereGeometry(0.075,14,10);
const projectileCoreMaterial = new THREE.MeshBasicMaterial({color:0xffffff});
const projectileTrailGeometry = new THREE.ConeGeometry(0.10,0.72,12,1,true);
const projectileGlowCanvas = document.createElement('canvas');
projectileGlowCanvas.width = projectileGlowCanvas.height = 64;
const projectileGlowContext = projectileGlowCanvas.getContext('2d')!;
const projectileGlowGradient = projectileGlowContext.createRadialGradient(32,32,2,32,32,32);
projectileGlowGradient.addColorStop(0,'rgba(255,255,255,1)');
projectileGlowGradient.addColorStop(0.18,'rgba(255,210,120,.85)');
projectileGlowGradient.addColorStop(0.48,'rgba(255,110,35,.28)');
projectileGlowGradient.addColorStop(1,'rgba(255,70,20,0)');
projectileGlowContext.fillStyle = projectileGlowGradient; projectileGlowContext.fillRect(0,0,64,64);
const projectileGlowTexture = new THREE.CanvasTexture(projectileGlowCanvas);
const playerProjectileGlowMaterial = new THREE.SpriteMaterial({ map: projectileGlowTexture, color: 0xffb45a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
const enemyProjectileGlowMaterial = new THREE.SpriteMaterial({ map: projectileGlowTexture, color: 0xff4545, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
playerProjectileGlowMaterial.color.multiplyScalar(2.4);
enemyProjectileGlowMaterial.color.multiplyScalar(2.4);
const projectileForward = new THREE.Vector3(0, 0, 1);
const projectileImpactDirection = new THREE.Vector3();

let playerFireCooldown = 0;

function createProjectile(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  owner: 'player' | 'enemy',
  damage = 1,
  team: Team = playerTeam,
  shooter: Enemy | null = null,
  weapon: 'cannon' | 'rapid' = 'cannon',
  tankClass: TankClass = 'medium'
) {
  const projectileMaterial = weapon === 'rapid'
    ? (owner === 'player' ? playerRapidProjectileMaterial : enemyRapidProjectileMaterial)
    : owner === 'player' ? playerProjectileMaterial : enemyProjectileMaterial;
  const mesh = new THREE.Mesh(
    weapon === 'rapid' ? projectileGeometry : cannonShellGeometry,
    projectileMaterial
  );

  const bodyScale = weapon === 'rapid' ? 0.62 : tankClass === 'artillery' ? 1.18 : tankClass === 'heavy' ? 1.08 : 1;
  mesh.scale.setScalar(bodyScale);
  mesh.position.copy(origin);
  const core = new THREE.Mesh(projectileCoreGeometry, projectileCoreMaterial); core.visible = weapon === 'rapid'; mesh.add(core);
  const trail = new THREE.Mesh(projectileTrailGeometry, projectileMaterial);
  trail.rotation.x = Math.PI / 2;
  trail.position.z = weapon === 'rapid' ? -0.20 : -0.29;
  trail.scale.setScalar(weapon === 'rapid' ? 0.7 : 1);
  mesh.add(trail);
  const glow = new THREE.Sprite(owner === 'player' ? playerProjectileGlowMaterial : enemyProjectileGlowMaterial);
  const glowSize = weapon === 'rapid' ? 0.62 : tankClass === 'artillery' ? 1.16 : 0.92;
  glow.scale.set(glowSize, glowSize, 1); glow.position.z = 0.03; mesh.add(glow);
  mesh.quaternion.setFromUnitVectors(projectileForward,direction.clone().normalize());
  scene.add(mesh);

  // A munição leva o perfil de quem disparou; a arma atualmente selecionada
  // pelo jogador não pode alterar tiros que já estão no ar nem tiros dos bots.
  const speed = weapon === 'rapid'
    ? (owner === 'player' ? 30 : 31)
    : tankClass === 'artillery' ? 42 : tankClass === 'heavy' ? 30 : 34;
  const normalizedDirection = direction.clone().normalize();
  projectiles.push({
    mesh,
    direction: normalizedDirection,
    velocity: normalizedDirection.clone().multiplyScalar(speed),
    gravity: weapon === 'rapid' ? 0.12 : tankClass === 'artillery' ? 1.25 : 1.05,
    splashRadius: weapon === 'cannon' && tankClass === 'artillery' ? 3.6 : 0,
    splashScale: 0.72,
    weapon,
    owner,
    team,
    shooter,
    damage,
    alive: true
  });
}

function getTurretDirection(
  chassis: THREE.Group,
  turret: THREE.Group
) {
  const heading = chassis.rotation.y + turret.rotation.y;

  return new THREE.Vector3(
    -Math.sin(heading),
    0,
    -Math.cos(heading)
  ).normalize();
}

function playerShoot() {
  if (!playerAlive || playerFireCooldown > 0 || garageOpen || matchEnded) return;

  const classStats = TANK_CLASSES[selectedTankClass];
  const damage = (selectedWeapon === 'cannon' ? 2 : 1) * classStats.damage * (powerDamageTimer > 0 ? 2 : 1);
  playerFireCooldown = (selectedWeapon === 'cannon' ? 0.48 : 0.12) * classStats.fireRate;
  playerBarrelRecoil = Math.max(playerBarrelRecoil, selectedWeapon === 'cannon' ? 0.24 : 0.09);

  const direction = getTurretDirection(player, playerTurret);
  const origin = (playerParts.model?.muzzle ?? DEFAULT_MUZZLE).clone();
  playerTurret.localToWorld(origin);

  createProjectile(origin, direction, 'player', damage * playerDamageMultiplier, playerTeam, null, selectedWeapon, selectedTankClass);
  createParticles(origin, 0xffd65a, selectedWeapon === 'cannon' ? 5 : 2);
  spawnFlash(origin, 0.5, selectedWeapon === 'cannon' ? 2.6 : 1.4, 0.09, 0xffc060);
  if (selectedWeapon === 'cannon') { createParticles(origin, 0x55504a, 2); cameraShake = Math.max(cameraShake, 0.07); }
  playSound(selectedWeapon === 'cannon' ? 110 : 180, 0.13, 0.07);
}

function enemyShoot(enemy: Enemy) {
  if (!enemy.alive) return;
  enemy.barrelRecoil = 0.2;

  const direction = getTurretDirection(
    enemy.parts.root,
    enemy.parts.turret
  );

  const origin = (enemy.parts.model?.muzzle ?? DEFAULT_MUZZLE).clone();
  enemy.parts.turret.localToWorld(origin);

  const enemyWeapon = enemy.tankClass === 'light' ? 'rapid' : 'cannon';
  createProjectile(origin, direction, 'enemy', TANK_CLASSES[enemy.tankClass].damage > 1.4 ? 16 : TANK_CLASSES[enemy.tankClass].damage > 1.1 ? 13 : 10, enemy.team, enemy, enemyWeapon, enemy.tankClass);
  createParticles(origin, 0xff5555, 3);
  spawnFlash(origin, 0.5, 2.2, 0.09, 0xff6a4a);
  playSound(75, 0.15, 0.035);
}

// =====================================================
// COLISÃO DE PROJÉTEIS COM RETÂNGULOS
// =====================================================

function segmentBoxCollision(
  start: THREE.Vector3,
  movement: THREE.Vector3,
  obstacle: Obstacle
): number | null {
  if (obstacle.style && obstacle.style !== mapStyleName) return null;
  const padding = 0.18;

  const minX = obstacle.center.x - obstacle.halfX - padding;
  const maxX = obstacle.center.x + obstacle.halfX + padding;
  const minZ = obstacle.center.z - obstacle.halfZ - padding;
  const maxZ = obstacle.center.z + obstacle.halfZ + padding;

  let tMin = 0;
  let tMax = 1;

  if (Math.abs(movement.x) < 0.000001) {
    if (start.x < minX || start.x > maxX) return null;
  } else {
    const tx1 = (minX - start.x) / movement.x;
    const tx2 = (maxX - start.x) / movement.x;

    tMin = Math.max(tMin, Math.min(tx1, tx2));
    tMax = Math.min(tMax, Math.max(tx1, tx2));
  }

  if (Math.abs(movement.z) < 0.000001) {
    if (start.z < minZ || start.z > maxZ) return null;
  } else {
    const tz1 = (minZ - start.z) / movement.z;
    const tz2 = (maxZ - start.z) / movement.z;

    tMin = Math.max(tMin, Math.min(tz1, tz2));
    tMax = Math.min(tMax, Math.max(tz1, tz2));
  }

  if (tMin > tMax || tMax < 0 || tMin > 1) return null;

  const impactY = start.y + movement.y * tMin;

  if (impactY > obstacle.height + 0.2 || impactY < 0) {
    return null;
  }

  return Math.max(0, tMin);
}

const segmentToCenter = new THREE.Vector3();
const segmentClosest = new THREE.Vector3();
const segmentDistanceResult = { distance: 0, t: 0 };
function segmentDistance(
  start: THREE.Vector3,
  movement: THREE.Vector3,
  center: THREE.Vector3
) {
  const lengthSquared = movement.lengthSq();
  const toCenter = segmentToCenter.subVectors(center, start);

  const t = lengthSquared > 0
    ? THREE.MathUtils.clamp(
        toCenter.dot(movement) / lengthSquared, 0, 1
      )
    : 0;

  segmentClosest.copy(start).addScaledVector(movement, t);
  segmentDistanceResult.distance = segmentClosest.distanceTo(center);
  segmentDistanceResult.t = t;
  return segmentDistanceResult;
}

// =====================================================
// DANO
// =====================================================

function armorDamageMultiplier(chassis: THREE.Object3D, baseArmor: number, incomingDirection?: THREE.Vector3) {
  let armor = baseArmor;
  if (incomingDirection) {
    const horizontalLength = Math.hypot(incomingDirection.x, incomingDirection.z);
    if (horizontalLength > 0.0001) {
      const attackerX = -incomingDirection.x / horizontalLength;
      const attackerZ = -incomingDirection.z / horizontalLength;
      const forwardX = -Math.sin(chassis.rotation.y);
      const forwardZ = -Math.cos(chassis.rotation.y);
      const frontDot = attackerX * forwardX + attackerZ * forwardZ;
      if (frontDot > 0.45) armor += 0.18;
      else if (frontDot < -0.45) armor -= 0.15;
    }
  }
  return 1 - THREE.MathUtils.clamp(armor, -0.2, 0.65);
}

function damagePlayer(amount: number, ignoreProtection = false, incomingDirection?: THREE.Vector3) {
  if (!playerAlive || (!ignoreProtection && invulnerability > 0)) return;

  const armorMultiplier = ignoreProtection ? 1 : armorDamageMultiplier(player, playerArmor, incomingDirection);
  playerHealth = Math.max(0, playerHealth - amount * armorMultiplier * (powerArmorTimer > 0 ? 0.5 : 1));

  showDamageFlash();
  cameraShake = Math.max(cameraShake, 0.3);
  playSound(55, 0.2, 0.08);
  updateHUD();

  if (playerHealth <= 0) {
    playerAlive = false;
    playerLinearSpeed = 0;
    player.position.y = 0;
    player.rotation.x = player.rotation.z = 0;
    respawnTimer = 4;
    player.visible = false;
    syncTankGearToWorld(playerParts);
    if (playerFlagCarrying) dropFlag(oppositeTeam(playerTeam));
    firing = false;
    mouseFiring = false;
    document.exitPointerLock?.();
    respawnMessage.textContent = 'TANQUE DESTRUÍDO — RETORNO EM 4 SEGUNDOS';
  }
}

function damageEnemy(enemy: Enemy, amount = 1, playerKill = false, incomingDirection?: THREE.Vector3) {
  if (!enemy.alive) return;

  enemy.health -= amount * armorDamageMultiplier(enemy.parts.root, TANK_CLASSES[enemy.tankClass].armor, incomingDirection);
  showHitMarker();

  enemy.healthBar.update(enemy.health, enemy.maxHealth);
  if (enemy.health <= 0) {
    enemy.alive = false;
    enemy.respawnTimer = 5;
    if (flags[oppositeTeam(enemy.team)]?.carrier === enemy) dropFlag(oppositeTeam(enemy.team));
    if (playerKill) { playerKills++; playerBattleKills++; updateRank(); }
    if (gameMode !== 'survival') addBattleFund(10, playerKill);

    enemy.parts.root.visible = false;
    syncTankGearToWorld(enemy.parts);
    playSound(45, 0.5, 0.12);
    updateHUD();
  }

  updateHUD();
}

// =====================================================
// ATUALIZAÇÃO DOS PROJÉTEIS
// =====================================================

const projectileStart = new THREE.Vector3();
const projectileMovement = new THREE.Vector3();
const projectileEnd = new THREE.Vector3();
const projectileTargetCenter = new THREE.Vector3();
const projectileImpact = new THREE.Vector3();
function updateProjectiles(delta: number) {
  for (const projectile of projectiles) {
    if (!projectile.alive) continue;

    const start = projectileStart.copy(projectile.mesh.position);
    const movement = projectileMovement.copy(projectile.velocity).multiplyScalar(delta);
    movement.y -= 0.5 * projectile.gravity * delta * delta;
    projectile.velocity.y -= projectile.gravity * delta;
    projectile.direction.copy(projectile.velocity).normalize();
    projectile.mesh.quaternion.setFromUnitVectors(projectileForward, projectile.direction);

    const end = projectileEnd.copy(start).add(movement);

    let nearestT = start.y >= 0.14 && end.y <= 0.14
      ? THREE.MathUtils.clamp((start.y - 0.14) / Math.max(0.0001, start.y - end.y), 0, 1)
      : Infinity;
    let hitEnemy: Enemy | null = null;
    let hitPlayer = false;

    for (const bot of enemies) {
      if (!bot.alive || bot.team === projectile.team) continue;
      const center = projectileTargetCenter.copy(bot.parts.root.position);
      center.y = 0.9;
      const result = segmentDistance(start, movement, center);
      if (result.distance < 1.7 && result.t < nearestT) {
        nearestT = result.t;
        hitEnemy = bot;
        hitPlayer = false;
      }
    }

    if (playerAlive && playerTeam !== projectile.team) {
      const center = projectileTargetCenter.copy(player.position);
      center.y = 0.9;
      const result = segmentDistance(start, movement, center);
      if (result.distance < 1.7 && result.t < nearestT) {
        nearestT = result.t;
        hitEnemy = null;
        hitPlayer = true;
      }
    }

    for (const obstacle of obstacles) {
      const t = segmentBoxCollision(start, movement, obstacle);

      if (t !== null && t < nearestT) {
        nearestT = t;
        hitEnemy = null;
        hitPlayer = false;
      }
    }

    if (hitEnemy || hitPlayer || nearestT < Infinity) {
      const impact = projectileImpact.copy(start).addScaledVector(movement, nearestT);

      projectile.alive = false;
      scene.remove(projectile.mesh);

      // Tanques recebem dano sem clarões/faíscas; o estado é mostrado pelas barras de vida.
      if (!hitEnemy && !hitPlayer) {
        createParticles(impact, projectile.weapon === 'rapid' ? 0x55504a : 0xffc04a, 3);
        spawnFlash(impact, 0.35, 0.9, 0.08, 0xffc27a, 1.4);
      }
      if (!hitEnemy && !hitPlayer && impact.y < 0.65) {
        const scorchRadius = projectile.weapon === 'rapid' ? 0.32 : projectile.splashRadius > 0 ? 1.35 : 0.82;
        addScorch(impact, scorchRadius);
      }

      const baseDamage = projectile.owner === 'player' ? projectile.damage : projectile.damage / 10;
      if (projectile.splashRadius > 0) {
        for (const bot of enemies) {
          if (!bot.alive || bot.team === projectile.team) continue;
          const distance = bot.parts.root.position.distanceTo(impact);
          if (distance > projectile.splashRadius) continue;
          const falloff = 1 - (distance / projectile.splashRadius) * (1 - projectile.splashScale);
          projectileImpactDirection.subVectors(bot.parts.root.position, impact).normalize();
          damageEnemy(bot, baseDamage * falloff, projectile.owner === 'player', projectileImpactDirection);
        }
        if (playerAlive && playerTeam !== projectile.team) {
          const distance = player.position.distanceTo(impact);
          if (distance <= projectile.splashRadius) {
            const falloff = 1 - (distance / projectile.splashRadius) * (1 - projectile.splashScale);
            projectileImpactDirection.subVectors(player.position, impact).normalize();
            damagePlayer(baseDamage * falloff, false, projectileImpactDirection);
          }
        }
      } else {
        if (hitEnemy) damageEnemy(hitEnemy, baseDamage, projectile.owner === 'player', projectile.direction);
        if (hitPlayer) damagePlayer(baseDamage, false, projectile.direction);
      }


      continue;
    }

    projectile.mesh.position.copy(end);

    if (Math.abs(end.x) > 65 || Math.abs(end.z) > 65) {
      projectile.alive = false;
      scene.remove(projectile.mesh);
    }
  }

  for (let i = projectiles.length - 1; i >= 0; i--) {
    if (!projectiles[i].alive) {
      projectiles.splice(i, 1);
    }
  }
}

// =====================================================
// NAVEGAÇÃO DOS INIMIGOS
// =====================================================

function angleDifference(from: number, to: number) {
  return Math.atan2(
    Math.sin(to - from),
    Math.cos(to - from)
  );
}

function rotateTowards(
  object: THREE.Object3D,
  targetAngle: number,
  speed: number,
  delta: number
) {
  const difference = angleDifference(
    object.rotation.y,
    targetAngle
  );

  object.rotation.y += THREE.MathUtils.clamp(
    difference,
    -speed * delta,
    speed * delta
  );
}

// A navegação avalia vários metros à frente, em vez de aceitar
// simplesmente a primeira direção que não colide.
function canEnemyMoveTo(position: THREE.Vector3, self: Enemy): boolean {
  if (!canMoveTo(position)) return false;

  // Colisão física entre tanques: só é ignorada durante os 3s de nascimento.
  if (playerAlive && self.spawnGrace <= 0 && playerSpawnGrace <= 0 &&
      position.distanceToSquared(player.position) < 9.0) return false;

  for (const other of enemies) {
    if (other === self || !other.alive || other.spawnGrace > 0 || self.spawnGrace > 0) continue;
    if (position.distanceToSquared(other.parts.root.position) < 9.9225) return false;
  }

  return true;
}

function canPlayerMoveTo(position: THREE.Vector3): boolean {
  if (!canMoveTo(position)) return false;
  if (playerSpawnGrace > 0) return true;
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.spawnGrace > 0) continue;
    if (position.distanceToSquared(enemy.parts.root.position) < 9.0) return false;
  }
  return true;
}

const pathProbe = new THREE.Vector3();
const candidatePathOffsets = [
  0, 0.32, -0.32, 0.68, -0.68, 1.05, -1.05,
  1.42, -1.42, 1.82, -1.82, 2.25, -2.25, 2.65, -2.65, Math.PI
];

function findEnemyPath(
  enemy: Enemy,
  destination: THREE.Vector3
): number {
  const position = enemy.parts.root.position;

  const desiredAngle = Math.atan2(
    -(destination.x - position.x),
    -(destination.z - position.z)
  );

  let bestAngle = desiredAngle;
  let bestScore = -Infinity;
  const startingDistance = Math.hypot(destination.x - position.x, destination.z - position.z);

  for (const offset of candidatePathOffsets) {
    const angle = desiredAngle + offset;
    const directionX = -Math.sin(angle);
    const directionZ = -Math.cos(angle);

    let clearDistance = 0;
    let crowdPenalty = 0;
    let simulatedX = position.x;
    let simulatedZ = position.z;

    for (let step = 0; step < 7; step++) {
      simulatedX += directionX * 1.15;
      simulatedZ += directionZ * 1.15;
      pathProbe.set(simulatedX, position.y, simulatedZ);
      if (!canEnemyMoveTo(pathProbe, enemy)) break;

      clearDistance += 1.15;

      for (const other of enemies) {
        if (other === enemy || !other.alive) continue;

        const otherPosition = other.parts.root.position;
        const gap = Math.hypot(simulatedX - otherPosition.x, simulatedZ - otherPosition.z);
        if (gap < 4.5) crowdPenalty += (4.5 - gap) * 0.12;
      }
    }

    if (clearDistance < 1.1) continue;

    const remainingDistance = Math.hypot(destination.x - simulatedX, destination.z - simulatedZ);
    const progress = startingDistance - remainingDistance;
    const turnCost = Math.abs(offset) * 0.42;
    const sidePreference = offset * enemy.strafe * 0.035;

    const score =
      clearDistance * 0.9 +
      progress * 1.55 -
      turnCost -
      crowdPenalty +
      sidePreference;

    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  return bestAngle;
}

// Quando um bot fica preso, procura a direção com o maior corredor livre.
// Não aumenta a velocidade: apenas escolhe uma rota de escape diferente.
const recoveryPathOffsets = [
  0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2,
  Math.PI * 0.75, -Math.PI * 0.75, Math.PI
];

function findRecoveryAngle(enemy: Enemy): number {
  const position = enemy.parts.root.position;

  let bestAngle = enemy.parts.root.rotation.y + Math.PI / 2;
  let bestScore = -Infinity;

  for (const offset of recoveryPathOffsets) {
    const angle = enemy.parts.root.rotation.y + offset;
    const directionX = -Math.sin(angle);
    const directionZ = -Math.cos(angle);
    let probeX = position.x;
    let probeZ = position.z;
    let openDistance = 0;
    let crowdPenalty = 0;

    for (let step = 0; step < 8; step++) {
      probeX += directionX * 0.9;
      probeZ += directionZ * 0.9;
      pathProbe.set(probeX, position.y, probeZ);
      if (!canMoveTo(pathProbe)) break;

      openDistance += 0.9;

      for (const other of enemies) {
        if (other === enemy || !other.alive) continue;

        const otherPosition = other.parts.root.position;
        const gap = Math.hypot(probeX - otherPosition.x, probeZ - otherPosition.z);
        if (gap < 3.8) crowdPenalty += (3.8 - gap) * 0.25;
      }
    }

    const score = openDistance - crowdPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  return bestAngle;
}

// Fuga calcula uma rota própria e valida cada trecho contra paredes e tanques.
function findEnemyEscapePath(enemy: Enemy, threat: THREE.Vector3): number {
  const position = enemy.parts.root.position;
  const awayAngle = Math.atan2(-(position.x - threat.x), -(position.z - threat.z));
  const offsets = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.45, -1.45, 1.9, -1.9, 2.45, -2.45, Math.PI];
  let bestAngle = enemy.recoveryAngle;
  let bestScore = -Infinity;
  for (const offset of offsets) {
    const angle = awayAngle + offset;
    const directionX = -Math.sin(angle);
    const directionZ = -Math.cos(angle);
    let probeX = position.x;
    let probeZ = position.z;
    let openDistance = 0;
    let blocked = false;
    for (let step = 0; step < 8; step++) {
      probeX += directionX * 0.8;
      probeZ += directionZ * 0.8;
      pathProbe.set(probeX, position.y, probeZ);
      if (!canEnemyMoveTo(pathProbe, enemy)) { blocked = true; break; }
      openDistance += 0.8;
    }
    if (openDistance < 0.8) continue;
    const gainedDistance = Math.hypot(probeX - threat.x, probeZ - threat.z) - Math.hypot(position.x - threat.x, position.z - threat.z);
    const score = openDistance * 1.15 + gainedDistance * 2.1 - Math.abs(offset) * 0.12 - (blocked ? 0.2 : 0);
    if (score > bestScore) { bestScore = score; bestAngle = angle; }
  }
  return bestAngle;
}

const sightStart = new THREE.Vector3();
const sightMovement = new THREE.Vector3();
function hasClearShot(from: THREE.Vector3, to: THREE.Vector3): boolean {
  sightStart.set(from.x, 1.15, from.z);
  sightMovement.set(to.x - from.x, 0, to.z - from.z);

  for (const obstacle of obstacles) {
    if (segmentBoxCollision(sightStart, sightMovement, obstacle) !== null) {
      return false;
    }
  }

  return true;
}

// Verifica se o tanque consegue observar o jogador sem uma construção no caminho.
function canSeePlayer(from: THREE.Vector3, to: THREE.Vector3): boolean {
  return hasClearShot(from, to);
}

// Procura projéteis próximos e escolhe uma esquiva lateral curta.
function findIncomingProjectile(enemy: Enemy): number | null {
  const position = enemy.parts.root.position;
  let closestDistance = 4.2;
  let dodgeAngle: number | null = null;

  for (const projectile of projectiles) {
    if (!projectile.alive || projectile.team === enemy.team) continue;

    const projectilePosition = projectile.mesh.position;
    const projectileDirection = projectile.direction;
    const toTankX = position.x - projectilePosition.x;
    const toTankZ = position.z - projectilePosition.z;
    const along = toTankX * projectileDirection.x + toTankZ * projectileDirection.z;
    if (along < -0.5 || along > 5.5) continue;

    const closestAlong = Math.max(0, along);
    const offsetX = toTankX - projectileDirection.x * closestAlong;
    const offsetZ = toTankZ - projectileDirection.z * closestAlong;
    const distance = Math.hypot(offsetX, offsetZ);

    if (distance < closestDistance) {
      closestDistance = distance;
      const sideX = -projectileDirection.z;
      const sideZ = projectileDirection.x;
      const awayX = distance > 0.001 ? offsetX / distance : sideX;
      const awayZ = distance > 0.001 ? offsetZ / distance : sideZ;
      const sign = Math.sign(awayX * sideX + awayZ * sideZ) || (enemy.strafe > 0 ? 1 : -1);
      const dodgeX = -projectileDirection.x * 0.35 + sideX * sign;
      const dodgeZ = -projectileDirection.z * 0.35 + sideZ * sign;
      dodgeAngle = Math.atan2(-dodgeX, -dodgeZ);
    }
  }

  return dodgeAngle;
}

const previousPlayerPosition = player.position.clone();
const enemyPlayerVelocity = new THREE.Vector3();
const enemySearchTarget = new THREE.Vector3();
const enemyToTarget = new THREE.Vector3();
const enemyAimPosition = new THREE.Vector3();
const enemyMoveDirection = new THREE.Vector3();
const enemyNextPosition = new THREE.Vector3();
const enemySeparation = new THREE.Vector3();
const enemyAway = new THREE.Vector3();

function updateEnemies(delta: number) {
  if (matchEnded) return;
  enemyPlayerVelocity.subVectors(player.position, previousPlayerPosition).multiplyScalar(delta > 0 ? 1 / delta : 0);
  for (const enemy of enemies) {
    if (!enemy.alive) {
      if (gameMode !== 'survival' && !matchEnded) {
        enemy.respawnTimer = Math.max(0, enemy.respawnTimer - delta);
        if (enemy.respawnTimer <= 0) {
          if (!respawnEnemy(enemy)) enemy.respawnTimer = 0.5;
        }
      }
      continue;
    }
    const tank = enemy.parts.root;
    enemy.spawnGrace = Math.max(0, enemy.spawnGrace - delta);
    tank.visible = true;

    // Alvo válido é sempre de outra equipe: bots reconhecem aliados e não causam fogo amigo.
    let target: THREE.Object3D | null = null;
    let bestDistance = Infinity;
    const carriedFlag = gameMode === 'ctf' ? flags[oppositeTeam(enemy.team)] : null;
    const returningFlag = !!carriedFlag && carriedFlag.carrier === enemy;
    if (!returningFlag && playerAlive && playerTeam !== enemy.team) {
      const d = tank.position.distanceTo(player.position);
      if (d < bestDistance) { bestDistance = d; target = player; }
    }
    for (const other of enemies) {
      if (returningFlag || other === enemy || !other.alive || other.team === enemy.team) continue;
      const d = tank.position.distanceTo(other.parts.root.position);
      if (d < bestDistance) { bestDistance = d; target = other.parts.root; }
    }

    const seesTarget = !!target && bestDistance < (enemy.tankClass === 'artillery' ? 56 : 48) && canSeePlayer(tank.position, target.position);
    enemy.memoryTimer = Math.max(0, enemy.memoryTimer - delta);
    if (seesTarget && target) { enemy.lastSeenPosition.copy(target.position); enemy.memoryTimer = 4.5; }

    let targetPosition: THREE.Vector3;
    if (returningFlag) {
      targetPosition = teamBasePosition(enemy.team);
    } else if (gameMode === 'ctf' && !seesTarget) {
      const ownFlag = flags[enemy.team];
      const enemyFlag = flags[oppositeTeam(enemy.team)];
      if (ownFlag.carrier === 'player' && playerAlive) targetPosition = player.position;
      else if (ownFlag.carrier && ownFlag.carrier !== 'player' && ownFlag.carrier !== enemy && ownFlag.carrier.team !== enemy.team) targetPosition = ownFlag.carrier.parts.root.position;
      else if (ownFlag.dropped) targetPosition = ownFlag.mesh.position;
      else if (enemyFlag.carrier && enemyFlag.carrier !== enemy && enemyFlag.carrier !== 'player' && enemyFlag.carrier.team === enemy.team) targetPosition = enemyFlag.carrier.parts.root.position;
      else if (!enemyFlag.carrier) targetPosition = enemyFlag.mesh.position;
      else if (target) targetPosition = target.position;
      else targetPosition = teamBasePosition(oppositeTeam(enemy.team));
    } else if (target) {
      targetPosition = target.position;
    } else if (enemy.memoryTimer > 0) {
      targetPosition = enemy.lastSeenPosition;
    } else {
      // Busca o setor central para encontrar adversários, sem permanecer parado na base.
      const enemyBase = teamBasePosition(oppositeTeam(enemy.team));
      targetPosition = enemySearchTarget.set(
        THREE.MathUtils.lerp(tank.position.x, enemyBase.x, 0.08), 0,
        THREE.MathUtils.lerp(tank.position.z, enemyBase.z, 0.08)
      );
    }
    enemyToTarget.subVectors(targetPosition, tank.position);
    const distance = enemyToTarget.length();
    enemyAimPosition.copy(targetPosition);
    if (target === player) enemyAimPosition.addScaledVector(enemyPlayerVelocity, THREE.MathUtils.clamp(distance / 23, 0, 0.75));
    enemyAimPosition.sub(tank.position);
    const desiredAim = Math.atan2(-enemyAimPosition.x, -enemyAimPosition.z);
    const currentHeading = tank.rotation.y + enemy.parts.turret.rotation.y;
    const aimDiff = angleDifference(currentHeading, desiredAim);
    const turretRate = 1.2 * TANK_CLASSES[enemy.tankClass].turnRate;
    enemy.parts.turret.rotation.y += THREE.MathUtils.clamp(aimDiff, -turretRate * delta, turretRate * delta);

    const moved = tank.position.distanceTo(enemy.lastPosition);
    enemy.stuckTimer = moved < 0.018 ? enemy.stuckTimer + delta : Math.max(0, enemy.stuckTimer - delta * 2.5);
    if (moved > 0.03 && Math.random() < 0.22) emitDust(tank.position, tank.rotation.y);
    enemy.lastPosition.copy(tank.position);
    if (enemy.stuckTimer > 1.15 && enemy.recoveryTimer <= 0) {
      enemy.recoveryAngle = findRecoveryAngle(enemy); enemy.recoveryTimer = 1.1; enemy.stuckTimer = 0; enemy.navTimer = 0.2;
    }
    enemy.navTimer -= delta;
    enemy.recoveryTimer = Math.max(0, enemy.recoveryTimer - delta);
    enemy.flankTimer -= delta;
    enemy.dodgeTimer = Math.max(0, enemy.dodgeTimer - delta);
    const incoming = findIncomingProjectile(enemy);
    if (incoming !== null && enemy.dodgeTimer <= 0) { enemy.dodgeAngle = incoming; enemy.dodgeTimer = 0.65; }
    if (enemy.navTimer <= 0) { enemy.navAngle = findEnemyPath(enemy, targetPosition); enemy.navTimer = 0.3 + Math.random() * 0.2; }

    const stats = TANK_CLASSES[enemy.tankClass];
    let moveAngle = enemy.navAngle;
    let moveAmount = 3.6 * stats.speed * delta;
    if (target && seesTarget) {
      let retreatSpeed = 0;
      let orbitRange = 0;
      let orbitSpeed = 0;
      let approachSpeed = 0;
      if (enemy.health <= 1 && distance < 18) retreatSpeed = 3.0;
      else if (enemy.tankClass === 'artillery') {
        if (distance < 23) retreatSpeed = 3.0;
        else if (distance > 44) approachSpeed = 2.6;
        else { orbitRange = 34; orbitSpeed = distance < 29 ? 2.2 : 3.0; }
      } else if (enemy.tankClass === 'heavy') {
        if (distance < 6.5) retreatSpeed = 2.5;
        else if (distance < 14) { orbitRange = 11; orbitSpeed = 1.8; }
        else if (distance < 25) approachSpeed = 3.7;
        else if (distance < 35) { orbitRange = 22; orbitSpeed = 2.6; }
        else approachSpeed = 3.2;
      } else if (enemy.tankClass === 'light') {
        if (distance < 12) retreatSpeed = 3.1;
        else if (distance < 29) { orbitRange = 21; orbitSpeed = 3.5; }
        else approachSpeed = 3.8;
      } else {
        if (distance < 8) retreatSpeed = 2.5;
        else if (distance < 18) { orbitRange = 13; orbitSpeed = 2.3; }
        else if (distance < 28) { orbitRange = 22; orbitSpeed = 3.0; }
        else approachSpeed = 3.4;
      }
      if (retreatSpeed > 0) {
        moveAngle = findEnemyEscapePath(enemy, target.position);
        moveAmount = retreatSpeed * stats.speed * delta;
      } else if (orbitRange > 0) {
        if (enemy.flankTimer <= 0) {
          enemy.strafe *= -1;
          enemy.flankTimer = 2.2 + Math.random() * 1.8;
        }
        moveAngle = desiredAim + enemy.strafe * Math.PI / 2;
        moveAmount = orbitSpeed * stats.speed * delta;
        // Reposition gradually while circling so the bot holds a useful firing range.
        const rangeError = distance - orbitRange;
        moveAngle -= enemy.strafe * THREE.MathUtils.clamp(rangeError * 0.055, -0.45, 0.45);
      } else if (approachSpeed > 0) {
        moveAngle = desiredAim;
        moveAmount = approachSpeed * stats.speed * delta;
      }
    }
    if (enemy.dodgeTimer > 0) { moveAngle = enemy.dodgeAngle; moveAmount = Math.max(moveAmount, 4.2 * stats.speed * delta); }
    if (enemy.recoveryTimer > 0 && enemy.dodgeTimer <= 0) moveAngle = enemy.recoveryAngle;
    const priorHeading = tank.rotation.y;
    rotateTowards(tank, moveAngle, 2.2, delta);
    enemyMoveDirection.set(-Math.sin(moveAngle), 0, -Math.cos(moveAngle));
    const next = enemyNextPosition.copy(tank.position).addScaledVector(enemyMoveDirection, moveAmount);
    const separation = enemySeparation.set(0, 0, 0);
    for (const other of enemies) {
      if (other === enemy || !other.alive) continue;
      const away = enemyAway.subVectors(tank.position, other.parts.root.position); away.y = 0;
      const d = away.length();
      if (d > 0.001 && d < 4.2) separation.add(away.normalize().multiplyScalar((4.2 - d) * 1.1 * delta));
    }
    next.add(separation);
    if (canEnemyMoveTo(next, enemy)) tank.position.copy(next);
    else { enemy.navTimer = 0; enemy.recoveryAngle = findRecoveryAngle(enemy); enemy.recoveryTimer = Math.max(enemy.recoveryTimer, 0.4); }

    const traveledThisFrame = Math.hypot(tank.position.x - enemy.lastPosition.x, tank.position.z - enemy.lastPosition.z);
    advanceTankTreads(enemy.parts, traveledThisFrame, angleDifference(priorHeading, tank.rotation.y));
    const enemySpeedRatio = THREE.MathUtils.clamp(traveledThisFrame / Math.max(0.001, delta * 3.6 * stats.speed), 0, 1);
    tank.position.y = Math.sin(clock.elapsedTime * 8 + tank.id) * 0.026 * enemySpeedRatio;
    enemy.barrelRecoil = Math.max(0, enemy.barrelRecoil - delta * 1.1);
    enemy.parts.barrel.position.z = -1.27 + enemy.barrelRecoil;

    enemy.shootTimer -= delta;
    const aimError = Math.abs(angleDifference(tank.rotation.y + enemy.parts.turret.rotation.y, desiredAim));
    // `seesTarget` já validou a mesma linha de tiro neste frame; repetir o
    // teste percorre todos os obstáculos sem alterar a decisão do disparo.
    const canFire = !!target && seesTarget && bestDistance < (enemy.tankClass === 'artillery' ? 54 : 44);
    if (enemy.shootTimer <= 0 && canFire && aimError < 0.2 && enemy.spawnGrace <= 0) {
      enemyShoot(enemy);
      enemy.shootTimer = (1.8 + Math.random() * 1.1) * stats.fireRate;
    }
  }
  previousPlayerPosition.copy(player.position);
}

// =====================================================
// SISTEMA DE ONDAS E MODOS
// =====================================================

function updateWaves(delta: number) {
  // Sobrevivência avança quando a equipe adversária é eliminada; aliados vivos
  // não podem bloquear o renascimento/início da próxima onda.
  // Este caminho roda em todo frame: conte diretamente para evitar criar um
  // array temporário com filter durante a partida.
  let aliveCount = 0;
  for (const enemy of enemies) {
    if (enemy.alive && enemy.team !== playerTeam) aliveCount++;
  }

  if (gameMode === 'ctf') return;

  if (gameMode === 'deathmatch') {
    if (matchEnded) return;

    matchTime = Math.max(0, matchTime - delta);

    setText(waveText, `Tempo: ${Math.ceil(matchTime)}s`);
    setText(waveBanner, `MATA-MATA · ${Math.ceil(matchTime)}s · ${playerKills} eliminações`);

    if (matchTime <= 0) {
      finishBattle(`FIM DE JOGO · ${playerKills} eliminações`);
    }

    return;
  }

  if (waveBannerTimer > 0) {
    waveBannerTimer -= delta;
    if (waveBannerTimer <= 0) waveBanner.textContent = '';
  }

  if (aliveCount > 0) {
    waitingForNextWave = false;
    return;
  }

  if (!waitingForNextWave) {
    waitingForNextWave = true;
    waveTimer = 5;
    waveBanner.textContent = 'ÁREA LIMPA — PRÓXIMA ONDA EM 5';
    waveBannerTimer = 5;
  }

  waveTimer -= delta;

  if (waveTimer <= 0) {
    currentWave++;
    const fallenBots = enemies.filter(enemy => !enemy.alive);
    let spawned = 0;
    for (const bot of fallenBots) {
      if (respawnEnemy(bot)) spawned++;
      else bot.respawnTimer = 1;
    }
    // Recuperação de roster: se por qualquer motivo a lista ficou sem bots
    // adversários, cria uma nova força em vez de deixar a onda travada.
    const hasOpposingBot = enemies.some(enemy => enemy.team !== playerTeam);
    if (spawned === 0 && !hasOpposingBot) {
      const reinforcementCount = Math.min(3 + currentWave, 10);
      for (let i = 0; i < reinforcementCount; i++) {
        if (createEnemy(oppositeTeam(playerTeam))) spawned++;
      }
    }

    if (spawned > 0) {
      waitingForNextWave = false;
      waveBanner.textContent = `ONDA ${currentWave} — ${spawned} TANQUES RETORNARAM ÀS SUAS EQUIPES`;
      waveBannerTimer = 2.5;
      updateHUD();
    } else {
      waveTimer = 2;
    }
  } else if (waveTimer > 0) {
    setText(waveBanner, `PRÓXIMA ONDA EM ${Math.ceil(waveTimer)}`);
  }
}


// =====================================================
// CAIXAS DE SUPRIMENTO: 3 de cada tipo por mapa
// =====================================================

type CrateType = 'health' | 'damage' | 'armor' | 'speed' | 'crystals';
type SupplyCrate = { group: THREE.Group; parachute: THREE.Group; type: CrateType; targetY: number; dropping: boolean; phase: number; remaining: number };
const crates: SupplyCrate[] = [];
const crateTypes: CrateType[] = [
  'health', 'health', 'health',
  'damage', 'damage', 'damage',
  'armor', 'armor', 'armor',
  'speed', 'speed', 'speed',
  'crystals', 'crystals', 'crystals'
];
for (let i = crateTypes.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [crateTypes[i], crateTypes[j]] = [crateTypes[j], crateTypes[i]];
}
let crateQueue = crateTypes.slice();
let crateDropTimer = 15;
let crateMessageTimer = 0;
let powerHudTimer = 0;
let powerDamageTimer = 0;
let powerArmorTimer = 0;
let powerSpeedTimer = 0;
const CRATE_EFFECT_DURATION = 20;
const crateInfo: Record<CrateType, { color: number; label: string }> = {
  health: { color: 0x35d66f, label: 'VIDA +50' },
  damage: { color: 0xff7138, label: 'DANO DOBRADO' },
  armor: { color: 0x42bfff, label: 'BLINDAGEM DOBRADA' },
  speed: { color: 0xffd447, label: 'VELOCIDADE DOBRADA' },
  crystals: { color: 0xe4bc55, label: 'CRISTAIS +25' }
};

function createSupplyIconTexture(type: CrateType) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  context.strokeStyle = '#f5f2e8';
  context.fillStyle = '#f5f2e8';
  context.lineWidth = 13;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (type === 'health') {
    context.fillRect(51, 18, 26, 92);
    context.fillRect(18, 51, 92, 26);
  } else if (type === 'damage') {
    context.beginPath(); context.arc(64, 64, 42, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.moveTo(28, 64); context.lineTo(48, 64); context.moveTo(80, 64); context.lineTo(100, 64);
    context.moveTo(64, 28); context.lineTo(64, 48); context.moveTo(64, 80); context.lineTo(64, 100); context.stroke();
    context.beginPath(); context.arc(64, 64, 10, 0, Math.PI * 2); context.fill();
  } else if (type === 'armor') {
    context.beginPath(); context.moveTo(64, 15); context.lineTo(105, 32); context.lineTo(98, 78);
    context.lineTo(64, 111); context.lineTo(30, 78); context.lineTo(23, 32); context.closePath(); context.stroke();
    context.beginPath(); context.moveTo(45, 64); context.lineTo(59, 78); context.lineTo(84, 49); context.stroke();
  } else if (type === 'crystals') {
    context.beginPath(); context.moveTo(64, 12); context.lineTo(108, 48); context.lineTo(90, 105);
    context.lineTo(38, 105); context.lineTo(20, 48); context.closePath(); context.stroke();
    context.beginPath(); context.moveTo(20, 48); context.lineTo(108, 48); context.moveTo(64, 12); context.lineTo(38, 105);
    context.moveTo(64, 12); context.lineTo(90, 105); context.moveTo(38, 105); context.lineTo(90, 105); context.stroke();
  } else {
    context.beginPath(); context.moveTo(73, 10); context.lineTo(34, 68); context.lineTo(57, 68);
    context.lineTo(48, 118); context.lineTo(94, 53); context.lineTo(69, 53); context.closePath(); context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 1;
  return texture;
}

function findCratePosition(): THREE.Vector3 | null {
  for (let attempt = 0; attempt < 100; attempt++) {
    const point = new THREE.Vector3(
      THREE.MathUtils.randFloat(-46, 46), 0,
      THREE.MathUtils.randFloat(-46, 46)
    );
    if (!canMoveTo(point)) continue;
    if (point.distanceTo(player.position) < 9) continue;
    if (enemies.some(enemy => enemy.alive && enemy.parts.root.position.distanceTo(point) < 5)) continue;
    if (crates.some(crate => Math.hypot(crate.group.position.x - point.x, crate.group.position.z - point.z) < 7)) continue;
    return point;
  }
  return null;
}

function dropSupplyCrate(type: CrateType, position: THREE.Vector3) {
  const group = new THREE.Group();
  const color = crateInfo[type].color;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.25, 1.05, 1.25),
    new THREE.MeshLambertMaterial({ color: 0x796c51 })
  );
  body.castShadow = false;
  body.receiveShadow = false;
  group.add(body);
  const bandMaterial = new THREE.MeshLambertMaterial({ color: 0x242424 });
  const band = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.18, 1.32), bandMaterial);
  band.castShadow = false;
  group.add(band);
  const typeBand = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.12, 1.34), new THREE.MeshLambertMaterial({ color }));
  typeBand.castShadow = false;
  group.add(typeBand);
  const iconTexture = createSupplyIconTexture(type);
  const icon = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.72), new THREE.MeshBasicMaterial({
    map: iconTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide
  }));
  icon.rotation.x = -Math.PI / 2;
  icon.position.y = 0.535;
  group.add(icon);

  // Um paraquedas simples deixa claro que o suprimento caiu do céu.
  const parachute = new THREE.Group();
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({
    color: 0xd4cdb8, side: THREE.DoubleSide
  }));
  canopy.scale.y = 0.44;
  canopy.position.y = 3.2;
  canopy.castShadow = false;
  parachute.add(canopy);
  const ropePoints: THREE.Vector3[] = [];
  for (const [x, z] of [[-0.48, -0.48], [0.48, -0.48], [-0.48, 0.48], [0.48, 0.48]]) {
    ropePoints.push(new THREE.Vector3(x, 0.54, z), new THREE.Vector3(x * 1.65, 3.0, z * 1.65));
  }
  const ropes = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ropePoints), new THREE.LineBasicMaterial({ color: 0xc9c0a7 }));
  parachute.add(ropes);
  group.add(parachute);
  group.position.set(position.x, 13, position.z);
  scene.add(group);
  crates.push({ group, parachute, type, targetY: 0.65, dropping: true, phase: Math.random() * Math.PI * 2, remaining: 12 });
}

function removeSupplyCrate(crate: SupplyCrate) {
  scene.remove(crate.group);
  crate.group.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const texture = (material as THREE.MeshBasicMaterial).map;
      if (texture) texture.dispose();
      material.dispose();
    }
  });
  const index = crates.indexOf(crate);
  if (index >= 0) crates.splice(index, 1);
}

function collectCrate(crate: SupplyCrate) {
  if (crate.type === 'health') {
    playerHealth = Math.min(playerMaxHealth, playerHealth + 50);
  } else if (crate.type === 'damage') {
    powerDamageTimer = CRATE_EFFECT_DURATION;
  } else if (crate.type === 'armor') {
    powerArmorTimer = CRATE_EFFECT_DURATION;
  } else if (crate.type === 'speed') {
    powerSpeedTimer = CRATE_EFFECT_DURATION;
  } else if (crate.type === 'crystals') {
    playerCrystals += 25;
  }
  respawnMessage.textContent = `CAIXA COLETADA: ${crateInfo[crate.type].label}`;
  crateMessageTimer = 2.2;
  playSound(520, 0.16, 0.08);
  removeSupplyCrate(crate);
  updateHUD();
}

function updateSupplyCrates(delta: number) {
  crateDropTimer -= delta;
  if (crateDropTimer <= 0 && crateQueue.length > 0) {
    const position = findCratePosition();
    if (position) {
      const nextType = crateQueue.shift()!;
      dropSupplyCrate(nextType, position);
      respawnMessage.textContent = 'SUPRIMENTO DETECTADO — CAIXA EM QUEDA!';
      crateMessageTimer = 2.2;
      crateDropTimer = 25;
    } else {
      crateDropTimer = 5;
    }
  }

  for (let crateIndex = crates.length - 1; crateIndex >= 0; crateIndex--) {
    const crate = crates[crateIndex];
    crate.phase += delta * 2.2;
    if (crate.dropping) {
      crate.group.position.y = Math.max(crate.targetY, crate.group.position.y - delta * 8.5);
      if (crate.group.position.y <= crate.targetY) {
        crate.dropping = false;
        crate.parachute.visible = false;
      }
    } else {
      crate.remaining -= delta;
      crate.group.visible = crate.remaining > 3 || Math.floor(crate.remaining * 3) % 2 === 0;
      if (crate.remaining <= 0) {
        removeSupplyCrate(crate);
        continue;
      }
      crate.group.position.y = crate.targetY + Math.sin(crate.phase) * 0.12;
      crate.group.rotation.y += delta * 0.65;
      if (playerAlive && crate.group.position.distanceTo(player.position) < 2.6) {
        collectCrate(crate);
      }
    }
  }

  powerDamageTimer = Math.max(0, powerDamageTimer - delta);
  powerArmorTimer = Math.max(0, powerArmorTimer - delta);
  powerSpeedTimer = Math.max(0, powerSpeedTimer - delta);
  powerHudTimer -= delta;
  if (powerHudTimer <= 0) {
    powerHudTimer = 0.2;
    const active = [
      powerDamageTimer > 0 ? `Dano 2x ${Math.ceil(powerDamageTimer)}s` : '',
      powerArmorTimer > 0 ? `Blindagem 2x ${Math.ceil(powerArmorTimer)}s` : '',
      powerSpeedTimer > 0 ? `Velocidade 2x ${Math.ceil(powerSpeedTimer)}s` : ''
    ].filter(Boolean);
    setText(powerText, active.length ? active.join(' · ') : `Caixas restantes: ${crateQueue.length + crates.length}`);
  }
  if (crateMessageTimer > 0) {
    crateMessageTimer -= delta;
    if (crateMessageTimer <= 0) respawnMessage.textContent = '';
  }
}

// =====================================================
// MOVIMENTAÇÃO DO JOGADOR
// =====================================================

const keys = new Set<string>();
const playerForward = new THREE.Vector3();
const playerNextPosition = new THREE.Vector3();
let playerLinearSpeed = 0;
let playerSuspensionPhase = 0;
let playerBarrelRecoil = 0;

let firing = false;
let mouseFiring = false;
let cameraLookMode = false;
let centerTurret = false;

function updatePlayer(delta: number) {
  if (!playerAlive || matchEnded) return;
  const stats = TANK_CLASSES[selectedTankClass];
  const speedBoost = powerSpeedTimer > 0 ? 2 : 1;
  const priorHeading = player.rotation.y;
  const maxForwardSpeed = 9 * playerMoveMultiplier * speedBoost;
  const acceptInput = !garageOpen && !mainMenuOpen;
  const driveInput = acceptInput ? Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown')) : 0;
  const turnInput = acceptInput ? Number(keys.has('KeyA') || keys.has('ArrowLeft')) - Number(keys.has('KeyD') || keys.has('ArrowRight')) : 0;
  const priorSpeed = playerLinearSpeed;
  const targetSpeed = driveInput > 0 ? maxForwardSpeed : driveInput < 0 ? -maxForwardSpeed * 0.46 : 0;
  const braking = driveInput !== 0 && playerLinearSpeed * driveInput < -0.1;
  const acceleration = (braking ? 13.5 : 6.2) * stats.acceleration * speedBoost;
  if (driveInput !== 0) {
    playerLinearSpeed = THREE.MathUtils.damp(playerLinearSpeed, targetSpeed, acceleration / Math.max(1, maxForwardSpeed) * 6, delta);
  } else {
    // A massa mantém o tanque avançando um pouco depois que o jogador solta W.
    playerLinearSpeed *= Math.exp(-1.35 * delta);
    if (Math.abs(playerLinearSpeed) < 0.035) playerLinearSpeed = 0;
  }

  const speedRatio = Math.min(1, Math.abs(playerLinearSpeed) / Math.max(0.1, maxForwardSpeed));
  const turnGrip = 0.38 + speedRatio * 0.62;
  // A direção indicada pelas teclas A/D continua relativa ao casco mesmo em ré.
  player.rotation.y += turnInput * 1.85 * stats.turnRate * turnGrip * delta;
  playerForward.set(-Math.sin(player.rotation.y), 0, -Math.cos(player.rotation.y));
  const next = playerNextPosition.copy(player.position);
  next.addScaledVector(playerForward, playerLinearSpeed * delta);
  const oldX = player.position.x, oldZ = player.position.z;
  if (canPlayerMoveTo(next)) {
    player.position.copy(next);
  } else if (Math.abs(playerLinearSpeed) > 0.8) {
    playerLinearSpeed *= -0.12;
    cameraShake = Math.max(cameraShake, 0.025);
  }
  const moved = Math.hypot(player.position.x - oldX, player.position.z - oldZ);
  advanceTankTreads(playerParts, Math.sign(playerLinearSpeed) * moved, angleDifference(priorHeading, player.rotation.y));
  if (moved > 0.002 && Math.random() < Math.min(1, delta * 18)) emitDust(player.position, player.rotation.y);

  // O casco inclina com aceleração/frenagem e apoia a suspensão nas curvas.
  const longitudinalAcceleration = delta > 0 ? (playerLinearSpeed - priorSpeed) / delta : 0;
  const targetPitch = THREE.MathUtils.clamp(-longitudinalAcceleration * 0.003, -0.055, 0.055);
  const targetRoll = -turnInput * speedRatio * 0.045;
  player.rotation.x = THREE.MathUtils.damp(player.rotation.x, targetPitch, 8, delta);
  player.rotation.z = THREE.MathUtils.damp(player.rotation.z, targetRoll, 7, delta);
  playerSuspensionPhase += delta * (5 + Math.abs(playerLinearSpeed) * 0.8);
  player.position.y = Math.sin(playerSuspensionPhase) * Math.min(0.035, speedRatio * 0.035);
  playerBarrelRecoil = Math.max(0, playerBarrelRecoil - delta * 1.35);
  playerParts.barrel.position.z = -1.27 + playerBarrelRecoil;

  const turretTurnSpeed = 1.15 * stats.turnRate * delta;

  if (keys.has('KeyZ')) {
    playerTurret.rotation.y += turretTurnSpeed;
    centerTurret = false;
  }

  if (keys.has('KeyX')) {
    playerTurret.rotation.y -= turretTurnSpeed;
    centerTurret = false;
  }

  if (centerTurret) {
    const difference = angleDifference(playerTurret.rotation.y, 0);

    playerTurret.rotation.y += difference * Math.min(1, delta * 5);

    if (Math.abs(difference) < 0.01) {
      playerTurret.rotation.y = 0;
      centerTurret = false;
      cameraYawOffset = 0;
    }
  }

  // Q/E mudam a elevação da câmera preservando a distância ao tanque.
  const cameraLiftInput = Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
  if (cameraLiftInput !== 0) {
    cameraOffset.y = THREE.MathUtils.clamp(cameraOffset.y + cameraLiftInput * 4 * delta, 2.5, 8.5);
    cameraOffset.z = Math.sqrt(Math.max(9, 92 - cameraOffset.y * cameraOffset.y));
  }
}

// =====================================================
// AUTODESTRUIÇÃO (DELETE)
// =====================================================

function updateSelfDestruct(delta: number) {
  if (selfDestructTimer <= 0 || !playerAlive) return;
  selfDestructTimer -= delta;
  setText(respawnMessage, `AUTODESTRUIÇÃO EM ${Math.max(1, Math.ceil(selfDestructTimer))}...`);
  if (selfDestructTimer <= 0) {
    selfDestructTimer = 0;
    damagePlayer(playerHealth, true);
  }
}

function findSafePlayerSpawn(): THREE.Vector3 {
  const candidates: THREE.Vector3[] = [];
  const base = teamBasePosition(playerTeam);
  for (let radius = 5; radius <= 22; radius += 3) {
    for (let i = 0; i < 24; i++) {
      const angle = (Math.PI * 2 * i) / 24;
      candidates.push(new THREE.Vector3(base.x + Math.cos(angle) * radius, 0, base.z + Math.sin(angle) * radius));
    }
  }
  for (const candidate of candidates) {
    if (!canMoveTo(candidate)) continue;
    const occupied = enemies.some(enemy => enemy.alive && enemy.parts.root.position.distanceTo(candidate) < 8);
    if (!occupied) return candidate;
  }
  return teamBasePosition(playerTeam);
}

// =====================================================
// RESPAWN
// =====================================================

function updateRespawn(delta: number) {
  if (playerAlive || matchEnded) return;
  respawnTimer -= delta;
  if (respawnTimer > 0) return;
  playerAlive = true;
  playerHealth = playerMaxHealth;
  playerTeamHealthBar.update(playerHealth, playerMaxHealth);
  invulnerability = 3;
  playerSpawnGrace = 3;
  selfDestructTimer = 0;
  player.visible = true;
  player.position.copy(findSafePlayerSpawn());
  playerLinearSpeed = 0;
  player.position.y = 0;
  syncTankGearToWorld(playerParts);
  playerBarrelRecoil = 0;
  previousPlayerPosition.copy(player.position);
  player.rotation.set(0, playerArenaHeading(), 0);
  playerTurret.rotation.y = 0;
  respawnTimer = 0;
  respawnMessage.textContent = 'VOCÊ VOLTOU À BATALHA!';
  if (garageOpen || mainMenuOpen) {
    const status = document.getElementById('garage-status');
    const condition = document.getElementById('garage-condition-text');
    if (status) status.textContent = 'CAMPO ATIVO · TANQUE VULNERÁVEL';
    if (condition) condition.textContent = 'OPERACIONAL';
  }
  updateHUD();
}

// =====================================================
// CÂMERA
// =====================================================

const cameraOffset = new THREE.Vector3(0, 5.2, 8);
const cameraTarget = new THREE.Vector3();
const desiredCameraPosition = new THREE.Vector3();
const cameraAimDirection = new THREE.Vector3();
let cameraYawOffset = 0;

function updateCamera(delta = 1 / 60) {
  const heading = player.rotation.y + playerTurret.rotation.y + cameraYawOffset;

  desiredCameraPosition.copy(cameraOffset)
    .applyAxisAngle(worldUp, heading)
    .add(player.position);

  camera.position.lerp(desiredCameraPosition, 1 - Math.exp(-7.5 * delta));
  if (cameraShake > 0.003) {
    camera.position.x += (Math.random() - 0.5) * cameraShake;
    camera.position.y += (Math.random() - 0.5) * cameraShake * 0.6;
    camera.position.z += (Math.random() - 0.5) * cameraShake;
    cameraShake *= 0.88;
  } else cameraShake = 0;

  cameraAimDirection.set(-Math.sin(heading), 0, -Math.cos(heading));

  cameraTarget.copy(player.position);
  cameraTarget.y += 1.1;
  cameraTarget.addScaledVector(cameraAimDirection, 5);

  camera.lookAt(cameraTarget);
}

// =====================================================
// EVENTOS E CONTROLES
// =====================================================

window.addEventListener('keydown', event => {
  if (event.code === 'Tab') {
    event.preventDefault();
    if (!garageOpen && !mainMenuOpen) {
      refreshBattleScoreboard();
      battleScoreboard.classList.remove('hidden');
    }
    return;
  }
  if (
    event.code === 'Space' ||
    event.code.startsWith('Arrow') ||
    event.code === 'KeyQ' || event.code === 'KeyE'
  ) {
    event.preventDefault();
  }

  if (event.code === 'Delete') {
    event.preventDefault();
    if (!event.repeat && playerAlive && selfDestructTimer <= 0) selfDestructTimer = 3;
    return;
  }

  if (event.code === 'KeyG' && !event.repeat) {
    if (garageOpen) closeGarage();
    else openGarage();
    return;
  }

  if (event.code === 'KeyM' && !event.repeat) {
    if (mainMenuOpen) hideMainMenu();
    else showMainMenu();
    return;
  }

  if (event.code === 'F2' && !event.repeat) {
    event.preventDefault();
    const order: QualityLevel[] = ['balanced', 'high', 'maximum'];
    graphicsQuality = order[(order.indexOf(graphicsQuality) + 1) % order.length];
    fxAutoDisabled = false;
    const select = document.getElementById('graphics-quality') as HTMLSelectElement | null;
    if (select) select.value = graphicsQuality;
    applyQuality();
    respawnMessage.textContent = `GRÁFICOS: ${graphicsQuality === 'maximum' ? 'MÁXIMO' : graphicsQuality === 'high' ? 'ALTO' : 'EQUILIBRADO'}`;
    window.setTimeout(() => { respawnMessage.textContent = ''; }, 1200);
    return;
  }
  if (event.code === 'F3' && !event.repeat) {
    event.preventDefault();
    fxAutoDisabled = !fxAutoDisabled;
    setupPostFx();
    applyPixelRatio();
    respawnMessage.textContent = fxAutoDisabled ? 'CORREÇÃO DE COR: DESLIGADA' : 'CORREÇÃO DE COR: LIGADA';
    window.setTimeout(() => { respawnMessage.textContent = ''; }, 1200);
    return;
  }

  if (garageOpen || mainMenuOpen) return;

  keys.add(event.code);

  if (event.code === 'Space') firing = true;
  if (event.code === 'KeyC') centerTurret = true;

  if (event.code === 'Digit1') {
    selectedWeapon = 'cannon';
    updateHUD();
  }

  if (event.code === 'Digit2') {
    selectedWeapon = 'rapid';
    updateHUD();
  }
});

window.addEventListener('keyup', event => {
  keys.delete(event.code);
  if (event.code === 'Tab') battleScoreboard.classList.add('hidden');

  if (event.code === 'Space') firing = false;
});

window.addEventListener('blur', () => {
  keys.clear();
  firing = false;
  mouseFiring = false;
});

renderer.domElement.addEventListener('click', () => {
  if (
    !garageOpen &&
    document.pointerLockElement !== renderer.domElement
  ) {
    renderer.domElement.requestPointerLock();
  }
});

document.addEventListener('mousemove', event => {
  if (
    document.pointerLockElement !== renderer.domElement ||
    garageOpen
  ) return;

  if (cameraLookMode) {
    cameraYawOffset -= event.movementX * 0.0018;
    cameraOffset.y = THREE.MathUtils.clamp(cameraOffset.y - event.movementY * 0.02, 2.5, 8.5);
    cameraOffset.z = Math.sqrt(Math.max(9, 92 - cameraOffset.y * cameraOffset.y));
  } else {
    playerTurret.rotation.y -= event.movementX * 0.0011 * TANK_CLASSES[selectedTankClass].turnRate;
  }
});

document.addEventListener('mousedown', event => {
  if (
    event.button === 0 &&
    document.pointerLockElement === renderer.domElement &&
    !garageOpen
  ) {
    mouseFiring = true;
  }
  if (event.button === 2 && document.pointerLockElement === renderer.domElement && !garageOpen) {
    cameraLookMode = true;
    event.preventDefault();
  }
});

document.addEventListener('mouseup', event => {
  if (event.button === 0) mouseFiring = false;
  if (event.button === 2) cameraLookMode = false;
});

renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement) {
    mouseFiring = false;
    cameraLookMode = false;
  }
});

// =====================================================
// LOOP PRINCIPAL
// =====================================================

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.05);
  const cpuFrameStartedAt = performance.now();

  {
    playerFireCooldown = Math.max(0, playerFireCooldown - delta);
    invulnerability = Math.max(0, invulnerability - delta);
    playerSpawnGrace = Math.max(0, playerSpawnGrace - delta);

    updateSelfDestruct(delta);
    updatePlayer(delta);
    updateEnemies(delta);
    updateRespawn(delta);
    updateWaves(delta);
    updateSupplyCrates(delta);
    updateCaptureTheFlag();
    drawMinimap(delta);

    if (playerAlive && (firing || mouseFiring)) playerShoot();

    updateProjectiles(delta);
    updateParticles(delta);
    updateCamera(delta);
    for (const enemy of enemies) {
      if (enemy.alive) updateTankDetailLod(enemy.parts, camera.position);
    }
    for (const flag of Object.values(flags)) {
      flag.mesh.rotation.y = Math.atan2(camera.position.x - flag.mesh.position.x, camera.position.z - flag.mesh.position.z);
    }

    if (playerAlive && invulnerability > 0) {
      player.visible = Math.floor(invulnerability * 10) % 2 === 0;
    } else if (playerAlive) {
      player.visible = true;
    }
    if (playerParts.gearVisible !== player.visible) syncTankGearToWorld(playerParts);
  }

  if (composer && postFxActive) composer.render(delta);
  else renderer.render(scene, camera);
  lastCpuFrameMs = performance.now() - cpuFrameStartedAt;
  if (garageOpen && !garage.classList.contains('hidden')) {
    const width = garagePreviewElement.clientWidth;
    const height = garagePreviewElement.clientHeight;
    if (width > 2 && height > 2) {
      if (garagePreviewRenderer.domElement.width !== Math.floor(width * Math.min(window.devicePixelRatio || 1, 1.25)) || garagePreviewRenderer.domElement.height !== Math.floor(height * Math.min(window.devicePixelRatio || 1, 1.25))) resizeGaragePreview();
      garagePreviewTank.rotation.y += delta * 0.22;
      // O anel decorativo fica estático e fosco; a prévia não usa brilho animado.
      if (garagePreviewTurret) garagePreviewTurret.rotation.y = Math.sin(clock.elapsedTime * 0.42) * 0.22;
      try { garagePreviewRenderer.render(garagePreviewScene, garagePreviewCamera); }
      catch (previewError) { console.error('Falha ao renderizar a prévia da garagem:', previewError); }
    }
  }
  lastDrawCalls = renderer.info.render.calls + garagePreviewRenderer.info.render.calls;
  lastTriangles = renderer.info.render.triangles + garagePreviewRenderer.info.render.triangles;
  renderer.info.reset();
  garagePreviewRenderer.info.reset();
  updateFpsCounter(performance.now());
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyPixelRatio();
  if (garageOpen) resizeGaragePreview();
});

// Qualidade gráfica inicial (pós-processamento, sombras, resolução).
(document.getElementById('graphics-quality') as HTMLSelectElement).value = graphicsQuality;
applyQuality();
refreshPaintAvailability();

// Pré-aquecimento: compila os shaders dos projéteis/efeitos escondidos sob o chão,
// para o primeiro tiro não causar engasgo.
{
  const warm: THREE.Object3D[] = [
    new THREE.Mesh(projectileGeometry, playerProjectileMaterial),
    new THREE.Mesh(projectileGeometry, enemyProjectileMaterial),
    new THREE.Mesh(projectileGeometry, playerRapidProjectileMaterial),
    new THREE.Mesh(projectileGeometry, enemyRapidProjectileMaterial),
    new THREE.Mesh(cannonShellGeometry, playerProjectileMaterial),
    new THREE.Mesh(cannonShellGeometry, enemyProjectileMaterial),
    new THREE.Sprite(playerProjectileGlowMaterial),
    new THREE.Sprite(enemyProjectileGlowMaterial)
  ];
  warm.forEach(object => { object.position.set(player.position.x, -3, player.position.z - 6); scene.add(object); });
  window.setTimeout(() => warm.forEach(object => scene.remove(object)), 700);
}

// Modelos 3D e texturas PBR opcionais (ignorados em silêncio se os arquivos não existirem).
loadTankModels();
loadBattlefieldAssets();

// Inicialização real do modo padrão depois que HUD e controles já existem.
(document.getElementById('game-mode') as HTMLSelectElement).value = 'ctf';
setDecorativeFlagsVisible(false);
resetCaptureTheFlag();
(document.getElementById('team-select') as HTMLSelectElement).value = playerTeam;
(document.getElementById('garage-close') as HTMLButtonElement).textContent = 'FECHAR GARAGEM';
(document.getElementById('preview-class') as HTMLElement).textContent = 'TANQUE MÉDIO';
syncGaragePreview();
resizeGaragePreview();
player.position.copy(findSafePlayerSpawn());
previousPlayerPosition.copy(player.position);
player.rotation.set(0, playerArenaHeading(), 0);
syncTankGearToWorld(playerParts);
updateHUD();
updateCamera();
animate();
