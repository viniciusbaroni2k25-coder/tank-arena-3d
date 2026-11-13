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

let graphicsQuality: 'balanced' | 'high' | 'maximum' = 'high';
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
  balanced: { ratio: 0.75, post: false, msaa: 0 },
  high: { ratio: 1, post: false, msaa: 0 },
  maximum: { ratio: 1.15, post: true, msaa: 2 }
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

const ATMOSPHERE: Record<string, number> = { field: 0x87b9d9, desert: 0xe0bd83, industrial: 0x788890, canyon: 0xd5b28a, snow: 0xc6d5df, harbor: 0x9bb3c1, volcano: 0x9a6b59, metropolis: 0x89959b, swamp: 0x9aaa83, moon: 0x555b68, night: 0x111827 };
function applyAtmosphere() {
  const atmosphereKey = lightingStyle === 'night' ? 'night' : mapStyleName;
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

// Mantém os efeitos do perfil e ajusta a escala de renderização sob carga.
let adaptiveRenderScale = 1;
let lowFpsWindows = 0;
let highFpsWindows = 0;
function qualityPixelRatio(): number {
  const deviceRatio = window.devicePixelRatio || 1;
  return Math.min(deviceRatio, QUALITY[graphicsQuality].ratio) * adaptiveRenderScale;
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
fpsHud.classList.add('performance-readout');
fpsHud.textContent = 'FPS: --';
Object.assign(fpsHud.style, {
  position: 'fixed', bottom: '10px', right: '10px', zIndex: '1000',
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
    fpsHud.textContent = `FPS: ${fps} · ${(adaptiveRenderScale * 100).toFixed(0)}% RES · ${lastDrawCalls} calls · ${(lastTriangles / 1000).toFixed(0)}k tris · CPU ${lastCpuFrameMs.toFixed(1)}ms${postFxActive ? ' · FX' : ''} · ${graphicsQuality === 'maximum' ? 'ULTRA' : graphicsQuality === 'high' ? 'ALTO' : 'EQUIL'}`;
    fpsHud.style.color = fps >= 55 ? '#baf7c5' : fps >= 30 ? '#ffe09a' : '#ff9999';
    if (fps < 44) {
      lowFpsWindows++;
      highFpsWindows = 0;
      if (lowFpsWindows >= 2 && adaptiveRenderScale > 0.6) {
        adaptiveRenderScale = Math.max(0.6, adaptiveRenderScale - 0.12);
        lowFpsWindows = 0;
        applyPixelRatio();
      }
    } else if (fps > 57) {
      highFpsWindows++;
      lowFpsWindows = 0;
      if (highFpsWindows >= 5 && adaptiveRenderScale < 1) {
        adaptiveRenderScale = Math.min(1, adaptiveRenderScale + 0.08);
        highFpsWindows = 0;
        applyPixelRatio();
      }
    } else {
      lowFpsWindows = Math.max(0, lowFpsWindows - 1);
      highFpsWindows = 0;
    }
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

// Luz direcional global com mapa de sombras dimensionado para equilibrar detalhe e custo.
const SUN_OFFSET = new THREE.Vector3(15, 30, 12);
const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
sun.position.copy(SUN_OFFSET);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 100;
sun.shadow.camera.left = -58;
sun.shadow.camera.right = 58;
sun.shadow.camera.top = 58;
sun.shadow.camera.bottom = -58;
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.00015;
sun.shadow.normalBias = 0.035;
scene.add(sun);
scene.add(sun.target);

const clock = new THREE.Clock();
const worldUp = new THREE.Vector3(0, 1, 0);
// =====================================================
// CÉU: cúpula com degradê, nuvens e sol (1 única chamada de desenho)
// =====================================================

type SkyStyle = 'field' | 'desert' | 'industrial' | 'canyon' | 'snow' | 'harbor' | 'volcano' | 'metropolis' | 'swamp' | 'moon' | 'night';
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
    industrial: { top: '#405767', mid: '#71828a', horizon: '#788890' },
    canyon: { top: '#577da4', mid: '#c0a98a', horizon: '#d5b28a' },
    snow: { top: '#6b91b4', mid: '#a8c3d2', horizon: '#c6d5df' },
    harbor: { top: '#4b85a2', mid: '#90b4c1', horizon: '#9bb3c1' },
    volcano: { top: '#443b49', mid: '#986e64', horizon: '#9a6b59' },
    metropolis: { top: '#465d70', mid: '#83939b', horizon: '#89959b' },
    swamp: { top: '#4d775f', mid: '#879976', horizon: '#9aaa83' },
    moon: { top: '#080d19', mid: '#242b3b', horizon: '#555b68' },
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

  if (style === 'night' || style === 'moon') {
    for (let i = 0; i < (style === 'moon' ? 700 : 420); i++) {
      const x = rand() * W, y = rand() * H * 0.46;
      ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.6})`;
      ctx.fillRect(x, y, rand() > 0.9 ? 2 : 1, 1);
    }
    const celestial = style === 'moon' ? { x: 0.72, y: 0.2, glow: '190,205,235', disc: '220,226,236' } : { x: 0.393, y: 0.225, glow: '170,190,255', disc: '235,240,255' };
    softBlob(W * celestial.x, H * celestial.y, style === 'moon' ? 95 : 70, 1.5, celestial.glow, 0.55);
    softBlob(W * celestial.x, H * celestial.y, style === 'moon' ? 44 : 14, 1.5, celestial.disc, 1);
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
const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x657d4b,
  map: terrainTexture ?? undefined,
  roughness: 0.96,
  metalness: 0,
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
ground.receiveShadow = true;
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
type MapStyle = 'field' | 'desert' | 'industrial' | 'canyon' | 'snow' | 'harbor' | 'volcano' | 'metropolis' | 'swamp' | 'moon';
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
  textureLoader.load('/textures/ground_normal.jpg', normal => {
    groundMaterial.normalMap = prepare(normal, false);
    groundMaterial.normalScale.set(0.32, 0.32);
    groundMaterial.needsUpdate = true;
  }, undefined, () => {});
  textureLoader.load('/textures/ground_roughness.jpg', roughness => {
    groundMaterial.roughnessMap = prepare(roughness, false);
    groundMaterial.needsUpdate = true;
  }, undefined, () => {});
  textureLoader.load('/textures/ground_ao.jpg', ao => {
    groundMaterial.aoMap = prepare(ao, false);
    groundMaterial.aoMapIntensity = 0.45;
    groundMaterial.needsUpdate = true;
  }, undefined, () => {});
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
  rotation?: number;
  shape?: 'box' | 'ellipse';
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
  depth = width,
  style: MapStyle = 'field'
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
    style,
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

// Coberturas exclusivas por cenário: cada estilo fica em poucos meshes agrupados.
const mapVariantMeshes: Record<MapStyle, THREE.Object3D[]> = { field: [], desert: [], industrial: [], canyon: [], snow: [], harbor: [], volcano: [], metropolis: [], swamp: [], moon: [] };
function addMapVariantMesh(geometries: THREE.BufferGeometry[], material: THREE.Material, style: MapStyle) {
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
    shape: style === 'desert' || style === 'canyon' || style === 'volcano' || style === 'swamp' ? 'ellipse' : 'box',
    style,
  };
  obstacles.push(obstacle);

  if (style === 'desert' || style === 'canyon' || style === 'volcano' || style === 'swamp') {
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
createMapVariantCover('desert', -31, 18, 9, 3.6, 4.4, desertCoverGeometries);
createMapVariantCover('desert', 31, -18, 9, 3.6, 4.4, desertCoverGeometries);
const desertRockMaterial = new THREE.MeshLambertMaterial({ color: 0xb89a6d });
addMapVariantMesh(desertCoverGeometries, desertRockMaterial, 'desert');

const canyonCoverGeometries: THREE.BufferGeometry[] = [];
createMapVariantCover('canyon', -19, 5, 7.2, 3.8, 5.5, canyonCoverGeometries);
createMapVariantCover('canyon', 19, -5, 7.2, 3.8, 5.5, canyonCoverGeometries);
createMapVariantCover('canyon', -5, -25, 4.2, 2.8, 7, canyonCoverGeometries);
createMapVariantCover('canyon', 5, 25, 4.2, 2.8, 7, canyonCoverGeometries);
createMapVariantCover('canyon', -31, -17, 8, 5.5, 3.5, canyonCoverGeometries);
createMapVariantCover('canyon', 31, 17, 8, 5.5, 3.5, canyonCoverGeometries);
addMapVariantMesh(canyonCoverGeometries, new THREE.MeshLambertMaterial({ color: 0x8d7358 }), 'canyon');

const industrialCoverGeometries: THREE.BufferGeometry[] = [];
const industrialTrimGeometries: THREE.BufferGeometry[] = [];
createMapVariantCover('industrial', -19, 5, 4.2, 2.6, 5.2, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', 19, -5, 4.2, 2.6, 5.2, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', -7, -29, 6.4, 2.2, 2.6, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', 7, 29, 6.4, 2.2, 2.6, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', -30, 22, 3.2, 4.5, 9, industrialCoverGeometries, industrialTrimGeometries);
createMapVariantCover('industrial', 30, -22, 3.2, 4.5, 9, industrialCoverGeometries, industrialTrimGeometries);
addMapVariantMesh(industrialCoverGeometries, new THREE.MeshLambertMaterial({ color: 0x343c49 }), 'industrial');
addMapVariantMesh(industrialTrimGeometries, new THREE.MeshLambertMaterial({ color: 0x677c87 }), 'industrial');

// Passagem coberta da arena industrial. Apenas os pilares entram na colisão;
// vigas e teto ficam acima do tanque, portanto não criam uma parede invisível.
const tunnelFrame: THREE.BufferGeometry[] = [];
const tunnelLights: THREE.BufferGeometry[] = [];
for (const z of [-7, 7]) {
  for (const x of [-4, 4]) {
    const pillar = new THREE.BoxGeometry(1.1, 4.2, 1.1);
    pillar.translate(x, 2.1, z);
    tunnelFrame.push(pillar);
    obstacles.push({ center: new THREE.Vector3(x, 2.1, z), halfX: 0.55, halfZ: 0.55, height: 4.2, style: 'industrial' });
  }
  const beam = new THREE.BoxGeometry(9.1, 0.8, 1.2);
  beam.translate(0, 4.3, z);
  tunnelFrame.push(beam);
  const light = new THREE.BoxGeometry(4.8, 0.08, 0.55);
  light.translate(0, 3.82, z);
  tunnelLights.push(light);
}
const tunnelRoof = new THREE.BoxGeometry(8, 0.6, 13);
tunnelRoof.translate(0, 4.25, 0);
tunnelFrame.push(tunnelRoof);
addMapVariantMesh(tunnelFrame, new THREE.MeshLambertMaterial({ color: 0x343c49 }), 'industrial');
addMapVariantMesh(tunnelLights, new THREE.MeshBasicMaterial({ color: 0x8fd8d0 }), 'industrial');

const snowCoverGeometries: THREE.BufferGeometry[] = [];
createMapVariantCover('snow', -17, -12, 5.8, 2.7, 3.4, snowCoverGeometries);
createMapVariantCover('snow', 17, 12, 5.8, 2.7, 3.4, snowCoverGeometries);
createMapVariantCover('snow', -23, 7, 3.2, 3.2, 7.4, snowCoverGeometries);
createMapVariantCover('snow', 23, -7, 3.2, 3.2, 7.4, snowCoverGeometries);
createMapVariantCover('snow', -8, 31, 10, 2.2, 3.2, snowCoverGeometries);
createMapVariantCover('snow', 8, -31, 10, 2.2, 3.2, snowCoverGeometries);
addMapVariantMesh(snowCoverGeometries, new THREE.MeshLambertMaterial({ color: 0xb6c4ca }), 'snow');

// Novas arenas usam layouts de cobertura próprios para mudar linhas de tiro e rotas.
const harborGeometry: THREE.BufferGeometry[] = [];
const harborTrim: THREE.BufferGeometry[] = [];
for (const [x, z, w, d] of [[-15,-14,7,5], [15,14,7,5], [-27,1,4,11], [27,-1,4,11], [-7,27,11,4], [7,-27,11,4]] as number[][]) {
  createMapVariantCover('harbor', x, z, w, 2.4, d, harborGeometry, harborTrim);
}
addMapVariantMesh(harborGeometry, new THREE.MeshLambertMaterial({ color: 0x79654c }), 'harbor');
addMapVariantMesh(harborTrim, new THREE.MeshLambertMaterial({ color: 0xb28c52 }), 'harbor');

const volcanoGeometry: THREE.BufferGeometry[] = [];
for (const [x, z, w, h, d] of [[-13,-17,9,5,6], [13,17,9,5,6], [-27,0,5,4,12], [27,0,5,4,12], [-8,29,12,3.5,5], [8,-29,12,3.5,5]] as number[][]) {
  createMapVariantCover('volcano', x, z, w, h, d, volcanoGeometry);
}
addMapVariantMesh(volcanoGeometry, new THREE.MeshLambertMaterial({ color: 0x57413c }), 'volcano');

const cityGeometry: THREE.BufferGeometry[] = [];
for (const [x, z, w, h, d] of [[-17,-16,7,7,7], [17,16,7,7,7], [-28,3,5,5,10], [28,-3,5,5,10], [-5,29,10,4,5], [5,-29,10,4,5]] as number[][]) {
  createMapVariantCover('metropolis', x, z, w, h, d, cityGeometry);
}
addMapVariantMesh(cityGeometry, new THREE.MeshLambertMaterial({ color: 0x59636b }), 'metropolis');

const swampGeometry: THREE.BufferGeometry[] = [];
for (const [x, z, w, h, d] of [[-12,-22,8,2.5,5], [12,22,8,2.5,5], [-25,-8,5,3,10], [25,8,5,3,10], [-10,29,10,2,4], [10,-29,10,2,4]] as number[][]) {
  createMapVariantCover('swamp', x, z, w, h, d, swampGeometry);
}
addMapVariantMesh(swampGeometry, new THREE.MeshLambertMaterial({ color: 0x53634a }), 'swamp');

const moonGeometry: THREE.BufferGeometry[] = [];
for (const [x, z, w, h, d] of [[-16,-15,7,2.4,7], [16,15,7,2.4,7], [-28,2,4,3.2,11], [28,-2,4,3.2,11], [-7,29,11,2,4], [7,-29,11,2,4]] as number[][]) {
  createMapVariantCover('moon', x, z, w, h, d, moonGeometry);
}
addMapVariantMesh(moonGeometry, new THREE.MeshLambertMaterial({ color: 0x82878a }), 'moon');

function setMapLayout(style: MapStyle) {
  for (const [variant, meshes] of Object.entries(mapVariantMeshes) as [MapStyle, THREE.Object3D[]][]) {
    for (const mesh of meshes) mesh.visible = variant === style;
  }
}

addMapVariantMesh(obstacleGeometryBatch, buildingMaterial, 'field');
addMapVariantMesh(obstacleTrimGeometryBatch, buildingTrimMaterial, 'field');


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

const TANK_RADIUS = 0.92;

function canMoveTo(position: THREE.Vector3): boolean {
  if (
    Math.abs(position.x) > 53 ||
    Math.abs(position.z) > 53
  ) {
    return false;
  }

  for (const obstacle of obstacles) {
    if (obstacle.style && obstacle.style !== mapStyleName) continue;
    const dx = position.x - obstacle.center.x;
    const dz = position.z - obstacle.center.z;
    const angle = obstacle.rotation ?? 0;
    const localX = dx * Math.cos(angle) - dz * Math.sin(angle);
    const localZ = dx * Math.sin(angle) + dz * Math.cos(angle);
    if (obstacle.shape === 'ellipse') {
      const rx = Math.max(0.01, obstacle.halfX + TANK_RADIUS);
      const rz = Math.max(0.01, obstacle.halfZ + TANK_RADIUS);
      if ((localX * localX) / (rx * rx) + (localZ * localZ) / (rz * rz) < 1) return false;
    } else {
      const closestX = THREE.MathUtils.clamp(localX, -obstacle.halfX, obstacle.halfX);
      const closestZ = THREE.MathUtils.clamp(localZ, -obstacle.halfZ, obstacle.halfZ);
      const nearestX = localX - closestX;
      const nearestZ = localZ - closestZ;
      if (nearestX * nearestX + nearestZ * nearestZ < TANK_RADIUS * TANK_RADIUS) return false;
    }
  }

  return true;
}

// Só gerar os detalhes depois que TANK_RADIUS e canMoveTo estiverem inicializados.
addArenaInstancedDetails();

// =====================================================
// CONSTRUÇÃO DOS TANQUES
// =====================================================

type TankClass = 'light' | 'medium' | 'heavy' | 'artillery' | 'scout' | 'assault';

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
  scout: { label: 'Batedor', maxHealth: 62, speed: 1.48, damage: 0.78, fireRate: 0.72, armor: 0, acceleration: 1.7, turnRate: 1.5, hullScale: [0.78, 0.82, 0.82], turretScale: [0.7, 0.72, 0.74], barrelScale: [0.72, 0.75, 0.78] },
  medium: { label: 'Médio', maxHealth: 100, speed: 1, damage: 1, fireRate: 1, armor: 0.05, acceleration: 1, turnRate: 1, hullScale: [1, 1, 1], turretScale: [1, 1, 1], barrelScale: [1, 1, 1] },
  assault: { label: 'Vanguarda', maxHealth: 125, speed: 0.92, damage: 1.16, fireRate: 0.92, armor: 0.12, acceleration: 0.9, turnRate: 0.94, hullScale: [1.04, 1.02, 1.12], turretScale: [1.12, 1.05, 1.08], barrelScale: [1.05, 1.02, 1.12] },
  heavy: { label: 'Pesado', maxHealth: 160, speed: 0.72, damage: 1.35, fireRate: 1.35, armor: 0.22, acceleration: 0.68, turnRate: 0.66, hullScale: [1.18, 1.12, 1.12], turretScale: [1.28, 1.2, 1.28], barrelScale: [1.2, 1.2, 1.2] },
  artillery: { label: 'Artilharia', maxHealth: 85, speed: 0.82, damage: 1.65, fireRate: 1.55, armor: 0, acceleration: 0.78, turnRate: 0.72, hullScale: [1.05, 0.95, 1.12], turretScale: [0.92, 0.85, 0.92], barrelScale: [1.35, 1.1, 1.35] }
};

type ModelRig = {
  body: THREE.Object3D;
  turretNode: THREE.Object3D | null;
  weaponNodes: THREE.Object3D[];
  materials: THREE.MeshStandardMaterial[];
  muzzle: THREE.Vector3;
};

type TankParts = {
  root: THREE.Group;
  turret: THREE.Group;
  hull: THREE.Mesh;
  turretBody: THREE.Mesh;
  barrel: THREE.Mesh;
  weaponDetails: THREE.Group;
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
const MAX_ACTIVE_TANKS = 24;
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
const RAINBOW_PAINT_ID = 'rainbow-striped';
let playerPaintVariant: 'solid' | 'rainbow-striped' = 'solid';
let rainbowPaintTexture: THREE.CanvasTexture | null = null;
function getRainbowPaintTexture() {
  if (rainbowPaintTexture) return rainbowPaintTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const colors = ['#f04438', '#ff922b', '#ffd43b', '#51cf66', '#22b8cf', '#4c6ef5', '#be4bdb'];
  const stripeCount = 14;
  const stripe = canvas.width / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    context.fillStyle = colors[i % colors.length];
    context.beginPath();
    context.moveTo(i * stripe, 0); context.lineTo((i + 1) * stripe, 0);
    context.lineTo((i + 1) * stripe - 38, canvas.height); context.lineTo(i * stripe - 38, canvas.height);
    context.closePath(); context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 1);
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  rainbowPaintTexture = texture;
  const art = new Image();
  art.onload = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(art, 0, 0, canvas.width, canvas.height);
    texture.needsUpdate = true;
  };
  art.src = '/paint-previews/rainbow-striped.svg';
  return texture;
}
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
    scout: { width: 0.76, length: 0.82, height: 0.78, nose: 0.92 },
    medium: { width: 1, length: 1, height: 1, nose: 1 },
    assault: { width: 1.04, length: 1.08, height: 1.04, nose: 1.18 },
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
    scout: [[-0.42, 0.78], [0.42, 0.78], [0.62, 0.48], [0.58, -0.45], [0.32, -0.68], [-0.32, -0.68], [-0.58, -0.45], [-0.62, 0.48]],
    medium: [[-0.50, 0.76], [0.50, 0.76], [0.83, 0.43], [0.88, -0.43], [0.55, -0.77], [-0.55, -0.77], [-0.88, -0.43], [-0.83, 0.43]],
    assault: [[-0.62, 0.72], [0.62, 0.72], [0.91, 0.4], [0.98, -0.4], [0.69, -0.82], [-0.69, -0.82], [-0.98, -0.4], [-0.91, 0.4]],
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
  scout: makeHullGeometry('scout'),
  medium: makeHullGeometry('medium'),
  assault: makeHullGeometry('assault'),
  heavy: makeHullGeometry('heavy'),
  artillery: makeHullGeometry('artillery')
};
const turretGeometryByClass: Record<TankClass, THREE.ExtrudeGeometry> = {
  light: makeAngularTurretGeometry(0.95, 0.82, 0.50, 0.035, 'light'),
  scout: makeAngularTurretGeometry(0.82, 0.78, 0.40, 0.028, 'scout'),
  medium: makeAngularTurretGeometry(1.02, 0.91, 0.60, 0.045, 'medium'),
  assault: makeAngularTurretGeometry(1.08, 0.98, 0.64, 0.055, 'assault'),
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
  const weaponDetails = new THREE.Group();
  weaponDetails.name = 'WeaponDetails';
  weaponDetails.userData.garageGearProxy = true;
  turret.add(weaponDetails);

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
    root, turret, hull, turretBody, barrel, weaponDetails,
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

const weaponPlasmaRingGeometry = new THREE.TorusGeometry(0.25, 0.035, 8, 24);
const weaponPlasmaRingMaterial = new THREE.MeshBasicMaterial({ color: 0x65e9d4 });
const ricochetCollarGeometry = new THREE.TorusGeometry(0.27, 0.055, 8, 20);
function applyWeaponVisual(parts: TankParts, weapon: WeaponType, tankClass: TankClass) {
  const details = parts.weaponDetails;
  while (details.children.length) {
    const child = details.children.pop()!;
    details.remove(child);
  }
  const classScale = TANK_CLASSES[tankClass].barrelScale;
  parts.barrel.visible = weapon !== 'rapid';
  parts.barrel.rotation.x = Math.PI / 2 - (weapon === 'mortar' ? 0.2 : 0);
  parts.barrel.scale.set(...classScale);
  if (weapon === 'mortar') parts.barrel.scale.multiply(new THREE.Vector3(1.28, 1.28, 1.16));
  if (weapon === 'plasma') parts.barrel.scale.multiply(new THREE.Vector3(0.78, 0.78, 0.9));
  if (weapon === 'ricochet') parts.barrel.scale.multiply(new THREE.Vector3(1.2, 1.2, 0.82));
  if (weapon === 'rapid') {
    for (const side of [-1, 1]) {
      const barrel = new THREE.Mesh(barrelGeometry, darkMetalMaterial);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(side * 0.17, 0.28, -1.27);
      barrel.userData.recoilBaseZ = -1.27;
      barrel.scale.set(classScale[0] * 0.48, classScale[1] * 0.48, classScale[2] * 0.88);
      barrel.castShadow = true;
      details.add(barrel);
    }
  }
  if (weapon === 'plasma') {
    for (const z of [-1.65, -2.15]) {
      const ring = new THREE.Mesh(weaponPlasmaRingGeometry, weaponPlasmaRingMaterial);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(0, 0.28, z);
      details.add(ring);
    }
  }
  if (weapon === 'ricochet') {
    const collar = new THREE.Mesh(ricochetCollarGeometry, darkMetalMaterial);
    collar.rotation.y = Math.PI / 2;
    collar.position.set(0, 0.28, -2.05);
    details.add(collar);
  }
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
const MODEL_URLS: Partial<Record<TankClass, string>> = {
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
    if (child.userData.modelTurret || child === parts.weaponDetails || child === parts.barrel) continue;
    child.visible = visible;
  }
  parts.weaponDetails.visible = true;
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
  const rig: ModelRig = { body, turretNode: null, weaponNodes: [], materials: [], muzzle: DEFAULT_MUZZLE.clone() };

  body.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (/barrel|cannon|weapon|gun/i.test(mesh.name)) {
      mesh.visible = false;
      rig.weaponNodes.push(mesh);
    }
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
    if (PAINT_MATERIAL_NAME.test(name)) {
      if (playerPaintVariant === 'rainbow-striped') {
        clone.map = getRainbowPaintTexture();
        clone.color.setHex(0xffffff).multiplyScalar(typeof original.userData.shade === 'number' ? original.userData.shade : 1);
      } else {
        clone.map = getTankPaintTextures().map;
        clone.color.setHex(color).multiplyScalar(typeof original.userData.shade === 'number' ? original.userData.shade : 1);
      }
      clone.needsUpdate = true;
    }
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
  const roadColors: Record<MapStyle, number> = { field: 0xffedd1, desert: 0xd8b983, industrial: 0xc3ccd0, canyon: 0xd5b58d, snow: 0xd9e7ef, harbor: 0xa98f6c, volcano: 0x9d7668, metropolis: 0xb7bec2, swamp: 0xa2aa81, moon: 0x8d929d };
  const hillColors: Record<MapStyle, number> = { field: 0xffffff, desert: 0xd7c39a, industrial: 0x69767b, canyon: 0xc4956c, snow: 0xc3d2dc, harbor: 0x8b9a9b, volcano: 0x6d514b, metropolis: 0x91999d, swamp: 0x718263, moon: 0x707783 };
  const assetColors: Record<MapStyle, number> = { field: 0xd7dbc7, desert: 0xe8c99e, industrial: 0xd1dce4, canyon: 0xe5c29b, snow: 0xd1e5f5, harbor: 0xb7c7c1, volcano: 0xd39b7e, metropolis: 0xc2cbd0, swamp: 0xaebc8d, moon: 0xa9b2c3 };
  dirtRoadMaterial.color.setHex(roadColors[mapStyleName]);
  hillMaterial.color.setHex(hillColors[mapStyleName]);
  const assetTint = new THREE.Color(assetColors[mapStyleName]);
  for (const entry of battlefieldThemeMeshes) {
    entry.mesh.visible = mapStyleName === 'field';
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
        instance.rotation.y = 0;
        instance.scale.set(placement.sx, Math.min(placement.sx, placement.sz), placement.sz);
        instance.updateMatrixWorld(true);
        // Mantém o collider orientado como o modelo. A antiga caixa AABB
        // crescia bastante quando um objeto comprido era girado no cenário.
        const localBounds = new THREE.Box3().setFromObject(instance);
        const size = localBounds.getSize(new THREE.Vector3());
        const center = localBounds.getCenter(new THREE.Vector3());
        center.sub(instance.position).applyAxisAngle(worldUp, placement.yaw).add(instance.position);
        instance.rotation.y = placement.yaw;
        instance.updateMatrixWorld(true);
        worldBounds.push(new THREE.Box3().setFromObject(instance));
        obstacles.push({ center, halfX: size.x / 2, halfZ: size.z / 2, height: size.y, rotation: placement.yaw, style: 'field' });

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
    const file = MODEL_URLS[cls];
    if (!file) continue;
    loader.load(
      file,
      gltf => {
        modelTemplates.set(cls, prepareModelTemplate(gltf.scene, cls, file));
        console.info(`[Tank Arena] modelo carregado: ${file}`);
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
  canvas.width = 192; canvas.height = 32;
  const context = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(0, 3.45, 0);
  sprite.scale.set(3.05, 0.52, 1);
  root.add(sprite);
  let currentTeam = team;
  let lastHealth = 1, lastMaxHealth = 1;
  let lastRenderKey = '';
  const update = (health: number, maxHealth: number) => {
    lastHealth = health; lastMaxHealth = maxHealth;
    const ratio = THREE.MathUtils.clamp(health / Math.max(1, maxHealth), 0, 1);
    // Só redesenha a barra quando ela realmente muda (evita reenviar textura à GPU toa).
    // O número também precisa atualizar mesmo quando a barra não cruza outro percentual.
    const shownHealth = Math.ceil(Math.max(0, health));
    const shownMaxHealth = Math.ceil(maxHealth);
    const key = `${Math.round(ratio * 100)}:${shownHealth}:${shownMaxHealth}:${currentTeam}`;
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    context.clearRect(0, 0, 192, 32);
    context.fillStyle = 'rgba(7,10,12,.94)'; context.fillRect(1, 1, 190, 30);
    context.font = '700 12px Arial';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    context.fillStyle = '#edf1e7';
    context.fillText(`${shownHealth} / ${shownMaxHealth}`, 183, 10);
    const hue = Math.round(ratio * 118);
    context.fillStyle = '#2a3231';
    context.fillRect(6, 21, 180, 7);
    context.fillStyle = `hsl(${hue} 68% 46%)`;
    context.fillRect(6, 21, 180 * ratio, 7);
    context.fillStyle = currentTeam === 'black' ? '#c3a468' : '#83b8c2';
    context.fillRect(2, 3, 3, 26);
    context.strokeStyle = '#74817a';
    context.lineWidth = 1;
    context.strokeRect(1, 1, 190, 30);
    texture.needsUpdate = true;
  };
  const setTeam = (nextTeam: Team) => {
    currentTeam = nextTeam;
    lastRenderKey = '';
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
const rainbowLiveryTexture = getRainbowPaintTexture();
const rainbowLiveryMaterial = new THREE.MeshBasicMaterial({
  map: rainbowLiveryTexture,
  side: THREE.DoubleSide,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2
});
const rainbowLivery = new THREE.Group();
rainbowLivery.name = 'RainbowDiagonalLivery';
rainbowLivery.visible = false;
const rainbowTurretLivery = new THREE.Group();
rainbowTurretLivery.name = 'RainbowTurretLivery';
rainbowTurretLivery.visible = false;
function addRainbowStripePanel(parent: THREE.Object3D, width: number, height: number, position: [number, number, number], rotation: [number, number, number]) {
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), rainbowLiveryMaterial);
  panel.position.set(...position);
  panel.rotation.set(...rotation);
  panel.renderOrder = 4;
  panel.frustumCulled = false;
  parent.add(panel);
}
// Decal overlays guarantee that every visible side shows the full rainbow,
// independent of the UV layout used by the hull or imported tank model.
addRainbowStripePanel(rainbowLivery, 2.02, 3.0, [0, 1.68, 0], [-Math.PI / 2, 0, 0]);
addRainbowStripePanel(rainbowLivery, 2.75, 0.46, [-0.84, 0.96, 0], [0, -Math.PI / 2, 0]);
addRainbowStripePanel(rainbowLivery, 2.75, 0.46, [0.84, 0.96, 0], [0, Math.PI / 2, 0]);
addRainbowStripePanel(rainbowLivery, 1.3, 0.48, [0, 0.96, -1.58], [0, Math.PI, 0]);
player.add(rainbowLivery);
playerTurret.add(rainbowTurretLivery);
addRainbowStripePanel(rainbowTurretLivery, 1.15, 1.3, [0, 0.94, 0], [-Math.PI / 2, 0, 0]);
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
const UPGRADES_STORAGE_KEY = 'tank-arena-upgrades-v1';
const upgradeLevels = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(UPGRADES_STORAGE_KEY) ?? '{}');
    return {
      engine: Math.max(0, Math.floor(Number(saved.engine) || 0)),
      armor: Math.max(0, Math.floor(Number(saved.armor) || 0)),
      damage: Math.max(0, Math.floor(Number(saved.damage) || 0))
    };
  } catch { return { engine: 0, armor: 0, damage: 0 }; }
})();
let playerHealthBonus = upgradeLevels.armor * 20;
let playerSpeedBonus = upgradeLevels.engine * 0.1;
let playerArmorBonus = Math.min(0.35, upgradeLevels.armor * 0.1);
let playerMaxHealth = TANK_CLASSES[selectedTankClass].maxHealth + playerHealthBonus;
let playerHealth = playerMaxHealth;
const KILLS_STORAGE_KEY = 'tank-arena-kills-v1';
const startingKills = Number(localStorage.getItem(KILLS_STORAGE_KEY));
let playerKills = Number.isFinite(startingKills) && startingKills >= 0 ? startingKills : 0;
const CREDITS_STORAGE_KEY = 'tank-arena-credits-v1';
const startingCredits = Number(localStorage.getItem(CREDITS_STORAGE_KEY));
let playerCredits = Number.isFinite(startingCredits) && startingCredits >= 0 ? startingCredits : 0;
const CRYSTALS_STORAGE_KEY = 'tank-arena-crystals-v1';
const PAINTS_STORAGE_KEY = 'tank-arena-paints-v1';
const savedCrystals = localStorage.getItem(CRYSTALS_STORAGE_KEY);
const startingCrystals = savedCrystals === null ? Number.NaN : Number(savedCrystals);
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
  localStorage.setItem(CREDITS_STORAGE_KEY, String(playerCredits));
  localStorage.setItem(KILLS_STORAGE_KEY, String(playerKills));
  localStorage.setItem(PAINTS_STORAGE_KEY, JSON.stringify([...ownedPaints]));
  localStorage.setItem(UPGRADES_STORAGE_KEY, JSON.stringify(upgradeLevels));
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
let playerMoveMultiplier = Math.min(1.3, TANK_CLASSES[selectedTankClass].speed + playerSpeedBonus);
let playerDamageMultiplier = Math.min(1.6, 1 + upgradeLevels.damage * 0.15);
let playerArmor = Math.min(0.35, TANK_CLASSES[selectedTankClass].armor + playerArmorBonus);
type WeaponType = 'cannon' | 'rapid' | 'mortar' | 'plasma' | 'ricochet';
let selectedWeapon: WeaponType = 'cannon';
applyWeaponVisual(playerParts, selectedWeapon, selectedTankClass);
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

  const enemyClasses: TankClass[] = ['scout', 'light', 'medium', 'medium', 'assault', 'heavy', 'artillery'];
  const tankClass = enemyClasses[Math.floor(Math.random() * enemyClasses.length)];
  const parts = buildTank(teamBodyColor(team), tankClass, accentFor(team), enemies.length + 2);
  const botWeapon: WeaponType = tankClass === 'scout' || tankClass === 'light' ? 'rapid' : tankClass === 'artillery' ? 'mortar' : 'cannon';
  applyWeaponVisual(parts, botWeapon, tankClass);
  // Material próprio por bot para permitir paletas e pinturas independentes.
  parts.hull.material = (parts.hull.material as THREE.MeshLambertMaterial).clone();
  const maxHealth = tankClass === 'heavy' ? 5 : tankClass === 'assault' ? 4 : tankClass === 'light' || tankClass === 'scout' ? 2 : 3;
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
type GameMode = 'survival' | 'deathmatch' | 'ctf' | 'ffa';
let gameMode: GameMode = 'ctf';
// Participantes totais por partida; o jogador está incluído neste número.
let battleTeamSize = 6;
const areHostile = (a: Team, b: Team) => gameMode === 'ffa' || a !== b;
let matchTime = 180;
let matchEnded = false;
let battleHasStarted = false;
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
  saveLocalEconomy();
  waveBanner.textContent = `${message} · FUNDO ${battleFund} ◈ · SUA PARTE ${reward} ◈`;
  waveBannerTimer = 999999;
  updateHUD();
}

function spawnWave(amount: number) {
  let spawned = 0;
  const alliedCount = Math.min(amount - 1, Math.max(0, Math.floor(battleTeamSize / 2) - 1));
  for (let i = 0; i < amount; i++) {
    const team = i < alliedCount ? playerTeam : oppositeTeam(playerTeam);
    if (createEnemy(team)) spawned++;
  }
  return spawned;
}

function spawnRosterForMode() {
  clearEnemyRoster();
  if (onlineRoomId) {
    playerAlive = true;
    playerHealth = playerMaxHealth;
    player.visible = true;
    player.position.copy(findSafePlayerSpawn());
    previousPlayerPosition.copy(player.position);
    player.rotation.set(0, playerArenaHeading(), 0);
    playerLinearSpeed = 0;
    playerSpawnGrace = 3;
    invulnerability = 3;
    respawnTimer = 0;
    syncTankGearToWorld(playerParts);
    playerTeamHealthBar.update(playerHealth, playerMaxHealth);
    return;
  }
  if (gameMode === 'survival') {
    spawnWave(5);
    return;
  }
  if (gameMode === 'ffa') {
    for (let i = 1; i < battleTeamSize; i++) createEnemy(oppositeTeam(playerTeam));
    return;
  }
  const teamCount = Math.max(2, Math.floor(battleTeamSize / 2));
  if (gameMode === 'ctf') {
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
  for (let i = 1; i < teamCount; i++) createEnemy(playerTeam);
  for (let i = 0; i < teamCount; i++) createEnemy(oppositeTeam(playerTeam));
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
    <strong>TANK ARENA</strong>
    <span id="team-text">Time: Preto</span>
    <span id="health-text">Vida: 100 / 100</span>
    <div class="health-track"><div id="health-fill"></div></div>
    <span id="kills-text">Eliminações: 0</span>
    <span id="credits-text">Cristais: 500</span>
    <span id="weapon-text">Arma: Canhão (1)</span>
    <span id="wave-text">Onda: 1</span>
    <span id="ctf-objective">Objetivo: elimine os adversários</span>
    <span id="enemy-text">Inimigos: 5</span>
    <span id="power-text">Caixas: aguardando queda</span>
  </div>

  <div class="damage-number-layer" aria-hidden="true"></div>
  <div id="crosshair">+</div>
  <div id="hit-marker"></div>
  <div id="damage-flash"></div>

  <div id="help">
    WASD mover · mouse mirar · espaço disparar · 1–5 trocar arma · TAB placar<br>
    Z/X girar torre · C centralizar · Q/E câmera · G oficina · M menu · Delete autodestruição · ESC liberar cursor
  </div>

  <div id="respawn-message"></div>
  <div id="wave-banner"></div>

  <div id="garage" class="hidden">
    <div class="garage-shell">
      <header class="garage-topbar">
        <div class="garage-brand"><span class="garage-brand-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M6 25h36l-4 11H10zM12 19h19l5 6H11zM20 13h13l5 6H19zM3 38h42v3H3z"/></svg></span><div><b>TANK ARENA</b><small>CENTRO DE COMANDO</small></div></div>
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
          <button class="garage-nav-item" data-garage-tab="containers"><i>▤</i><span>CONTÊINERES</span></button>
          <div class="garage-nav-foot"><span class="garage-status-dot"></span> PERFIL LOCAL</div>
        </nav>
        <main class="garage-main">
          <section class="garage-showcase">
            <div class="garage-showcase-head"><div><small>HANGAR / VISUALIZAÇÃO</small><h2>MEU TANQUE</h2></div><span class="garage-live"><i></i> CAMPO ATIVO</span></div>
            <div id="garage-preview" class="garage-preview">
              <div class="preview-grid"></div><div class="preview-crosshair"></div>
              <div class="preview-label">VISUALIZAÇÃO 3D · MODELO ATUAL</div>
            <div class="preview-bottom"><span id="preview-class">TANQUE MÉDIO</span><span>↔ ARRASTE PARA INSPECIONAR</span></div>
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
              <select id="tank-class"><option value="scout">Batedor — veloz e ágil</option><option value="light">Leve — rápido, pouca blindagem</option><option value="medium" selected>Médio — equilibrado</option><option value="assault">Vanguarda — ataque e blindagem</option><option value="heavy">Pesado — blindado e forte</option><option value="artillery">Artilharia — alcance e área</option></select>
              <div class="garage-stat-grid"><div><small>FUNÇÃO</small><b id="garage-role">VERSÁTIL</b></div><div><small>RESISTÊNCIA</small><b id="garage-health-stat">100 HP</b></div></div>
            </div>
            <div class="garage-section" data-garage-section="armament">
              <div class="garage-section-head"><small>02 / ARMAMENTO</small><h3>Torre instalada</h3><p>Escolha entre impacto pesado e disparo rápido. A seleção vale imediatamente na partida local.</p></div>
              <label for="tank-weapon">ARMA PRINCIPAL</label>
              <select id="tank-weapon"><option value="cannon">Canhão · impacto preciso</option><option value="rapid">Autocanhão · rajada rápida</option><option value="mortar">Obuseiro · arco e explosão</option><option value="plasma">Emissor de plasma · pulso direto</option><option value="ricochet">Ricochete · projétil refletor</option></select>
              <div class="garage-stat-grid"><div><small>MUNIÇÃO</small><b>INFINITA</b></div><div><small>ALTERAÇÃO</small><b>SEM CUSTO</b></div></div>
            </div>
            <div class="garage-section" data-garage-section="paint">
              <div class="garage-section-head"><small>03 / IDENTIDADE VISUAL</small><h3>Pintura e equipe</h3><p>A pintura é independente do time e não altera os atributos.</p></div>
              <label for="team-select">EQUIPE DE COMBATE</label>
              <select id="team-select"><option value="black" selected>Time Preto</option><option value="white">Time Branco</option></select>
              <label for="tank-color">COR DA CARROCERIA</label>
              <select id="tank-color"><option value="0x5c6240">Oliva fosco</option><option value="0x2867b2">Azul</option><option value="0xb33a32">Vermelho</option><option value="0xaaaaaa">Prata</option><option value="0xd1a52c">Dourado</option><option value="0x663399">Roxo</option><option value="0xe5e5e5">Branco</option><option value="0x171717">Preto</option><option value="0xe87524">Laranja</option><option value="0x273927">Floresta</option><option value="0x76533c">Deserto</option><option value="0x375f72">Gelo profundo</option><option value="0x6c374f">Vinho</option><option value="0x37434b">Grafite</option><option value="0xeee5ce">Areia clara</option><option value="0x138e80">Jade</option><option value="0x713f9f">Ametista</option><option value="rainbow-striped">Arco-íris listrado · contêiner</option></select>
              <label for="tank-style">ESTILO DA TORRE</label>
              <select id="tank-style"><option value="normal">Padrão</option><option value="heavy">Pesada</option><option value="slim">Compacta</option></select>
            </div>
            <div class="garage-section" data-garage-section="equipment">
              <div class="garage-section-head"><small>04 / MELHORIAS</small><h3>Equipamentos</h3><p>Instale melhorias permanentes usando seus créditos locais.</p></div>
              <label for="tank-upgrade">MELHORIA · 50 CRÉDITOS · +10 POR ELIMINAÇÃO</label>
              <select id="tank-upgrade"><option value="none">Selecionar equipamento...</option><option value="engine">Motor: +10% velocidade</option><option value="armor">Blindagem: +20 vida máxima</option><option value="damage">Canhão: +15% dano</option></select>
              <button id="upgrade-buy" class="garage-secondary-action">INSTALAR MELHORIA</button>
            </div>
            <div class="garage-section" data-garage-section="graphics">
              <div class="garage-section-head"><small>05 / RENDERIZAÇÃO</small><h3>Qualidade gráfica</h3><p>Ultra ativa sombras dinâmicas, antisserrilhado e correção de cor; Alto equilibra detalhe e desempenho.</p></div>
              <label for="graphics-quality">PREDEFINIÇÃO VISUAL</label>
              <select id="graphics-quality"><option value="balanced">Equilibrado</option><option value="high">Alto · resolução nativa</option><option value="maximum">Ultra · sombras e pós-processamento</option></select>
            </div>
            <div class="garage-section" data-garage-section="battle">
              <div class="garage-section-head"><small>06 / OPERAÇÃO</small><h3>Configuração da partida</h3><p>Modo, mapa e quantidade de participantes são definidos separadamente.</p></div>
              <label for="garage-player-count">JOGADORES NA PARTIDA</label>
              <select id="garage-player-count"><option value="2">2 jogadores</option><option value="4">4 jogadores</option><option value="6" selected>6 jogadores</option><option value="8">8 jogadores</option><option value="10">10 jogadores</option></select>
              <label for="map-style">ARENA</label>
              <select id="map-style"><option value="field">Campo de operações</option><option value="desert">Dunas</option><option value="industrial">Complexo industrial</option><option value="canyon">Desfiladeiro</option><option value="snow">Base glacial</option><option value="harbor">Porto de carga</option><option value="volcano">Cratera vulcânica</option><option value="metropolis">Zona urbana</option><option value="swamp">Pântano</option><option value="moon">Estação lunar</option></select>
              <label for="lighting-mode">ILUMINAÇÃO</label>
              <select id="lighting-mode"><option value="day">Dia</option><option value="night">Noite</option></select>
              <label for="game-mode">MODO DE JOGO</label>
              <select id="game-mode"><option value="ctf" selected>Rouba-Bandeira · equipes</option><option value="deathmatch">Mata-mata · equipes</option><option value="ffa">Cada tanque por si</option><option value="survival">Sobrevivência · ondas</option></select>
            </div>
            <div class="garage-section" data-garage-section="containers">
              <div class="garage-section-head"><small>07 / SUPRIMENTOS</small><h3>Contêineres</h3><p>Abra um contêiner com cristais para desbloquear uma pintura para seu tanque.</p></div>
              <div class="container-card"><div class="container-crate-art">✚</div><div><small>CONTÊINER DE CAMPO</small><b>Uma pintura aleatória</b><span>Itens duplicados devolvem parte do custo em cristais.</span></div><strong>100 ◈</strong></div>
              <button id="open-container" class="garage-secondary-action">ABRIR CONTÊINER · 100 CRISTAIS</button>
              <div id="container-result" class="container-result" aria-live="polite">Saldo: <b id="container-crystals">500</b> cristais</div>
            </div>
            <div class="garage-footnote"><b>PROTOCOLO DE COMBATE</b><br>Oficina opcional · respawn automático por equipe · fogo amigo desativado · equipes preto e branco · bots preparados para alvos humanos e IA.</div>
          </section>
        </main>
      </div>
      <footer class="garage-footer"><span> TANK ARENA <small>· OFICINA DE CAMPO</small></span><span id="garage-status">PRONTO PARA COMBATE</span></footer>
    </div>
  </div>
`;
document.body.appendChild(hud);
type DamageNumberSlot = { element: HTMLDivElement; position: THREE.Vector3; startedAt: number; drift: number; active: boolean };
const damageNumberLayer = hud.querySelector<HTMLDivElement>('.damage-number-layer')!;
const damageNumberSlots: DamageNumberSlot[] = Array.from({ length: 24 }, () => {
  const element = document.createElement('div');
  element.className = 'damage-number';
  element.hidden = true;
  damageNumberLayer.appendChild(element);
  return { element, position: new THREE.Vector3(), startedAt: 0, drift: 0, active: false };
});
let nextDamageNumberSlot = 0;
const damageNumberScreen = new THREE.Vector3();
function spawnDamageNumber(position: THREE.Vector3, amount: number) {
  if (mainMenuOpen || garageOpen || amount <= 0) return;
  const slot = damageNumberSlots[nextDamageNumberSlot++ % damageNumberSlots.length];
  slot.position.copy(position);
  slot.position.y += 2.45;
  slot.startedAt = performance.now();
  slot.drift = ((nextDamageNumberSlot % 5) - 2) * 14;
  slot.active = true;
  slot.element.textContent = `-${Math.max(1, Math.round(amount))}`;
  slot.element.classList.toggle('heavy', amount >= 25);
  slot.element.hidden = false;
}
function updateDamageNumbers(now: number) {
  const width = window.innerWidth, height = window.innerHeight;
  for (const slot of damageNumberSlots) {
    if (!slot.active) continue;
    const age = (now - slot.startedAt) / 1050;
    if (age >= 1) { slot.active = false; slot.element.hidden = true; continue; }
    damageNumberScreen.copy(slot.position).project(camera);
    if (damageNumberScreen.z < -1 || damageNumberScreen.z > 1) { slot.element.hidden = true; continue; }
    slot.element.hidden = false;
    const x = (damageNumberScreen.x * 0.5 + 0.5) * width + slot.drift * age;
    const y = (-damageNumberScreen.y * 0.5 + 0.5) * height - 38 * age;
    slot.element.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-50%) scale(${1 - age * 0.1})`;
    slot.element.style.opacity = String(Math.min(1, (1 - age) * 2.6));
  }
}
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
    <div class="main-menu-brand"><span class="main-menu-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M6 25h36l-4 11H10zM12 19h19l5 6H11zM20 13h13l5 6H19zM3 38h42v3H3z"/></svg></span><div><b>TANK ARENA</b><small>COMBATE TÁTICO 3D</small></div></div>
      <button id="main-menu-leave-header" class="main-menu-secondary" type="button">SAIR DA BATALHA</button>
      <button id="main-menu-resume" type="button">VOLTAR À BATALHA</button>
    </header>
    <div class="main-menu-body">
      <nav class="main-menu-nav" aria-label="Navegação principal">
        <button class="active" data-menu-panel="battle"><i>⌖</i><span>BATALHA</span></button>
        <button data-menu-action="garage"><i>▣</i><span>GARAGEM</span></button>
        <button data-menu-panel="settings"><i>◉</i><span>OPÇÕES</span></button>
        <div class="main-menu-nav-footer online-nav-status"><i></i><span id="online-connection-status">CONECTANDO AO SERVIDOR</span></div>
      </nav>
      <main class="main-menu-content">
        <section class="main-menu-panel active" data-menu-section="battle">
          <div class="main-menu-eyebrow">CENTRO DE COMBATE / TREINO LOCAL</div>
          <h1>Escolha sua arena</h1>
          <p>Selecione um cenário e entre em combate contra a inteligência artificial.</p>
          <div class="battle-browser-view">
            <div class="battle-toolbar"><div class="battle-filter-tabs" role="group" aria-label="Filtrar batalhas"><button class="active" data-battle-filter="all">TODAS</button><button data-battle-filter="ctf">CAPTURA</button><button data-battle-filter="deathmatch">EQUIPES</button><button data-battle-filter="ffa">CADA UM POR SI</button><button data-battle-filter="survival">SOBREVIVÊNCIA</button></div><label class="battle-search"><span>⌕</span><input id="battle-search-input" type="search" placeholder="Buscar arena" aria-label="Buscar arena"></label></div>
            <div class="battle-list-layout"><div class="battle-browser-left"><div class="local-battle-list"><header><b>CENÁRIOS LOCAIS</b><span>TREINO CONTRA IA</span></header>
              <div class="battle-list-columns"><span>MAPA / MODO</span><span>BOTS</span><span>STATUS</span></div>
              <button class="local-battle-row active" data-join-mode="ctf" data-join-map="harbor" data-team-size="6"><img class="battle-map-thumb" src="/map-previews/harbor.svg" alt=""><span><b>Porto de Carga</b><small>ROUBA-BANDEIRA · DIA</small></span><i class="battle-population">5 BOTS</i><strong>PRONTO</strong></button>
              <button class="local-battle-row" data-join-mode="deathmatch" data-join-map="metropolis" data-team-size="6"><img class="battle-map-thumb" src="/map-previews/metropolis.svg" alt=""><span><b>Zona Urbana</b><small>MATA-MATA EM EQUIPE · DIA</small></span><i class="battle-population">5 BOTS</i><strong>PRONTO</strong></button>
              <button class="local-battle-row" data-join-mode="survival" data-join-map="volcano" data-team-size="6"><img class="battle-map-thumb" src="/map-previews/volcano.svg" alt=""><span><b>Cratera Vulcânica</b><small>SOBREVIVÊNCIA · NOITE</small></span><i class="battle-population">5 BOTS</i><strong>PRONTO</strong></button>
              <button class="local-battle-row" data-join-mode="ctf" data-join-map="snow" data-team-size="10"><img class="battle-map-thumb" src="/map-previews/snow.svg" alt=""><span><b>Base Glacial</b><small>ROUBA-BANDEIRA · DIA</small></span><i class="battle-population">9 BOTS</i><strong>PRONTO</strong></button>
              <button class="local-battle-row" data-join-mode="ffa" data-join-map="industrial" data-team-size="6"><img class="battle-map-thumb" src="/map-previews/industrial.svg" alt=""><span><b>Complexo Industrial</b><small>CADA TANQUE POR SI · NOITE</small></span><i class="battle-population">5 BOTS</i><strong>PRONTO</strong></button>
              <div class="battle-empty-state" hidden>Nenhuma sala corresponde à busca.</div>
            </div><section class="online-room-list"><header><b>SALAS ONLINE</b><div class="online-room-actions"><span id="online-room-count">CONECTANDO</span><button id="quick-create-online-room" type="button">＋ SALA</button></div></header><div id="online-room-rows"><div class="online-room-empty">Conectando ao servidor de partidas…</div></div></section></div><aside class="battle-details"><div class="battle-details-banner harbor" id="battle-details-banner"><img id="battle-details-image" src="/map-previews/harbor.svg" alt="Prévia do Porto de Carga"><span>ARENA EM DESTAQUE</span><b id="battle-detail-map">Porto de Carga</b></div><div class="battle-details-body"><small id="battle-detail-mode">ROUBA-BANDEIRA · DIA</small><h2>Detalhes da batalha</h2><p id="battle-detail-description">Capture a bandeira inimiga e retorne à sua base. Treino local contra bots.</p><div class="battle-detail-stats"><span>BOTS NA PARTIDA<b id="battle-detail-players">5 BOTS</b></span><span>REDE<b>LOCAL</b></span><span>ACESSO<b>LIVRE</b></span></div><button id="join-selected-battle" class="main-menu-play" type="button">▶ &nbsp; INICIAR PARTIDA</button><button id="create-battle-open" class="battle-create-open" type="button"><span>＋</span> CRIAR BATALHA</button></div></aside></div>
            <footer class="battle-browser-footer"><span><i></i> SIMULAÇÃO OFFLINE</span><span>OS PARTICIPANTES SÃO CONTROLADOS POR IA</span></footer>
          </div>
          <div class="battle-create-view" hidden>
            <header class="battle-create-top"><button class="battle-back-button" id="battle-create-back" type="button">← VOLTAR À LISTA</button><div><small>CONFIGURAR PARTIDA</small><h2>Configure a sua arena</h2></div><span><i></i> TREINO OU SALA ONLINE</span></header>
            <div class="battle-create-layout">
              <section class="create-mode-picker"><header><b>1</b><div><strong>Modo de jogo</strong><small>Escolha as regras da partida</small></div></header>
                <div class="create-mode-options">
                  <button class="create-mode-card active" data-create-mode="ctf" type="button"><i>⚑</i><span><b>Rouba-Bandeira</b><small>Capture a bandeira inimiga e proteja a sua.</small></span></button>
                  <button class="create-mode-card" data-create-mode="deathmatch" type="button"><i>⚔</i><span><b>Mata-mata em equipes</b><small>Dois times disputam eliminações.</small></span></button>
                  <button class="create-mode-card" data-create-mode="ffa" type="button"><i>◎</i><span><b>Cada tanque por si</b><small>Todos contra todos. Sem aliados.</small></span></button>
                  <button class="create-mode-card" data-create-mode="survival" type="button"><i>⌁</i><span><b>Sobrevivência</b><small>Resista às ondas de tanques inimigos.</small></span></button>
                </div>
              </section>
              <section class="create-map-picker"><header><b>2</b><div><strong>Mapa da batalha</strong><small>Selecione uma arena</small></div><span>10 MAPAS</span></header>
                <div class="create-map-options">
                  <button class="create-map-card" data-create-map="field" type="button"><img src="/map-previews/field.svg" alt=""><b>Campo</b></button>
                  <button class="create-map-card" data-create-map="desert" type="button"><img src="/map-previews/desert.svg" alt=""><b>Dunas</b></button>
                  <button class="create-map-card" data-create-map="industrial" type="button"><img src="/map-previews/industrial.svg" alt=""><b>Industrial</b></button>
                  <button class="create-map-card" data-create-map="canyon" type="button"><img src="/map-previews/canyon.svg" alt=""><b>Desfiladeiro</b></button>
                  <button class="create-map-card" data-create-map="snow" type="button"><img src="/map-previews/snow.svg" alt=""><b>Glacial</b></button>
                  <button class="create-map-card" data-create-map="harbor" type="button"><img src="/map-previews/harbor.svg" alt=""><b>Porto</b></button>
                  <button class="create-map-card" data-create-map="volcano" type="button"><img src="/map-previews/volcano.svg" alt=""><b>Vulcânica</b></button>
                  <button class="create-map-card" data-create-map="metropolis" type="button"><img src="/map-previews/metropolis.svg" alt=""><b>Urbana</b></button>
                  <button class="create-map-card" data-create-map="swamp" type="button"><img src="/map-previews/swamp.svg" alt=""><b>Pântano</b></button>
                  <button class="create-map-card" data-create-map="moon" type="button"><img src="/map-previews/moon.svg" alt=""><b>Lunar</b></button>
                </div>
              </section>
              <aside class="create-battle-settings"><img id="create-map-preview" src="/map-previews/harbor.svg" alt="Prévia do mapa selecionado"><div class="create-map-caption"><small>MAPA SELECIONADO</small><b id="create-map-name">Porto de Carga</b><span id="main-menu-objective">Capture a bandeira inimiga e retorne à sua base</span></div>
                <label>3 · NÚMERO DE JOGADORES<select id="main-menu-team-size"><option value="2">2 jogadores</option><option value="4">4 jogadores</option><option value="6" selected>6 jogadores</option><option value="8">8 jogadores</option><option value="10">10 jogadores</option></select></label>
                <label>ILUMINAÇÃO<select id="main-menu-lighting"><option value="day">Dia</option><option value="night">Noite</option></select></label>
                <label>NOME DA BATALHA<input id="battle-room-name" maxlength="28" placeholder="Treino local"></label>
                <div class="create-mode-warning">Inicie um treino local contra bots ou abra uma sala online para jogar com outras pessoas conectadas a este servidor.</div>
              </aside>
            </div>
            <select id="main-menu-mode" class="create-native-source" aria-hidden="true" tabindex="-1"><option value="ctf">Rouba-Bandeira</option><option value="deathmatch">Mata-mata em equipes</option><option value="ffa">Cada tanque por si</option><option value="survival">Sobrevivência</option></select>
            <select id="main-menu-map" class="create-native-source" aria-hidden="true" tabindex="-1"><option value="field">Campo de operações</option><option value="desert">Dunas</option><option value="industrial">Complexo industrial</option><option value="canyon">Desfiladeiro</option><option value="snow">Base glacial</option><option value="harbor">Porto de carga</option><option value="volcano">Cratera vulcânica</option><option value="metropolis">Zona urbana</option><option value="swamp">Pântano</option><option value="moon">Estação lunar</option></select>
            <footer class="battle-create-footer"><button id="main-menu-garage" class="main-menu-secondary" type="button">OFICINA</button><button id="main-menu-leave" class="main-menu-secondary" type="button">SAIR DA BATALHA</button><button id="main-menu-play" class="main-menu-play" type="button">INICIAR TREINO LOCAL　➜</button><button id="create-online-room" class="online-create-button" type="button">CRIAR SALA ONLINE</button></footer>
          </div>
        </section>
        <section class="main-menu-panel" data-menu-section="settings">
          <div class="main-menu-eyebrow">SISTEMA / CONFIGURAÇÃO LOCAL</div><h1>Opções do jogo</h1>
          <p>Ajustes aplicados imediatamente nesta sessão. A resolução nativa e as texturas são preservadas em todos os perfis.</p>
          <label class="main-menu-mode-card"><small>DESEMPENHO E QUALIDADE</small><select id="main-menu-quality"><option value="maximum">Ultra · sombras e pós-processamento</option><option value="high">Alto · resolução nativa</option><option value="balanced">Equilibrado</option></select></label>
          <div class="main-menu-briefing"><small>CONTROLES</small><b>WASD movimenta · mouse mira · espaço dispara</b><span>1–5 troca arma · G abre a oficina · M abre o menu · TAB placar · F4 telemetria</span></div>
        </section>
      </main>
    </div>
  </div>`;
document.body.appendChild(mainMenu);

type OnlineRoom = { id: string; name: string; mode: GameMode; map: MapStyle; lighting: 'day' | 'night'; maxPlayers: number; players: number };
type OnlineRemote = {
  id: string;
  name: string;
  team: Team;
  tankClass: TankClass;
  parts: TankParts;
  healthBar: TeamHealthBar;
  targetPosition: THREE.Vector3;
  targetRotation: number;
  targetTurret: number;
  health: number;
  alive: boolean;
};
const onlineRemotes = new Map<string, OnlineRemote>();
const onlineRoomRows = mainMenu.querySelector<HTMLDivElement>('#online-room-rows')!;
const onlineConnectionStatus = mainMenu.querySelector<HTMLElement>('#online-connection-status')!;
const onlineRoomCount = mainMenu.querySelector<HTMLElement>('#online-room-count')!;
let onlineSocket: WebSocket | null = null;
let onlinePlayerId = '';
let onlineRoomId = '';
let onlinePendingStart = false;
let onlineStateTimer = 0;

function onlineSend(payload: unknown) {
  if (onlineSocket?.readyState === WebSocket.OPEN) onlineSocket.send(JSON.stringify(payload));
}

function updateOnlineStatus(text: string, connected: boolean) {
  onlineConnectionStatus.textContent = text;
  onlineConnectionStatus.parentElement?.classList.toggle('offline', !connected);
}

function renderOnlineRooms(rooms: OnlineRoom[]) {
  onlineRoomCount.textContent = rooms.length ? `${rooms.length} ${rooms.length === 1 ? 'SALA' : 'SALAS'}` : 'NENHUMA SALA';
  onlineRoomRows.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement('div');
    empty.className = 'online-room-empty';
    empty.textContent = 'Nenhuma sala aberta. Crie uma e convide seus amigos.';
    onlineRoomRows.appendChild(empty);
    return;
  }
  for (const room of rooms) {
    const row = document.createElement('article');
    row.className = 'online-room-row';
    const info = document.createElement('div');
    const name = document.createElement('b'); name.textContent = room.name;
    const detail = document.createElement('small');
    detail.textContent = `${battleModeNames[room.mode] ?? room.mode.toUpperCase()} · ${battleMapNames[room.map] ?? room.map} · ${room.lighting === 'night' ? 'NOITE' : 'DIA'}`;
    info.append(name, detail);
    const count = document.createElement('span'); count.className = 'online-room-population'; count.textContent = `${room.players}/${room.maxPlayers}`;
    const join = document.createElement('button'); join.type = 'button'; join.className = 'online-room-join'; join.dataset.roomId = room.id;
    join.textContent = room.players >= room.maxPlayers ? 'CHEIA' : 'ENTRAR';
    join.disabled = room.players >= room.maxPlayers;
    row.append(info, count, join);
    onlineRoomRows.appendChild(row);
  }
}

function ensureOnlineRemote(id: string, name: string, team: Team): OnlineRemote {
  const existing = onlineRemotes.get(id);
  if (existing) { existing.name = name; existing.team = team; return existing; }
  const tankClass: TankClass = 'medium';
  const parts = buildTank(teamBodyColor(team), tankClass, accentFor(team), 20 + onlineRemotes.size);
  parts.root.visible = true;
  parts.root.position.copy(teamBasePosition(team));
  scene.add(parts.root);
  const healthBar = createTeamHealthBar(parts.root, team);
  const remote: OnlineRemote = {
    id, name, team, tankClass, parts, healthBar, targetPosition: parts.root.position.clone(),
    targetRotation: 0, targetTurret: 0, health: TANK_CLASSES[tankClass].maxHealth, alive: true
  };
  onlineRemotes.set(id, remote);
  return remote;
}

function applyOnlinePlayerState(playerState: any) {
  if (!playerState || playerState.id === onlinePlayerId) return;
  const team: Team = playerState.team === 'white' ? 'white' : 'black';
  const remote = ensureOnlineRemote(String(playerState.id), String(playerState.name ?? 'Comandante'), team);
  const validClass = playerState.tankClass as TankClass;
  if (TANK_CLASSES[validClass] && validClass !== remote.tankClass) {
    remote.tankClass = validClass;
    applyTankModel(remote.parts, validClass, teamBodyColor(team), accentFor(team));
  } else if (!remote.parts.model && modelTemplates.has(remote.tankClass)) {
    applyTankModel(remote.parts, remote.tankClass, teamBodyColor(team), accentFor(team));
  }
  remote.targetPosition.set(playerState.x, playerState.y, playerState.z);
  remote.targetRotation = Number(playerState.rotation) || 0;
  remote.targetTurret = Number(playerState.turret) || 0;
  remote.health = Number(playerState.health) || 0;
  remote.alive = playerState.alive !== false;
  remote.parts.root.visible = remote.alive;
  remote.healthBar.setTeam(team);
  remote.healthBar.update(remote.health, TANK_CLASSES[remote.tankClass].maxHealth);
}

function removeOnlineRemote(id: string) {
  const remote = onlineRemotes.get(id);
  if (!remote) return;
  scene.remove(remote.parts.root);
  remote.healthBar.sprite.material.dispose();
  if (remote.parts.model) removeTankModel(remote.parts);
  releaseTankGearSlot(remote.parts.gearSlot);
  onlineRemotes.delete(id);
}

function updateOnlineRemotes(delta: number) {
  const blend = 1 - Math.exp(-14 * delta);
  for (const remote of onlineRemotes.values()) {
    remote.parts.root.position.lerp(remote.targetPosition, blend);
    remote.parts.root.rotation.y += angleDifference(remote.parts.root.rotation.y, remote.targetRotation) * blend;
    remote.parts.turret.rotation.y += angleDifference(remote.parts.turret.rotation.y, remote.targetTurret) * blend;
  }
  if (onlineRoomId && onlineSocket?.readyState === WebSocket.OPEN) {
    onlineStateTimer += delta;
    if (onlineStateTimer >= 0.1) {
      onlineStateTimer = 0;
      onlineSend({ type: 'player-state', state: {
        x: player.position.x, y: player.position.y, z: player.position.z,
        rotation: player.rotation.y, turret: playerTurret.rotation.y, team: playerTeam,
        tankClass: selectedTankClass, health: playerHealth, alive: playerAlive
      } });
    }
  }
}

function joinOnlineRoom(roomId: string) {
  if (onlineSocket?.readyState !== WebSocket.OPEN) {
    updateOnlineStatus('SERVIDOR INDISPONÍVEL', false);
    return;
  }
  onlinePendingStart = true;
  onlineSend({ type: 'join-room', roomId });
}

onlineRoomRows.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.online-room-join');
  if (button?.dataset.roomId) joinOnlineRoom(button.dataset.roomId);
});
function createOnlineRoom() {
  if (onlineSocket?.readyState !== WebSocket.OPEN) {
    updateOnlineStatus('SERVIDOR INDISPONÍVEL', false);
    return;
  }
  onlinePendingStart = true;
  onlineSend({ type: 'create-room',
    name: (document.getElementById('battle-room-name') as HTMLInputElement).value,
    mode: (document.getElementById('main-menu-mode') as HTMLSelectElement).value,
    map: (document.getElementById('main-menu-map') as HTMLSelectElement).value,
    lighting: (document.getElementById('main-menu-lighting') as HTMLSelectElement).value,
    maxPlayers: (document.getElementById('main-menu-team-size') as HTMLSelectElement).value
  });
}
(document.getElementById('create-online-room') as HTMLButtonElement).addEventListener('click', createOnlineRoom);
(document.getElementById('quick-create-online-room') as HTMLButtonElement).addEventListener('click', createOnlineRoom);

function connectOnlineLobby() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    onlineSocket = new WebSocket(`${protocol}//${location.host}/__tank_arena_online`);
    onlineSocket.addEventListener('open', () => updateOnlineStatus('SERVIDOR ONLINE', true));
    onlineSocket.addEventListener('message', event => {
      let message: any;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'welcome') {
        onlinePlayerId = message.playerId;
        renderOnlineRooms(message.rooms ?? []);
      } else if (message.type === 'rooms') {
        renderOnlineRooms(message.rooms ?? []);
      } else if (message.type === 'room-joined') {
        onlineRoomId = message.room.id;
        (document.getElementById('main-menu-play') as HTMLButtonElement).textContent = 'INICIAR PARTIDA ONLINE　➜';
        const teamSelect = document.getElementById('team-select') as HTMLSelectElement;
        teamSelect.value = message.youTeam === 'white' ? 'white' : 'black';
        teamSelect.dispatchEvent(new Event('change', { bubbles: true }));
        const modeSelect = document.getElementById('main-menu-mode') as HTMLSelectElement;
        modeSelect.value = message.room.mode;
        const mapSelect = document.getElementById('main-menu-map') as HTMLSelectElement;
        mapSelect.value = message.room.map;
        (document.getElementById('main-menu-team-size') as HTMLSelectElement).value = String(message.room.maxPlayers);
        (document.getElementById('main-menu-lighting') as HTMLSelectElement).value = message.room.lighting;
        (document.getElementById('battle-room-name') as HTMLInputElement).value = message.room.name;
        for (const peer of message.players ?? []) applyOnlinePlayerState({ ...peer, x: teamBasePosition(peer.team === 'white' ? 'white' : 'black').x, y: 0, z: teamBasePosition(peer.team === 'white' ? 'white' : 'black').z, rotation: 0, turret: 0, health: 100, alive: true, tankClass: 'medium' });
        updateOnlineStatus(`SALA ${onlineRoomId}`, true);
        if (onlinePendingStart) {
          onlinePendingStart = false;
          (document.getElementById('main-menu-play') as HTMLButtonElement).click();
        }
      } else if (message.type === 'player-joined') {
        const peer = message.player;
        const base = teamBasePosition(peer.team === 'white' ? 'white' : 'black');
        applyOnlinePlayerState({ ...peer, x: base.x, y: 0, z: base.z, rotation: 0, turret: 0, health: 100, alive: true, tankClass: 'medium' });
      } else if (message.type === 'player-state') {
        applyOnlinePlayerState(message.player);
      } else if (message.type === 'player-left') {
        removeOnlineRemote(String(message.playerId));
      } else if (message.type === 'player-fire') {
        const shot = message.shot;
        const team: Team = message.team === 'white' ? 'white' : 'black';
        createProjectile(new THREE.Vector3(shot.x, shot.y, shot.z), new THREE.Vector3(shot.dx, shot.dy, shot.dz), 'enemy', shot.damage, team, null, shot.weapon, shot.tankClass);
      } else if (message.type === 'remote-hit') {
        if (onlineRoomId && playerAlive) damagePlayer(message.damage, false, new THREE.Vector3(message.direction.x, message.direction.y, message.direction.z));
      } else if (message.type === 'join-error' || message.type === 'error') {
        onlinePendingStart = false;
        updateOnlineStatus(message.message ?? 'ERRO DE CONEXÃO', true);
        respawnMessage.textContent = message.message ?? 'Não foi possível entrar na sala.';
        window.setTimeout(() => { respawnMessage.textContent = ''; }, 2400);
      }
    });
    onlineSocket.addEventListener('close', () => {
      onlineRoomId = '';
      for (const id of [...onlineRemotes.keys()]) removeOnlineRemote(id);
      updateOnlineStatus('SERVIDOR DESCONECTADO', false);
    });
    onlineSocket.addEventListener('error', () => updateOnlineStatus('SERVIDOR INDISPONÍVEL', false));
  } catch { updateOnlineStatus('SERVIDOR INDISPONÍVEL', false); }
}

const battleScoreboard = document.createElement('div');
battleScoreboard.id = 'battle-scoreboard';
battleScoreboard.className = 'hidden';
battleScoreboard.innerHTML = '<div class="battle-scoreboard-card"><header><b>PLACAR DA BATALHA</b><span>LIBERE TAB OU USE OS BOTÕES</span></header><div class="battle-scoreboard-fund"></div><div class="battle-scoreboard-columns"><span>JOGADOR</span><span>EQUIPE</span><span>ELIMINAÇÕES</span><span>PONTOS</span></div><div class="battle-scoreboard-rows"></div><footer class="battle-scoreboard-actions"><button type="button" data-scoreboard-close>CONTINUAR</button><button type="button" data-scoreboard-leave>SAIR DA BATALHA</button></footer></div>';
document.body.appendChild(battleScoreboard);
const battleScoreboardStyle = document.createElement('style');
battleScoreboardStyle.textContent = '#battle-scoreboard{position:fixed;inset:0;z-index:1050;display:grid;place-items:center;background:#05090bc9;color:#edf1ef;font:12px Arial,sans-serif;pointer-events:none}#battle-scoreboard.hidden{display:none}.battle-scoreboard-card{width:min(760px,92vw);padding:18px 22px;border:1px solid #697980;background:linear-gradient(145deg,#182329f5,#0b1115f5);box-shadow:0 24px 65px #0009;pointer-events:auto}.battle-scoreboard-card header{display:flex;justify-content:space-between;align-items:center;padding-bottom:14px;border-bottom:1px solid #526167;letter-spacing:1px}.battle-scoreboard-card header b{font-size:16px;color:#e6c98e}.battle-scoreboard-card header span{font-size:9px;color:#91a0a3}.battle-scoreboard-fund{padding:13px 0;color:#f0d49c;font-size:14px;font-weight:bold}.battle-scoreboard-columns,.battle-scoreboard-row{display:grid;grid-template-columns:1.5fr .8fr 1fr .7fr;gap:10px;align-items:center}.battle-scoreboard-columns{padding:9px;background:#253238;color:#a7b5b5;font-size:9px;letter-spacing:.8px}.battle-scoreboard-row{min-height:35px;padding:6px 9px;border-bottom:1px solid #344148}.battle-scoreboard-row.player{color:#f2d39b;background:#68502a44}.battle-scoreboard-row span:last-child{text-align:right}.battle-scoreboard-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:15px}.battle-scoreboard-actions button{min-height:38px;padding:0 15px;border:1px solid #526c70;background:#182a2f;color:#d7e9e6;font-size:9px;font-weight:bold;letter-spacing:.8px;cursor:pointer}.battle-scoreboard-actions [data-scoreboard-leave]{border-color:#a76c5a;background:#482b28;color:#ffd8ca}';
document.head.appendChild(battleScoreboardStyle);
function refreshBattleScoreboard() {
  battleScoreboard.querySelector('.battle-scoreboard-fund')!.textContent = `FUNDO DE BATALHA: ${battleFund} ◈`;
  const rows = battleScoreboard.querySelector('.battle-scoreboard-rows')!;
  rows.replaceChildren();
  const participants = [{ name: 'Você', team: playerTeam, kills: playerBattleKills, score: playerBattleScore, player: true },
    ...[...onlineRemotes.values()].map(remote => ({ name: remote.name, team: remote.team, kills: 0, score: 0, player: false })),
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

function leaveBattle() {
  matchEnded = true;
  battleHasStarted = false;
  if (onlineRoomId) onlineSend({ type: 'leave-room' });
  onlineRoomId = '';
  (document.getElementById('main-menu-play') as HTMLButtonElement).textContent = 'INICIAR TREINO LOCAL　➜';
  onlinePendingStart = false;
  for (const id of [...onlineRemotes.keys()]) removeOnlineRemote(id);
  clearProjectiles();
  battleScoreboard.classList.add('hidden');
  (document.getElementById('main-menu-resume') as HTMLButtonElement).hidden = true;
  (document.getElementById('main-menu-leave-header') as HTMLButtonElement).hidden = true;
  waveBanner.textContent = 'VOCÊ SAIU DA BATALHA · CONFIGURE UMA NOVA PARTIDA';
  waveBannerTimer = 999999;
  updateHUD();
  if (!mainMenuOpen) showMainMenu();
}

battleScoreboard.querySelector('[data-scoreboard-close]')!.addEventListener('click', () => battleScoreboard.classList.add('hidden'));
battleScoreboard.querySelector('[data-scoreboard-leave]')!.addEventListener('click', leaveBattle);
document.getElementById('main-menu-leave-header')!.addEventListener('click', leaveBattle);
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
  .main-menu-content{min-width:0;overflow:auto;padding:clamp(24px,5vw,64px);background:radial-gradient(ellipse at 80% 10%,#30434b55,transparent 55%)}.main-menu-panel{display:none;max-width:none;width:100%}.main-menu-panel.active{display:block}.main-menu-eyebrow{color:#c59a58;font-size:9px;letter-spacing:2px}.main-menu-panel h1{margin:10px 0;color:#f0f2ef;font-size:clamp(25px,3vw,38px);letter-spacing:.5px}.main-menu-panel>p{max-width:620px;color:#a5b1b3;font-size:13px;line-height:1.6}.main-menu-battle-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:26px}.main-menu-mode-card{display:flex;flex-direction:column;gap:9px;min-height:104px;padding:16px;border:1px solid #425158;background:#111a1fbb}.main-menu-mode-card small{color:#b59760;font-size:8px;font-weight:bold;letter-spacing:1.5px}.main-menu-mode-card b{color:#e5d0a4;font-size:11px;letter-spacing:.8px}.main-menu-mode-card span{color:#9aa7aa;font-size:10px}.main-menu-mode-card select,.main-menu-mode-card input{height:38px;padding:0 10px;border:1px solid #596970;background:#1b282e;color:#e7ecea;font:12px Arial,sans-serif}
  .main-menu-action-row{display:flex;gap:10px;margin-top:22px}.main-menu-play,.main-menu-secondary{min-height:44px;padding:0 18px;border:1px solid #c39a54;background:linear-gradient(110deg,#876432,#574226);color:#fff0ca;font-size:10px;font-weight:bold;letter-spacing:1px;cursor:pointer}.main-menu-play span{margin-right:8px}.main-menu-secondary{border-color:#536269;background:#182328;color:#d9e0df}.main-menu-briefing{display:flex;flex-direction:column;gap:7px;margin-top:26px;padding:15px 17px;border-left:2px solid #bd914b;background:#bd914b12}.main-menu-briefing small{color:#b59760;font-size:8px;letter-spacing:1.4px}.main-menu-briefing b{color:#e6e8e2;font-size:12px}.main-menu-briefing span{color:#91a0a3;font-size:10px}.main-menu-rank-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:24px 0}.main-menu-rank-step{padding:13px;border:1px solid #37474d;background:#111a1f;color:#8b989b;font-size:10px}.main-menu-rank-step b{display:block;margin-bottom:6px;color:#aeb9b8;font-size:16px}.main-menu-rank-step small{display:block;margin-top:5px;color:#758489;font-size:8px}.main-menu-rank-step.active{border-color:#c59a58;background:#48392066;color:#f1d49a}.main-menu-rank-step.complete{border-color:#647752;background:#243222;color:#d3e2bf}
  .local-battle-list{margin:18px 0 22px;border:1px solid #37474d;background:#0b1216aa}.local-battle-list>header{display:flex;justify-content:space-between;padding:11px 13px;border-bottom:1px solid #37474d;color:#d9e0df;font-size:9px;letter-spacing:1px}.local-battle-list>header span{color:#8d9a9e;font-size:8px}.local-battle-row{display:grid;width:100%;grid-template-columns:minmax(0,1fr) 75px 80px;align-items:center;gap:12px;padding:12px 14px;border:0;border-bottom:1px solid #26343a;background:transparent;color:#dfe6e3;text-align:left;cursor:pointer}.local-battle-row:hover{background:#b88a3d22}.local-battle-row span b,.local-battle-row span small{display:block}.local-battle-row span b{font-size:11px}.local-battle-row span small{margin-top:4px;color:#89999d;font-size:8px;letter-spacing:.8px}.local-battle-row i{color:#aeb9b9;font-size:9px;font-style:normal}.local-battle-row strong{padding:8px;border:1px solid #90703f;color:#f2d39b;text-align:center;font-size:8px;letter-spacing:.8px}.battle-create-heading{display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#c9a76d;font-size:9px;letter-spacing:1px}.battle-create-heading span{color:#829095;font-size:8px;letter-spacing:0}

  .main-menu-open{position:absolute;top:15px;right:205px;pointer-events:auto;padding:8px 12px;border:1px solid rgba(190,210,207,.42);border-radius:4px;background:rgba(5,12,10,.82);color:#f0d39b;font:bold 10px/1 Arial,sans-serif;letter-spacing:1px;cursor:pointer;text-shadow:0 1px 3px #000}
  @media(max-width:700px){.main-menu-shell{height:96vh;min-height:0}.main-menu-header{height:62px;flex-basis:62px;gap:10px;padding:0 12px}.main-menu-brand{min-width:0}.main-menu-profile{min-width:0;flex:1}.main-menu-wallet{display:none}.main-menu-header>button{padding:0 8px;font-size:8px}.main-menu-body{grid-template-columns:56px minmax(0,1fr)}.main-menu-nav{padding:12px 5px}.main-menu-nav button{justify-content:center;padding:0}.main-menu-nav button span,.main-menu-nav-footer{display:none}.main-menu-content{padding:16px}.main-menu-battle-grid{grid-template-columns:1fr}.main-menu-rank-list{grid-template-columns:repeat(2,minmax(0,1fr))}.main-menu-open{right:190px}.battle-create-heading{align-items:flex-start;gap:5px;flex-direction:column}.local-battle-row{grid-template-columns:minmax(0,1fr) 52px 65px;gap:6px;padding:10px}.main-menu-action-row{flex-wrap:wrap}.main-menu-action-row button{flex:1 1 auto}}
`;

// Leitura e hierarquia da interface em tela cheia, sem filtros de blur caros.
const menuReadabilityStyle = document.createElement('style');
menuReadabilityStyle.textContent = `
#main-menu{backdrop-filter:none;background:#080d0b;font-family:Inter,Segoe UI,Arial,sans-serif}
.hud-panel{backdrop-filter:none;background:linear-gradient(145deg,#171e19f2,#0c1210f2);border-color:#d6e0c328}
.hud-panel strong,#team-text{color:#b7c77b}#help{backdrop-filter:none;background:#0b100eeb;border-color:#d6e0c322}
#health-fill{background:linear-gradient(90deg,#839b47,#b5c86c)}
.main-menu-open{border-color:#929e64;background:#111813;color:#dbe6b4;border-radius:2px}
.performance-readout{backdrop-filter:none!important;border-radius:2px!important}
.damage-number-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5}
.damage-number{position:absolute;left:0;top:0;color:#f3e2ab;font:900 18px/1 Arial,Helvetica,sans-serif;letter-spacing:.2px;-webkit-text-stroke:.45px #332b19;text-shadow:0 1px 2px #000,0 2px 5px #000b;white-space:nowrap;will-change:transform,opacity}
.damage-number.heavy{color:#ffbd73;font-size:21px}

.main-menu-shell{background:linear-gradient(160deg,#202a2b 0%,#11191b 48%,#0b1012 100%);border-color:#53605b;box-shadow:0 18px 60px #0009}
.main-menu-mark,.garage-brand-mark{transform:none;background:#9fae67;color:#111715;clip-path:polygon(0 12%,88% 12%,100% 24%,100% 100%,0 100%)}
.main-menu-mark svg,.garage-brand-mark svg{width:29px;height:29px;fill:currentColor}
.main-menu-brand b,.garage-brand b{letter-spacing:2.3px}
.main-menu-header{background:linear-gradient(90deg,#293331,#171e1d);border-color:#414b43}
.main-menu-nav{background:#101615;border-color:#35403a}
.main-menu-nav button{font-size:11px;min-height:50px}
.main-menu-nav button.active{border-color:#798653;background:linear-gradient(90deg,#52623b55,#52623b12);color:#e7edcf;box-shadow:inset 3px 0 #a8b76c}
.main-menu-nav button i,.main-menu-eyebrow,.battle-details-body>small,.battle-create-top>div small,.create-map-caption small{color:#b4c17a}
.main-menu-content{padding:clamp(24px,3.2vw,48px);background:radial-gradient(ellipse at 78% 0%,#56634422,transparent 58%)}
.main-menu-content{padding:18px 24px}
.main-menu-panel h1{font-size:clamp(30px,2.5vw,40px);letter-spacing:-.5px}
.main-menu-panel h1{margin:5px 0 0;font-size:clamp(28px,2.2vw,36px)}
.main-menu-panel>p{font-size:14px;color:#b2bcb5}
.main-menu-panel>p{margin:0 0 8px;font-size:12px}
.battle-toolbar{margin:9px 0 7px;padding-bottom:8px}
.battle-filter-tabs button{font-size:10px;min-height:36px}
.local-battle-list{grid-column:auto!important;grid-row:auto!important}.local-battle-list,.battle-details,.battle-create-layout>section,.create-battle-settings{border-color:#3d4840;background:#151c1a}
.local-battle-list>header{min-height:44px;background:#1d2622}
.battle-list-columns{font-size:9px;min-height:32px}
.local-battle-row{min-height:54px;grid-template-columns:44px minmax(0,1fr) 76px 78px;padding:6px 12px}
.local-battle-row>span b{font-size:13px}.local-battle-row>span small{font-size:9px}
.battle-map-thumb{width:48px;height:42px}
.local-battle-row.active{background:#68774426;box-shadow:inset 3px 0 #a7b46a}
.local-battle-row strong{border-color:#78844e;color:#dbe4b6}
.battle-details-banner{min-height:132px}
.battle-details-body{padding:12px}.battle-details-body h2{margin:5px 0;font-size:16px}.battle-details-body p{min-height:36px;font-size:11px}
.battle-detail-stats{margin:5px 0 8px}
.battle-detail-stats span{font-size:8px}.battle-detail-stats b{font-size:12px}
.battle-create-layout{grid-template-columns:minmax(220px,.82fr) minmax(360px,1.55fr) minmax(260px,.9fr);gap:16px}
.battle-create-layout>section,.create-battle-settings{padding:16px}
.battle-create-layout>section>header strong{font-size:14px}.battle-create-layout>section>header small{font-size:9px}
.create-mode-card{min-height:76px}.create-mode-card b{font-size:11px}.create-mode-card small{font-size:9px}
.create-map-options{gap:9px}.create-map-card{padding:5px}.create-map-card b{font-size:10px}
.create-battle-settings label{font-size:8px}.create-battle-settings input,.create-battle-settings select{height:38px;font-size:12px}
.battle-create-footer{position:sticky;bottom:0;padding:14px 0 4px;background:linear-gradient(180deg,transparent,#101615 25%)}
.garage-preview{background:radial-gradient(ellipse at 50% 54%,#454d3b 0%,#26312b 34%,#171e1c 70%,#101513 100%);border-color:#59644c}
.garage-preview:before,.garage-preview:after{content:"";position:absolute;inset:0;z-index:0;pointer-events:none}
.garage-preview:before{background:linear-gradient(90deg,transparent 5%,#a8b09918 5.3%,transparent 5.8%,transparent 94%,#a8b09918 94.3%,transparent 94.8%),linear-gradient(180deg,#c1c9a312 0 2%,transparent 2.5% 56%,#0003 57% 100%),linear-gradient(90deg,transparent 18%,#d3c88b10 18.2%,transparent 18.6% 81%,#d3c88b10 81.3%,transparent 81.7%)}
.garage-preview:after{inset:58% 0 0;background:repeating-linear-gradient(90deg,transparent 0 79px,#d0d4be0a 80px),linear-gradient(0deg,#0b0f0e99,transparent);}
.garage-nav-item{font-size:11px}.garage-showcase-head small,.garage-section-head small{font-size:10px}
.garage-section-head h3{font-size:18px}.garage-section-head p{font-size:11px}
.garage-section label{font-size:9px}.garage-section select{font-size:12px}
.garage-item-card b{font-size:10px}.garage-item-card small{font-size:9px}
.garage-item-grid[data-grid-for="tank-class"]{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.garage-item-grid[data-grid-for="tank-class"] .garage-item-card.tank-class-card{display:grid;grid-template-columns:48px minmax(0,1fr);grid-template-rows:auto auto;column-gap:10px;row-gap:4px;min-height:68px;padding:8px 10px}
.tank-class-icon,.weapon-class-icon{grid-row:1/3;display:grid;place-items:center;width:46px;height:46px;border:1px solid #53614c;background:linear-gradient(145deg,#222c25,#111916)}
.tank-class-icon svg,.weapon-class-icon svg{width:39px;height:32px}
.tank-class-icon .tread{fill:#111817;stroke:#738064;stroke-width:1.5}.tank-class-icon .hull{fill:#788563;stroke:#c1ca9e;stroke-width:1.3}.tank-class-icon .turret{fill:#9ba67c;stroke:#d4d9ba;stroke-width:1}.tank-class-icon .barrel{fill:#bdc3a3}.tank-class-icon .detail{fill:#4c5742}
.tank-class-card[data-vehicle-class="light"] .hull,.tank-class-card[data-vehicle-class="scout"] .hull{fill:#759086}
.tank-class-card[data-vehicle-class="heavy"] .hull,.tank-class-card[data-vehicle-class="assault"] .hull{fill:#877553}
.tank-class-card[data-vehicle-class="artillery"] .barrel{transform:scaleX(1.25);transform-origin:center}
.weapon-class-icon .base{fill:#252b26;stroke:#768167;stroke-width:1.4}.weapon-class-icon .turret{fill:#849071;stroke:#d2d8b8;stroke-width:1.2}.weapon-class-icon .barrel{fill:#bbc3a1}.weapon-class-icon .bore{fill:#131916}
.garage-item-grid[data-grid-for="tank-weapon"] .garage-item-card{min-height:64px;padding:8px 10px 8px 58px;position:relative}
.tank-weapon-card .weapon-class-icon{position:absolute;left:8px;top:50%;width:42px;height:42px;transform:translateY(-50%)}
.tank-weapon-card .weapon-class-icon svg{width:35px;height:27px}
.preview-label{font-size:9px}.preview-bottom{font-size:10px}
.preview-grid{opacity:.11;background-size:48px 36px}.preview-crosshair{display:none}
.preview-bottom{color:#dce4bf}
@media(max-width:1050px){.battle-create-layout{grid-template-columns:minmax(190px,.8fr) minmax(300px,1.2fr)}.create-battle-settings{grid-column:1/-1}}
@media(max-width:700px){.local-battle-row{grid-template-columns:34px minmax(0,1fr) 48px 56px}.battle-create-layout{grid-template-columns:1fr}}
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
const interfacePolishStyle = document.createElement('style');
interfacePolishStyle.textContent = `
#main-menu{background:radial-gradient(ellipse at 48% 38%,rgba(20,35,43,.48),rgba(2,6,9,.88))}
.main-menu-shell{background:linear-gradient(135deg,#151f26 0%,#0b1218 62%,#101920 100%);border-color:#52646c;box-shadow:0 32px 110px #000c,0 0 0 1px #ffffff08}
.main-menu-header{background:linear-gradient(90deg,#202e36,#111a20);border-color:#364850}
.main-menu-mark,.garage-brand-mark{background:linear-gradient(145deg,#8bd8d0,#3d8b91);color:#071416;box-shadow:0 5px 18px #55c2ba33}
.main-menu-profile>div:nth-child(2) b,.main-menu-wallet b{color:#c6e2df}
.main-menu-nav button i,.garage-nav-item i{color:#7fcac2}
.main-menu-nav button.active{border-color:#4b9a9577;background:linear-gradient(90deg,#55b9ac28,#55b9ac08);color:#d6efeb;box-shadow:inset 3px 0 #68bfb5}
.main-menu-panel.active[data-menu-section="battle"]{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(340px,.92fr);grid-template-rows:auto auto auto auto auto 1fr;column-gap:clamp(22px,3vw,48px);align-content:start;max-width:none;height:100%}
.main-menu-panel[data-menu-section="battle"]>.main-menu-eyebrow,.main-menu-panel[data-menu-section="battle"]>h1,.main-menu-panel[data-menu-section="battle"]>p{grid-column:1/-1}
.main-menu-panel[data-menu-section="battle"]>.main-menu-eyebrow{color:#86cfc5}
.main-menu-panel[data-menu-section="battle"]>h1{font-size:clamp(30px,3.2vw,46px);letter-spacing:-.5px}
.main-menu-panel[data-menu-section="battle"]>p{margin-top:0;margin-bottom:8px}
.local-battle-list{grid-column:1;grid-row:4/7;margin:0;align-self:start;border-color:#3a5058;background:#0a1218bb;box-shadow:0 12px 28px #0003}
.local-battle-list>header{padding:14px 16px;border-color:#2c4148}.local-battle-list>header b{letter-spacing:1.5px}.local-battle-row{min-height:72px;padding:13px 16px;border-color:#263941}.local-battle-row:hover{background:#61b8ae17}.local-battle-row strong{border-color:#518d88;background:#183330;color:#bce9e3}
.battle-create-heading{grid-column:2;grid-row:4;align-self:end;margin:0 0 11px;padding-bottom:10px;border-bottom:1px solid #364a50;color:#89cfc5}
.main-menu-battle-grid{grid-column:2;grid-row:5;grid-template-columns:1fr 1fr;gap:10px;margin:0}
.main-menu-mode-card{min-height:95px;padding:14px;border-color:#354a51;border-radius:3px;background:linear-gradient(145deg,#17242a,#10191e)}
.main-menu-mode-card small{color:#82c5bc}.main-menu-mode-card select,.main-menu-mode-card input{border-color:#3c555c;border-radius:2px;background:#101a20}
.main-menu-action-row{grid-column:2;grid-row:6;align-self:end;flex-wrap:wrap;margin-top:16px}
.main-menu-play,.main-menu-secondary{border-radius:2px;transition:filter .14s,transform .14s,border-color .14s}
.main-menu-play{border-color:#70c8bd;background:linear-gradient(110deg,#287a78,#195456);color:#e6fffb;box-shadow:0 7px 20px #237c762b}
.main-menu-secondary{border-color:#526c70;background:#1a2a30;color:#bdd6d4}
.main-menu-play:hover,.main-menu-secondary:hover,.garage-return:hover{filter:brightness(1.14);transform:translateY(-1px)}
.main-menu-briefing{grid-column:2;grid-row:7;margin-top:14px;border-color:#3b5d5a;background:linear-gradient(110deg,#1b3c392e,#132126a8)}
.main-menu-briefing small{color:#8ad0c6}.main-menu-briefing b{color:#c3e8e1}
.garage-shell{border-color:#52646c;background:linear-gradient(135deg,#151f26,#0b1218)}
.garage-topbar{background:linear-gradient(90deg,#202e36,#111a20);border-color:#364850}
.garage-nav-item.active{border-color:#4b9a9577;background:linear-gradient(90deg,#55b9ac28,#55b9ac08);color:#d6efeb;box-shadow:inset 3px 0 #68bfb5}
.garage-section-head small,.garage-showcase-head small{color:#83c9c0}
.garage-secondary-action{border-color:#68bcb2;background:linear-gradient(110deg,#246c69,#174447);color:#e3f7f4}
.garage-item-card.selected{border-color:#69c5ba;background:linear-gradient(110deg,#1d4642,#17262b);box-shadow:inset 2px 0 #72c9bf}
.garage-selection-summary{border-color:#64b9af;background:#56b7aa12}.garage-selection-summary b{color:#b6e3dd}
.garage-return{border-color:#74c9c0;background:linear-gradient(#56aaa3,#347e7d);color:#071716}
.garage-item-card:disabled{opacity:.52;cursor:not-allowed;filter:saturate(.45)}
.garage-item-grid[data-grid-for="tank-color"]{grid-template-columns:repeat(3,minmax(0,1fr))}.garage-item-grid[data-grid-for="tank-color"] .garage-item-card{min-height:82px;padding:7px}.garage-item-grid[data-grid-for="tank-color"] .garage-item-card b{font-size:8px}.garage-item-grid[data-grid-for="tank-color"] .garage-item-card small{font-size:7px}.garage-item-grid[data-grid-for="tank-color"] .garage-paint-chip{height:26px;border-radius:2px}
.garage-item-grid[data-grid-for="map-style"]{grid-template-columns:repeat(2,minmax(0,1fr))}.garage-item-grid[data-grid-for="map-style"] .garage-item-card{min-height:50px;padding:8px}
.garage-item-grid[data-grid-for="game-mode"],.garage-item-grid[data-grid-for="garage-player-count"]{grid-template-columns:repeat(2,minmax(0,1fr))}.garage-item-grid[data-grid-for="game-mode"] .garage-item-card,.garage-item-grid[data-grid-for="garage-player-count"] .garage-item-card{min-height:54px;padding:8px}
.container-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #40565b;background:linear-gradient(140deg,#19282d,#10181d)}.container-card>div:nth-child(2){display:flex;flex:1;flex-direction:column;gap:5px}.container-card small{color:#85c9c0;font-size:8px;letter-spacing:1px}.container-card b{color:#e3ebe9;font-size:12px}.container-card span{color:#90a1a2;font-size:9px;line-height:1.4}.container-card>strong{color:#e2c886;font-size:11px;white-space:nowrap}.container-crate-art{width:58px;height:58px;display:grid;place-items:center;border:1px solid #8ac9c255;background:linear-gradient(145deg,#32827f,#1b464b);color:#d5f1e9;font-size:30px;box-shadow:inset 0 0 0 4px #ffffff0a,0 7px 18px #0005}.container-result{margin-top:12px;color:#9aadaa;font-size:10px}.container-result b{color:#d9e9e5}
.main-menu-panel.active[data-menu-section="battle"]{display:block;height:100%;max-width:none;overflow:auto;padding-right:6px}
.main-menu-panel[data-menu-section="battle"]>h1{margin:8px 0 4px;font-size:clamp(26px,2.5vw,36px)}
.main-menu-panel[data-menu-section="battle"]>p{margin:0 0 18px;max-width:none;font-size:12px}
.battle-browser-view[hidden],.battle-create-view[hidden]{display:none!important}
.battle-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #34464d}
.battle-filter-tabs{display:flex;flex-wrap:wrap;gap:4px}.battle-filter-tabs button{height:32px;padding:0 12px;border:1px solid transparent;background:transparent;color:#8fa1a5;font-size:9px;font-weight:700;letter-spacing:.8px;cursor:pointer}.battle-filter-tabs button:hover{color:#d8e9e7}.battle-filter-tabs button.active{border-color:#528e8980;background:#1c3c3a;color:#bce8e2}
.battle-search{display:flex;align-items:center;gap:7px;width:min(220px,38%);height:34px;padding:0 10px;border:1px solid #354b52;background:#101a20;color:#80c9bf}.battle-search input{width:100%;border:0;outline:0;background:transparent;color:#e0e8e7;font-size:11px}.battle-search input::placeholder{color:#718287}
.battle-list-layout{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(250px,.75fr);gap:14px;align-items:stretch}
.local-battle-list{min-width:0;margin:0;border-color:#354a51;background:#0c151a}.local-battle-list>header{height:40px;align-items:center;padding:0 12px}.battle-list-columns{display:grid;grid-template-columns:minmax(0,1fr) 74px 70px;gap:9px;padding:9px 12px;background:#111d23;color:#778b91;font-size:8px;letter-spacing:.8px}.battle-list-columns span:not(:first-child){text-align:center}
.local-battle-row{min-height:61px;grid-template-columns:42px minmax(0,1fr) 64px 64px;gap:10px;padding:8px 10px;border-bottom:1px solid #25373e}.local-battle-row>span b{font-size:11px}.local-battle-row>span small{font-size:8px}.local-battle-row.active{background:#4c9e961a;box-shadow:inset 2px 0 #70c9be}.local-battle-row strong{padding:6px 4px;border:1px solid #3e685e;background:#18332c;color:#a6d9bd;font-size:7px}.local-battle-row .battle-population{color:#b3c2c2;text-align:center;font-size:9px;font-style:normal}.battle-map-thumb{display:block;width:40px;height:38px;border:1px solid #9eb4aa55;background:linear-gradient(140deg,#718879,#31483d 55%,#172b28);box-shadow:inset 0 -9px 14px #07111399}.battle-map-thumb.metropolis{background:linear-gradient(140deg,#b0a894,#606c70 45%,#222c34)}.battle-map-thumb.volcano{background:linear-gradient(140deg,#f2a47b,#734339 48%,#271a1b)}.battle-map-thumb.snow{background:linear-gradient(140deg,#d2e6ec,#819ba8 50%,#334550)}.battle-map-thumb.industrial{background:linear-gradient(140deg,#71868a,#3b4b4e 48%,#192529)}
.battle-details{display:flex;flex-direction:column;min-width:0;border:1px solid #354a51;background:#0d171d}.battle-details-banner{position:relative;isolation:isolate;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;min-height:132px;padding:14px;background:linear-gradient(140deg,#8ba998,#526957 46%,#1c3030);overflow:hidden}.battle-details-banner:before{content:"";position:absolute;z-index:-1;inset:0;background:linear-gradient(0deg,#071015e8,transparent 90%)}.battle-details-banner.metropolis{background:linear-gradient(140deg,#c2b798,#687477 45%,#28353c)}.battle-details-banner.volcano{background:linear-gradient(140deg,#e5a07e,#754943 45%,#291d22)}.battle-details-banner.snow{background:linear-gradient(140deg,#d7ebee,#829aa5 50%,#344954)}.battle-details-banner.industrial{background:linear-gradient(140deg,#879a9c,#3c5155 55%,#172428)}.battle-details-banner span{color:#b7d9d3;font-size:8px;letter-spacing:1.4px}.battle-details-banner b{color:#f1f6f4;font-size:22px;letter-spacing:.3px;text-shadow:0 2px 8px #0009}.battle-details-body{display:flex;flex-direction:column;flex:1;padding:13px}.battle-details-body>small{color:#84c9c0;font-size:8px;letter-spacing:1.2px}.battle-details-body h2{margin:8px 0;color:#e8efed;font-size:15px}.battle-details-body p{min-height:44px;color:#98a9ab;font-size:10px;line-height:1.5}.battle-detail-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:8px 0 12px}.battle-detail-stats span{padding:8px 6px;border:1px solid #2e4147;background:#111d22;color:#75888d;font-size:7px;letter-spacing:.7px}.battle-detail-stats b{display:block;margin-top:5px;color:#c6d8d6;font-size:10px;letter-spacing:.2px}.battle-details-body>.main-menu-play{width:100%;min-height:40px}.battle-create-open{width:100%;height:38px;margin-top:8px;border:1px solid #425c61;background:transparent;color:#c3d7d5;font-size:9px;font-weight:bold;letter-spacing:.8px;cursor:pointer}.battle-create-open:hover{border-color:#6ab7ae;background:#61b6a914}.battle-create-open span{color:#81d0c5;font-size:15px;vertical-align:-1px}.battle-browser-footer{display:flex;justify-content:space-between;gap:12px;margin-top:12px;color:#718287;font-size:7px;letter-spacing:1px}.battle-browser-footer span:first-child{color:#a1c9b0}.battle-browser-footer i{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:#83c99a}.battle-empty-state{padding:30px 12px;color:#9caeae;text-align:center;font-size:11px}
.battle-create-view{height:100%;max-width:none;overflow:auto;padding:4px 8px 14px}.battle-create-top{display:flex;align-items:center;gap:18px;min-height:58px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #35484e}.battle-create-top>div{flex:1}.battle-create-top>div small{color:#83c9c0;font-size:8px;letter-spacing:1.5px}.battle-create-top h2{margin:4px 0 0;color:#e9f0ee;font-size:20px}.battle-create-top>span{color:#9ab9ac;font-size:8px;letter-spacing:.8px}.battle-create-top>span i{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:#84c99b}.battle-back-button{height:34px;padding:0 12px;border:1px solid #425960;background:#111d22;color:#bad2d0;font-size:9px;letter-spacing:.8px;cursor:pointer}.battle-create-layout{display:grid;grid-template-columns:minmax(190px,.78fr) minmax(300px,1.4fr) minmax(215px,.86fr);gap:13px;align-items:stretch}.battle-create-layout>section,.create-battle-settings{min-width:0;padding:12px;border:1px solid #354a51;background:#0d171d}.battle-create-layout>section>header{display:flex;align-items:center;gap:9px;margin-bottom:11px}.battle-create-layout>section>header>b{width:25px;height:25px;display:grid;place-items:center;border:1px solid #4d9891;background:#15332f;color:#b8e8e0;font-size:11px}.battle-create-layout>section>header div{display:flex;flex:1;flex-direction:column;gap:3px}.battle-create-layout>section>header strong{color:#dce8e6;font-size:12px}.battle-create-layout>section>header small{color:#83969a;font-size:8px}.battle-create-layout>section>header>span{color:#7ea79e;font-size:7px;letter-spacing:.8px}.create-mode-options{display:flex;flex-direction:column;gap:7px}.create-mode-card{display:flex;align-items:center;gap:10px;min-height:67px;padding:9px;border:1px solid #30434a;background:#121d22;color:#d5e1df;text-align:left;cursor:pointer}.create-mode-card>i{width:31px;height:31px;flex:0 0 31px;display:grid;place-items:center;border:1px solid #3d5c60;background:#1b2a2e;color:#8ecfc5;font-size:16px;font-style:normal}.create-mode-card span{display:flex;flex-direction:column;gap:5px}.create-mode-card b{font-size:9px;letter-spacing:.4px}.create-mode-card small{color:#819397;font-size:8px;line-height:1.35}.create-mode-card:hover,.create-map-card:hover{border-color:#699c96;background-color:#162c2c}.create-mode-card.active{border-color:#66b6ac;background:linear-gradient(90deg,#20545055,#15252a);box-shadow:inset 2px 0 #75c9bf}.create-mode-card.active>i{border-color:#70bab0;background:#1e4a46;color:#d0f0ea}.create-map-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.create-map-card{min-width:0;padding:4px;border:1px solid #34484d;background:#111b20;color:#c5d5d3;cursor:pointer}.create-map-card img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}.create-map-card b{display:block;overflow:hidden;padding:6px 2px 3px;font-size:8px;text-align:left;text-overflow:ellipsis;white-space:nowrap}.create-map-card.active{border-color:#73c8be;background:#1b3d3a;box-shadow:0 0 0 1px #73c8be44}.create-battle-settings{display:flex;flex-direction:column;gap:10px}.create-battle-settings>img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border:1px solid #637a7b}.create-map-caption{display:flex;flex-direction:column;gap:5px;padding-bottom:8px;border-bottom:1px solid #293b41}.create-map-caption small{color:#7ec8bf;font-size:7px;letter-spacing:1.2px}.create-map-caption b{color:#eff5f2;font-size:14px}.create-map-caption span{color:#9cacab;font-size:8px;line-height:1.4}.create-battle-settings label{display:flex;flex-direction:column;gap:5px;color:#87c7be;font-size:7px;font-weight:bold;letter-spacing:.8px}.create-battle-settings input,.create-battle-settings select{width:100%;height:32px;padding:0 8px;border:1px solid #3c545a;border-radius:2px;background:#111c21;color:#e0e9e7;font-size:10px}.create-mode-warning{margin-top:auto;padding:9px;border-left:2px solid #70958a;background:#1a2b2922;color:#849895;font-size:8px;line-height:1.45}.create-native-source{display:none!important}.battle-create-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid #34464c}.battle-create-footer .main-menu-play{min-width:220px}.battle-create-footer .main-menu-secondary{min-height:38px;padding:0 14px;font-size:8px}
.battle-details-banner{position:relative;isolation:isolate;overflow:hidden}.battle-details-banner img{position:absolute;z-index:-2;inset:0;width:100%;height:100%;object-fit:cover}.battle-details-banner:before{z-index:-1}.battle-map-thumb{object-fit:cover;border-radius:2px;background:#24363a}
@media(max-width:1050px){.battle-create-layout{grid-template-columns:minmax(170px,.75fr) minmax(250px,1.1fr)}.create-battle-settings{grid-column:1/-1;display:grid;grid-template-columns:200px 1fr 1fr;align-items:center}.create-battle-settings>img{grid-row:span 3}.create-map-caption{border-bottom:0}.create-mode-warning{grid-column:2/-1}}
@media(max-width:700px){.battle-create-top{flex-wrap:wrap}.battle-create-top>div{min-width:180px}.battle-create-layout{grid-template-columns:1fr}.create-battle-settings{grid-column:auto;display:flex}.create-battle-settings>img{aspect-ratio:16/7}.create-map-options{grid-template-columns:repeat(2,minmax(0,1fr))}.battle-create-footer{flex-wrap:wrap}.battle-create-footer .main-menu-play{min-width:100%;order:-1}}
.garage-main{grid-template-columns:minmax(0,1.2fr) minmax(320px,.8fr);gap:22px;padding:24px}.garage-preview{border-color:#4a646b;background:radial-gradient(ellipse at 50% 48%,#344e55 0%,#1b3037 38%,#101a20 76%)}.preview-grid{opacity:.16}.preview-crosshair{border-color:#99d5ca20}.garage-section{border-radius:3px}.garage-controls{gap:10px}
@media(max-width:900px){.battle-list-layout{grid-template-columns:1fr}.battle-details{display:grid;grid-template-columns:minmax(140px,.7fr) minmax(0,1fr)}.battle-details-banner{min-height:100%}.battle-details-body p{min-height:0}.main-menu-panel.active[data-menu-section="battle"]{display:block;height:100%}.battle-create-view .main-menu-battle-grid{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.battle-toolbar{align-items:stretch;flex-direction:column}.battle-search{width:100%}.battle-filter-tabs{overflow:auto;flex-wrap:nowrap}.battle-filter-tabs button{padding:0 9px;font-size:8px;white-space:nowrap}.battle-list-columns{grid-template-columns:minmax(0,1fr) 50px 58px}.local-battle-row{grid-template-columns:34px minmax(0,1fr) 48px 52px;gap:6px;padding:7px}.battle-map-thumb{width:32px;height:32px}.battle-list-columns{font-size:7px}.local-battle-row>span b{font-size:9px}.local-battle-row>span small{font-size:7px}.battle-details{grid-template-columns:1fr}.battle-details-banner{min-height:95px}.battle-browser-footer{font-size:6px}.battle-create-view .main-menu-battle-grid{grid-template-columns:1fr 1fr}.garage-main{grid-template-columns:1fr;gap:12px;padding:12px}.garage-preview{min-height:250px}}
@media(max-width:900px){.main-menu-panel.active[data-menu-section="battle"]{grid-template-columns:1fr;grid-template-rows:auto;align-content:start;gap:0}.main-menu-panel[data-menu-section="battle"]>.main-menu-eyebrow,.main-menu-panel[data-menu-section="battle"]>h1,.main-menu-panel[data-menu-section="battle"]>p,.local-battle-list,.battle-create-heading,.main-menu-battle-grid,.main-menu-action-row,.main-menu-briefing{grid-column:1;grid-row:auto}.local-battle-list{margin:12px 0 16px}.battle-create-heading{margin:0 0 10px}.main-menu-action-row{margin-top:14px}.main-menu-briefing{margin-bottom:8px}}
@media(max-width:560px){.main-menu-panel.active[data-menu-section="battle"]{display:block;height:auto}.main-menu-battle-grid{display:grid;grid-template-columns:1fr 1fr}.main-menu-mode-card{min-height:88px;padding:10px}.local-battle-row{min-height:62px}.garage-return{border-color:#5fc0b6;background:linear-gradient(#368784,#23666a);color:#e4faf7}}
@media(min-width:901px) and (max-height:820px){.main-menu-content{padding:12px 22px}.main-menu-panel[data-menu-section="battle"]>h1{margin:4px 0;font-size:30px}.main-menu-panel[data-menu-section="battle"]>p{margin-bottom:8px}.battle-toolbar{margin-bottom:8px;padding-bottom:8px}.battle-filter-tabs button{height:32px}.local-battle-list>header{height:34px}.battle-list-columns{padding:7px 12px}.local-battle-row{min-height:47px;padding:7px 12px}.battle-details-banner{min-height:96px}.battle-details-body{padding:9px 11px}.battle-details-body h2{margin:4px 0}.battle-details-body p{min-height:0;margin-bottom:3px}.battle-detail-stats{margin:5px 0 7px}.battle-detail-stats span{padding:5px}.battle-detail-stats b{margin-top:3px}.battle-details-body>.main-menu-play{min-height:36px}.battle-create-open{height:32px;margin-top:6px}}
`;
document.head.appendChild(interfacePolishStyle);
const gameplayHudPolish = document.createElement('style');
gameplayHudPolish.textContent = `
.hud-panel{width:min(320px,calc(100vw - 24px));padding:12px 14px;gap:7px 14px;border:1px solid #a8d6d040;border-radius:4px;background:linear-gradient(145deg,#101b20eF,#080e13eF);box-shadow:0 10px 30px #0006,inset 0 1px #ffffff0c;font-size:12px;line-height:1.35;backdrop-filter:blur(8px)}
.hud-panel strong{color:#9ae2d8;font-size:14px;letter-spacing:1.5px}.health-track{height:9px;border-radius:2px;background:#38282b}.health-track #health-fill{border-radius:2px;background:linear-gradient(90deg,#60bf88,#b7dd8b)}
#help{max-width:min(580px,calc(100vw - 24px));padding:11px 14px;border:1px solid #a8d6d025;border-radius:3px;background:#080f14dc;color:#d5e1e1;font-size:11px;line-height:1.65;opacity:.96;box-shadow:0 8px 24px #0005}
@media(max-width:600px){.hud-panel{width:min(300px,calc(100vw - 16px));padding:10px;font-size:11px}#help{font-size:10px;line-height:1.5}}
`;
document.head.appendChild(gameplayHudPolish);
document.head.appendChild(menuReadabilityStyle);

// Camada final de direção de arte: uma hierarquia consistente entre lobby,
// oficina e HUD, mantendo os indicadores locais explícitos para o jogador.
const productFinishStyle = document.createElement('style');
productFinishStyle.textContent = `
  :root{color-scheme:dark;--ta-ink:#eaf0f2;--ta-muted:#95a5ad;--ta-line:#ffffff19;--ta-panel:#111a20;--ta-panel-2:#17232a;--ta-cyan:#72d0c4;--ta-gold:#e0b36c}
  html,body{font-family:Inter,"Segoe UI",Roboto,Arial,sans-serif;background:#091116;color:var(--ta-ink)}
  button,select,input{font:inherit}
  #main-menu{padding:clamp(12px,2.3vw,34px);background:radial-gradient(ellipse at 50% 44%,#10202a66,#03070bd9 82%);backdrop-filter:blur(3px)}
  .main-menu-shell{width:min(1440px,100%);height:min(900px,94vh);min-height:min(540px,90vh);border:1px solid #b9d4dc2b;border-radius:10px;background:linear-gradient(145deg,#101a20f5,#091116f4);box-shadow:0 32px 100px #000b,0 0 0 1px #ffffff08;}
  .main-menu-header{height:76px;flex-basis:76px;padding-inline:clamp(18px,3vw,40px);background:linear-gradient(90deg,#1c2a31,#10181d);border-color:var(--ta-line)}
  .main-menu-brand{min-width:0}.main-menu-brand b{font-size:14px;letter-spacing:2.7px}.main-menu-brand small{font-size:8px;letter-spacing:1.7px;color:#8fa4ac}
  .main-menu-mark,.garage-brand-mark{background:linear-gradient(145deg,#ecc47d,#b37839);color:#172027;box-shadow:0 5px 22px #e1aa5533}
  .main-menu-body{grid-template-columns:190px minmax(0,1fr)}.main-menu-nav{padding:24px 14px;background:#0b1318dd;border-color:var(--ta-line)}
  .main-menu-nav button{height:48px;border-radius:5px;color:#a9b6bb;letter-spacing:1.1px}.main-menu-nav button.active{border-color:#d0a45b52;background:linear-gradient(90deg,#c48f3d24,#c48f3d08);color:#f4ddb0;box-shadow:inset 3px 0 var(--ta-gold)}
  .main-menu-nav button i{color:var(--ta-gold)}.main-menu-nav-footer{font-size:8px;color:#92a1a5}.main-menu-nav-footer i{background:#75cba0;box-shadow:0 0 9px #75cba077}
  .main-menu-content{padding:clamp(24px,3.4vw,48px);background:radial-gradient(ellipse at 70% 0%,#263b4528,transparent 60%)}
  .main-menu-panel[data-menu-section="battle"]>h1{font-size:clamp(30px,3vw,42px);letter-spacing:-1.1px}.main-menu-panel[data-menu-section="battle"]>p{color:#a7b5b9;font-size:13px}
  .battle-toolbar{margin-block:18px 14px;padding-bottom:14px;border-color:var(--ta-line)}.battle-filter-tabs{gap:5px}.battle-filter-tabs button{height:36px;padding-inline:13px;border-radius:4px;color:#a6b3b8;font-size:9px;letter-spacing:.7px}.battle-filter-tabs button.active{border-color:#75c9bc4d;background:#25534f66;color:#c4f2e9}
  .battle-search{height:38px;border-radius:4px;border-color:#ffffff20;background:#0c151a}.battle-list-layout{grid-template-columns:minmax(0,1.35fr) minmax(285px,.8fr);gap:18px}
  .battle-browser-left{display:flex;flex-direction:column;gap:12px;min-width:0}.local-battle-list,.battle-details,.online-room-list{overflow:hidden;border:1px solid #ffffff1b;border-radius:6px;background:linear-gradient(150deg,#141f25,#0d151a);box-shadow:0 14px 32px #0003}
  .local-battle-list>header{height:48px;padding-inline:16px;background:#ffffff05;border-color:var(--ta-line)}.local-battle-list>header b{font-size:9px;letter-spacing:1.3px}.local-battle-list>header span{color:#8fa1a7}
  .battle-list-columns{padding:10px 14px;background:#ffffff04;color:#70858d}.local-battle-row{min-height:72px;padding:10px 14px;border-color:#ffffff0d;transition:background .15s ease,box-shadow .15s ease}.local-battle-row:hover{background:#ffffff08}.local-battle-row.active{background:linear-gradient(90deg,#b8833720,#b8833708);box-shadow:inset 3px 0 var(--ta-gold)}
  .local-battle-row>span b{font-size:12px;color:#e8edef}.local-battle-row>span small{color:#90a0a5;letter-spacing:.6px}.battle-map-thumb{border-radius:3px}.local-battle-row strong{border-radius:3px;border-color:#55776566;background:#203a30;color:#b7d7bc;font-size:8px}
  .online-room-list>header{height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid #ffffff12;background:#ffffff04;color:#dce5e5;font-size:9px;letter-spacing:1px}.online-room-list>header span{color:#87c9bb;font-size:8px}.online-room-row{display:grid;grid-template-columns:minmax(0,1fr) 54px 70px;align-items:center;gap:10px;min-height:56px;padding:8px 12px;border-bottom:1px solid #ffffff0d}.online-room-row>div{min-width:0}.online-room-row b,.online-room-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.online-room-row b{color:#e6eeee;font-size:11px}.online-room-row small{margin-top:4px;color:#91a3a9;font-size:8px;letter-spacing:.4px}.online-room-population{text-align:center;color:#c4d2d2;font-size:9px;font-variant-numeric:tabular-nums}.online-room-join{height:30px;border:1px solid #59938a66;border-radius:3px;background:#183c36;color:#b7e7db;font-size:8px;font-weight:800;letter-spacing:.7px;cursor:pointer}.online-room-join:hover:not(:disabled){background:#23554d}.online-room-join:disabled{opacity:.45;cursor:default}.online-room-empty{padding:13px;color:#8d9fa4;font-size:10px;line-height:1.4}.online-nav-status.offline{color:#ba9484}.online-nav-status.offline i{background:#ad6857;box-shadow:0 0 8px #ad685755}.online-create-button{min-height:44px;padding:0 16px;border:1px solid #5db7a766;border-radius:4px;background:linear-gradient(110deg,#1c4b45,#142e31);color:#b9e5d8;font-size:9px;font-weight:bold;letter-spacing:.8px;cursor:pointer}.online-create-button:hover{filter:brightness(1.15)}
  .battle-details{display:flex;flex-direction:column}.battle-details-banner{min-height:175px;background-color:#16232a}.battle-details-banner img{filter:saturate(.86) brightness(.78)}.battle-details-banner:after{background:linear-gradient(0deg,#0d151a 0%,#0d151a00 85%)}
  .battle-details-body{flex:1;padding:20px}.battle-details-body h2{font-size:18px;letter-spacing:-.3px}.battle-details-body p{color:#aab7bb;font-size:12px;line-height:1.6}.battle-detail-stats span{border-radius:4px;border-color:#ffffff18;background:#ffffff04}.battle-detail-stats b{color:#e7d0a4}.battle-details-body>.main-menu-play,.battle-create-open{height:44px;border-radius:4px}
  .battle-browser-footer{margin-top:18px;color:#75888d}.battle-browser-footer span:first-child{color:#9cc4aa}
  .main-menu-play,.main-menu-secondary,.battle-create-open,.garage-return,.garage-secondary-action{border-radius:4px;letter-spacing:.8px}.main-menu-play{background:linear-gradient(110deg,#b57e39,#80562b);border-color:#e0b36c;color:#fff2d4;box-shadow:0 8px 24px #b57e3922}.main-menu-play:hover,.main-menu-secondary:hover,.battle-create-open:hover,.garage-secondary-action:hover{filter:brightness(1.12);transform:translateY(-1px)}
  .battle-create-open,.main-menu-secondary{border-radius:4px}.battle-create-open{border-color:#ffffff24;background:#ffffff05;color:#cad5d8}
  .garage-shell{border:1px solid #b9d4dc2b;border-radius:8px;background:linear-gradient(145deg,#101a20f7,#091116f7);box-shadow:0 32px 100px #000b}.garage-topbar{background:linear-gradient(90deg,#1c2a31,#10181d);border-color:var(--ta-line)}.garage-nav{background:#0b1318}.garage-nav-item{border-radius:4px}.garage-section,.garage-rank-card{border-radius:5px}.garage-section select,.create-battle-settings input,.create-battle-settings select{border-radius:4px}
  .hud-panel{width:min(310px,calc(100vw - 24px));gap:7px 12px;padding:14px 15px;border:1px solid #d6e5e726;border-radius:7px;background:linear-gradient(145deg,#0b141bed,#081015e8);box-shadow:0 14px 38px #0006,inset 0 1px #ffffff0b;backdrop-filter:blur(8px);font-size:11px}
  .hud-panel strong{color:#f0d29b;font-size:12px;letter-spacing:1.8px}.hud-panel>span{color:#d1dcdf}.hud-panel #team-text{color:#90d4ca}.hud-panel #health-text{font-variant-numeric:tabular-nums;color:#eaf0ef}.health-track{height:7px;border-radius:2px;background:#4a2529}.health-track #health-fill{border-radius:2px;background:linear-gradient(90deg,#51ae7a,#b9d879)}
  #wave-text{position:fixed;top:16px;left:50%;z-index:11;transform:translateX(-50%);width:max-content;max-width:min(65vw,600px);padding:10px 18px;border:1px solid #ffffff20;border-radius:5px;background:#0b1419dd;color:#f0d9aa!important;text-align:center;font-size:11px;font-weight:800;letter-spacing:1.1px;box-shadow:0 8px 24px #0005;backdrop-filter:blur(8px)}
  #wave-banner{top:74px!important;left:50%;width:max-content;max-width:min(680px,calc(100vw - 30px));padding:11px 20px;border:1px solid #e0b36c55;border-radius:5px;background:#10191feF;color:#f3dfb8!important;font-size:13px!important;line-height:1.45;text-shadow:none!important;box-shadow:0 14px 36px #0007;letter-spacing:.8px}
  #ctf-objective{color:#c4d0d1;border-color:#ffffff18}.tactical-radar{border-radius:6px!important;border-color:#d6e5e726!important;background:linear-gradient(145deg,#0b141bed,#081015e8)!important;box-shadow:0 14px 38px #0006!important;backdrop-filter:blur(8px)}
  #help{left:50%;bottom:15px;transform:translateX(-50%);width:max-content;max-width:min(780px,calc(100vw - 24px));padding:9px 14px;border:1px solid #d6e5e71c;border-radius:5px;background:#091116de;color:#c1cdcf;font-size:10px;line-height:1.5;opacity:.88;text-align:center;box-shadow:0 10px 30px #0005}
  #crosshair{color:#f5e9cb;font-size:24px;text-shadow:0 0 5px #000,0 0 14px #ebc47788}.main-menu-open{top:20px;right:clamp(205px,17vw,250px);border:1px solid #ffffff28;border-radius:4px;background:#0b1419dd;color:#ead4a8;box-shadow:0 8px 22px #0004}
  #tank-arena-fps.performance-readout{font-variant-numeric:tabular-nums}
  @media(max-width:900px){#main-menu{padding:8px}.main-menu-shell{height:96vh;min-height:0}.main-menu-body{grid-template-columns:60px minmax(0,1fr)}.main-menu-nav{padding-inline:5px}.main-menu-nav button{justify-content:center;padding:0}.main-menu-nav button span,.main-menu-nav-footer{display:none}.battle-list-layout{grid-template-columns:1fr}.battle-details{display:grid;grid-template-columns:minmax(140px,.7fr) minmax(0,1fr)}.battle-details-banner{min-height:100%}.main-menu-open{right:190px}.garage-controls>[data-garage-section].active{grid-column:1/-1}.garage-item-grid[data-grid-for="tank-class"]{grid-template-columns:1fr}.garage-item-grid[data-grid-for="tank-class"] .garage-item-card{grid-template-columns:42px minmax(0,1fr);column-gap:7px;min-height:60px}.garage-item-card.tank-class-card b{font-size:9px;white-space:normal;overflow-wrap:anywhere}.garage-item-card.tank-class-card small{font-size:8px;white-space:normal;overflow-wrap:anywhere}}
  @media(max-width:600px){.main-menu-header{height:60px;flex-basis:60px;padding-inline:12px}.main-menu-content{padding:14px}.main-menu-panel[data-menu-section="battle"]>h1{font-size:27px}.local-battle-row{grid-template-columns:32px minmax(0,1fr) 42px 50px;gap:5px;min-height:60px;padding:8px 7px}.local-battle-row>span{min-width:0}.local-battle-row>span b{font-size:9px;white-space:normal}.local-battle-row>span small{font-size:6.5px;line-height:1.2;white-space:normal}.local-battle-row .battle-map-thumb{width:32px!important;height:32px!important}.local-battle-row .battle-population{font-size:7px}.local-battle-row strong{font-size:6px;letter-spacing:.3px}.battle-list-columns{grid-template-columns:minmax(0,1fr) 42px 50px}.battle-details{display:block}.battle-details-banner{min-height:110px}.hud-panel{width:min(282px,calc(100vw - 16px));padding:10px}.tactical-radar{right:8px!important;top:8px!important;width:100px!important;padding:5px!important}#help{bottom:8px;width:calc(100vw - 16px);font-size:9px}#wave-text{top:8px;font-size:9px}#wave-banner{top:54px!important;font-size:11px!important;padding:8px 12px}}
  @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important}}
`;
document.head.appendChild(productFinishStyle);
const compactBattleHudStyle = document.createElement('style');
compactBattleHudStyle.textContent = `
  .online-room-actions{display:flex;align-items:center;gap:10px}.online-room-actions button{height:26px;padding:0 9px;border:1px solid #5db7a766;border-radius:3px;background:#183c36;color:#b9e5d8;font-size:8px;font-weight:800;letter-spacing:.5px;cursor:pointer}
  @media(max-width:900px){
    .battle-browser-left .online-room-list{order:-1}
    #wave-banner{top:226px!important;left:12px!important;right:auto!important;transform:none!important;max-width:min(620px,calc(100vw - 24px));text-align:left}
    #wave-text{top:282px!important;left:12px!important;transform:none!important;max-width:min(620px,calc(100vw - 24px));text-align:left}
  }
`;
document.head.appendChild(compactBattleHudStyle);

const healthText = document.getElementById('health-text')!;
const healthFill = document.getElementById('health-fill')!;
const killsText = document.getElementById('kills-text')!;
const creditsText = document.getElementById('credits-text')!;
const weaponText = document.getElementById('weapon-text')!;
const enemyText = document.getElementById('enemy-text')!;
const teamText = document.getElementById('team-text')!;
const powerText = document.getElementById('power-text')!;
const waveText = document.getElementById('wave-text')!;
// O placar fica no nível do HUD, fora do painel de status. Além de liberar
// espaço para vida/equipe, isso mantém o posicionamento fixo relativo à tela.
hud.appendChild(waveText);
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
garagePreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
garagePreviewRenderer.setClearColor(0x000000, 0);
Object.assign(garagePreviewRenderer.domElement.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', zIndex: '1', pointerEvents: 'auto', cursor: 'grab', touchAction: 'none' });
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
const garageBayWall = new THREE.Mesh(
  new THREE.PlaneGeometry(22, 9),
  new THREE.MeshStandardMaterial({ color: 0x252e29, roughness: 0.92, metalness: 0.12, side: THREE.DoubleSide })
);
garageBayWall.position.set(0, 3.35, 4.7);
garagePreviewScene.add(garageBayWall);
const garageBayRibGeometry = new THREE.BoxGeometry(0.11, 6.1, 0.12);
const garageBayRibMaterial = new THREE.MeshStandardMaterial({ color: 0x39443b, roughness: 0.76, metalness: 0.28 });
const garageBayRibs = new THREE.InstancedMesh(garageBayRibGeometry, garageBayRibMaterial, 9);
const garageBayRibMatrix = new THREE.Matrix4();
for (let i = 0; i < 9; i++) {
  garageBayRibMatrix.makeTranslation(-8 + i * 2, 3.15, 4.58);
  garageBayRibs.setMatrixAt(i, garageBayRibMatrix);
}
garagePreviewScene.add(garageBayRibs);
const garageBayLightGeometry = new THREE.BoxGeometry(2.6, 0.035, 0.045);
const garageBayLightMaterial = new THREE.MeshBasicMaterial({ color: 0xa9b77a });
const garageBayLights = new THREE.InstancedMesh(garageBayLightGeometry, garageBayLightMaterial, 3);
for (let i = 0; i < 3; i++) {
  garageBayRibMatrix.makeTranslation(-5 + i * 5, 6.45, 4.5);
  garageBayLights.setMatrixAt(i, garageBayRibMatrix);
}
garagePreviewScene.add(garageBayLights);
const garagePreviewFloor = new THREE.Mesh(
  new THREE.CylinderGeometry(4.8, 5.05, 0.18, 48, 1),
  new THREE.MeshStandardMaterial({ color: 0x30372f, roughness: 0.67, metalness: 0.38 })
);
garagePreviewFloor.position.set(0, -0.13, 0);
garagePreviewScene.add(garagePreviewFloor);
// Plataforma de manutenção: aros discretos em metal fosco, sem linhas holográficas.
const garagePreviewRingMaterial = new THREE.MeshStandardMaterial({ color: 0x6d7651, metalness: 0.48, roughness: 0.5 });
const garagePreviewRing = new THREE.Mesh(new THREE.TorusGeometry(4.05, 0.045, 6, 56), garagePreviewRingMaterial);
garagePreviewRing.rotation.x = Math.PI / 2;
garagePreviewRing.position.set(0, 0.025, 0);
garagePreviewScene.add(garagePreviewRing);
const garagePreviewInnerRing = new THREE.Mesh(new THREE.TorusGeometry(3.35, 0.018, 5, 48), new THREE.MeshStandardMaterial({ color: 0x566058, metalness: 0.4, roughness: 0.55 }));
garagePreviewInnerRing.rotation.x = Math.PI / 2;
garagePreviewInnerRing.position.set(0, 0.018, 0);
garagePreviewScene.add(garagePreviewInnerRing);
const garagePreviewCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 80);
garagePreviewCamera.position.set(6.8, 4.8, -8.0);
garagePreviewCamera.lookAt(0, 0.85, 0);
let garagePreviewDragging = false;
garagePreviewRenderer.domElement.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  garagePreviewDragging = true;
  garagePreviewRenderer.domElement.style.cursor = 'grabbing';
  garagePreviewRenderer.domElement.setPointerCapture(event.pointerId);
});
garagePreviewRenderer.domElement.addEventListener('pointermove', event => {
  if (!garagePreviewDragging) return;
  garagePreviewTank.rotation.y += event.movementX * 0.009;
});
const stopGaragePreviewDrag = () => {
  garagePreviewDragging = false;
  garagePreviewRenderer.domElement.style.cursor = 'grab';
};
garagePreviewRenderer.domElement.addEventListener('pointerup', stopGaragePreviewDrag);
garagePreviewRenderer.domElement.addEventListener('pointercancel', stopGaragePreviewDrag);
garagePreviewRenderer.domElement.addEventListener('lostpointercapture', stopGaragePreviewDrag);
garagePreviewRenderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
function resizeGaragePreview() {
  const width = Math.max(1, Math.floor(garagePreviewElement.clientWidth));
  const height = Math.max(1, Math.floor(garagePreviewElement.clientHeight));
  if (width < 2 || height < 2) return;
  garagePreviewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
  garagePreviewRenderer.setSize(width, height, false);
  garagePreviewCamera.aspect = width / height;
  garagePreviewCamera.updateProjectionMatrix();
  // Enquadra o tanque INTEIRO, mesmo se a caixa da prévia for estreita ou baixa.
  const vFov = THREE.MathUtils.degToRad(garagePreviewCamera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * garagePreviewCamera.aspect);
  const distance = garagePreviewRadius * 0.95 / Math.sin(Math.min(vFov, hFov) / 2);
  garagePreviewCamera.position.copy(new THREE.Vector3(6.8, 3.95, -8.0).normalize().multiplyScalar(distance)).add(garagePreviewFocus);
  const lookAt = garagePreviewFocus.clone();
  lookAt.y += garagePreviewRadius * 0.12;
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
minimap.width = 256;
minimap.height = 256;
minimap.id = 'minimap';
const minimapFrame = document.createElement('section');
minimapFrame.className = 'tactical-radar';
const minimapSize = Math.min(204, Math.max(112, window.innerWidth * 0.16));
Object.assign(minimapFrame.style, {
  position: 'fixed',
  right: '20px',
  top: '20px',
  width: `${minimapSize}px`,
  padding: '8px',
  zIndex: '20',
  background: 'linear-gradient(145deg, rgba(13,24,29,.94), rgba(5,12,16,.90))',
  border: '1px solid rgba(151,196,194,.38)',
  borderRadius: '3px',
  boxShadow: '0 12px 34px rgba(0,0,0,.35), inset 0 1px rgba(255,255,255,.06)',
  pointerEvents: 'none'
});
const radarHeader = document.createElement('header');
radarHeader.innerHTML = '<span>RADAR TÁTICO</span><i><b></b> AO VIVO</i>';
Object.assign(radarHeader.style, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '22px', padding: '0 2px 6px', color: '#b9d1d0', font: '700 8px/1 Arial,sans-serif', letterSpacing: '1.1px' });
Object.assign(radarHeader.querySelector('i')!.style, { display: 'flex', alignItems: 'center', gap: '5px', color: '#7fa39f', font: '700 7px/1 Arial,sans-serif', letterSpacing: '.7px', fontStyle: 'normal' });
Object.assign(radarHeader.querySelector('b')!.style, { width: '5px', height: '5px', borderRadius: '50%', background: '#6fe0ac', boxShadow: '0 0 8px #6fe0ac', display: 'inline-block' });
Object.assign(minimap.style, { display: 'block', width: '100%', height: 'auto', aspectRatio: '1', border: '1px solid rgba(173,208,201,.30)', borderRadius: '2px', imageRendering: 'auto' });
minimapFrame.append(radarHeader, minimap);
document.body.appendChild(minimapFrame);
const minimapContext = minimap.getContext('2d')!;
let minimapTimer = 0;

function drawMinimap(delta: number) {
  minimapTimer -= delta;
  if (minimapTimer > 0) return;
  minimapTimer = 0.15;

  const ctx = minimapContext;
  const size = minimap.width;
  const margin = 18;
  const usable = size - margin * 2;
  const scale = usable / 112;
  const mapX = (x: number) => margin + (x + 56) * scale;
  const mapZ = (z: number) => margin + (z + 56) * scale;

  ctx.clearRect(0, 0, size, size);
  const minimapTerrain: Record<MapStyle, string> = { field: '#27352b', desert: '#554a36', industrial: '#30383d', canyon: '#514235', snow: '#394650', harbor: '#30444a', volcano: '#3f302e', metropolis: '#363d42', swamp: '#29382c', moon: '#262a34' };
  ctx.fillStyle = minimapTerrain[mapStyleName];
  ctx.fillRect(margin, margin, usable, usable);

  ctx.strokeStyle = 'rgba(173,205,194,.10)';
  ctx.lineWidth = 1;
  for (let grid = 1; grid < 4; grid++) {
    const line = margin + usable * grid / 4;
    ctx.beginPath(); ctx.moveTo(line, margin); ctx.lineTo(line, margin + usable); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin, line); ctx.lineTo(margin + usable, line); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(146,177,159,.28)';
  ctx.fillRect(mapX(-56), mapZ(-2.6), usable, Math.max(2, 5.2 * scale));
  ctx.fillRect(mapX(-2.6), mapZ(-56), Math.max(2, 5.2 * scale), usable);

  ctx.fillStyle = 'rgba(195,207,194,.62)';
  for (const obstacle of obstacles) {
    if (obstacle.style && obstacle.style !== mapStyleName) continue;
    ctx.save();
    ctx.translate(mapX(obstacle.center.x), mapZ(obstacle.center.z));
    ctx.rotate(-(obstacle.rotation ?? 0));
    if (obstacle.shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(0, 0, obstacle.halfX * scale, obstacle.halfZ * scale, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-obstacle.halfX * scale, -obstacle.halfZ * scale, obstacle.halfX * 2 * scale, obstacle.halfZ * 2 * scale);
    }
    ctx.restore();
  }

  ctx.fillStyle = 'rgba(20,20,20,0.9)';
  ctx.beginPath();
  ctx.arc(mapX(-34), mapZ(-34), 5 * scale, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(245,245,245,0.95)';
  ctx.beginPath();
  ctx.arc(mapX(34), mapZ(34), 5 * scale, 0, Math.PI * 2);
  ctx.fill();

  if (gameMode === 'ctf') {
    for (const team of ['black', 'white'] as Team[]) {
      const flag = flags[team];
      if (!flag?.mesh.visible) continue;
      const x = mapX(flag.mesh.position.x), z = mapZ(flag.mesh.position.z);
      ctx.fillStyle = team === 'black' ? '#f2a45e' : '#69d8ef';
      ctx.fillRect(x - 4, z - 5, 8, 10);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(x - 4, z - 5, 8, 10);
    }
  }

  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    ctx.fillStyle = gameMode !== 'ffa' && enemy.team === playerTeam ? '#80df8d' : '#ff6767';
    ctx.beginPath();
    ctx.arc(
      mapX(enemy.parts.root.position.x),
      mapZ(enemy.parts.root.position.z),
      5.2, 0, Math.PI * 2
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

  const playerX = mapX(player.position.x), playerZ = mapZ(player.position.z);
  const viewRadius = usable * 0.23;
  const viewAngle = -player.rotation.y - (playerTurret.rotation.y || 0);
  ctx.beginPath();
  ctx.moveTo(playerX, playerZ);
  ctx.arc(playerX, playerZ, viewRadius, viewAngle - 0.45, viewAngle + 0.45);
  ctx.closePath();
  ctx.fillStyle = 'rgba(111,213,197,.075)';
  ctx.fill();

  ctx.strokeStyle = 'rgba(184,216,207,.54)';
  ctx.lineWidth = 1.5;
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
  creditsText.textContent = `Cristais: ${playerCrystals}`;
  weaponText.textContent = `Arma: ${{ cannon: 'Canhão', rapid: 'Autocanhão', mortar: 'Obuseiro', plasma: 'Pulso', ricochet: 'Ricochete' }[selectedWeapon]} (${selectedWeapon === 'cannon' ? 1 : selectedWeapon === 'rapid' ? 2 : selectedWeapon === 'mortar' ? 3 : selectedWeapon === 'plasma' ? 4 : 5})`;
  enemyText.textContent = gameMode === 'ffa'
    ? `Adversários vivos: ${enemies.filter(e => e.alive).length}`
    : `Bots vivos: ${enemies.filter(e => e.alive).length} · Preto ${enemies.filter(e => e.alive && e.team === 'black').length} / Branco ${enemies.filter(e => e.alive && e.team === 'white').length}`;
  teamText.textContent = gameMode === 'ffa' ? 'MODO: CADA UM POR SI' : `Time: ${playerTeam === 'black' ? 'Preto' : 'Branco'}`;
  const activePowers = [
    powerDamageTimer > 0 ? `Dano 2x ${Math.ceil(powerDamageTimer)}s` : '',
    powerArmorTimer > 0 ? `Blindagem 2x ${Math.ceil(powerArmorTimer)}s` : '',
    powerSpeedTimer > 0 ? `Velocidade 2x ${Math.ceil(powerSpeedTimer)}s` : ''
  ].filter(Boolean);
  powerText.textContent = activePowers.length ? activePowers.join(' · ') : `Caixas restantes: ${crateQueue.length + crates.length}`;
  waveText.textContent = gameMode === 'survival' ? `Onda: ${currentWave}` : gameMode === 'ctf' ? `PLACAR — PRETO ${ctfScore.black} x BRANCO ${ctfScore.white} · FUNDO ${battleFund} ◈` : `ELIMINAÇÕES ${playerBattleKills} · TEMPO ${Math.ceil(matchTime)}s`;
  const ownFlag = flags[playerTeam];
  ctfObjective.textContent = gameMode === 'ffa' ? 'Objetivo: cada tanque por si — elimine todos' : gameMode !== 'ctf' ? 'Objetivo: elimine os adversários' : playerFlagCarrying ? 'OBJETIVO: volte à sua base com a bandeira!' : ownFlag.dropped ? 'OBJETIVO: recupere a bandeira da sua equipe!' : 'OBJETIVO: encoste na bandeira inimiga e retorne à sua base';
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
  refreshGarageItemGrids();
}

const garageCardSelects = ['tank-class', 'tank-weapon', 'tank-color', 'tank-style', 'tank-upgrade', 'graphics-quality', 'garage-player-count', 'map-style', 'lighting-mode', 'game-mode'];
function refreshGarageItemGrids() {
  for (const id of garageCardSelects) {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    if (!select) continue;
    select.classList.add('garage-native-choice');
    let grid = select.nextElementSibling as HTMLElement | null;
    if (!grid?.classList.contains('garage-item-grid')) {
      grid = document.createElement('div');
      grid.className = 'garage-item-grid';
      grid.dataset.gridFor = id;
      select.insertAdjacentElement('afterend', grid);
    }
    grid.replaceChildren();
    for (const option of Array.from(select.options)) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `garage-item-card${option.value === select.value ? ' selected' : ''}`;
      card.disabled = option.disabled;
      card.setAttribute('aria-pressed', String(option.value === select.value));
      const label = option.dataset.baseLabel ?? option.textContent ?? '';
      const [name, detail = ''] = label.split(' — ', 2);
      if (id === 'tank-class') {
        card.classList.add('tank-class-card');
        card.dataset.vehicleClass = option.value;
        const icon = document.createElement('span');
        icon.className = 'tank-class-icon';
        icon.innerHTML = '<svg viewBox="0 0 64 48" aria-hidden="true"><path class="tread" d="M8 5h10v38H8zM46 5h10v38H46z"/><path class="hull" d="M19 7h27v34H19z"/><path class="turret" d="M25 15h15v18H25z"/><path class="barrel" d="M31 5h4v14h-4z"/><path class="detail" d="M21 10h3v28h-3zM41 10h3v28h-3z"/></svg>';
        card.append(icon);
      } else if (id === 'tank-weapon') {
        card.classList.add('tank-weapon-card');
        const icon = document.createElement('span');
        icon.className = 'weapon-class-icon';
        icon.innerHTML = '<svg viewBox="0 0 64 48" aria-hidden="true"><path class="base" d="M11 26h42v11H11z"/><path class="turret" d="M20 16h25v13H20z"/><path class="barrel" d="M31 3h5v19h-5z"/><circle class="bore" cx="33.5" cy="5" r="2"/></svg>';
        card.append(icon);
      }
      if (id === 'tank-color') {
        const chip = document.createElement('span');
        chip.className = 'garage-paint-chip';
        const paintHex = Number(option.value);
        chip.style.background = option.value === RAINBOW_PAINT_ID
          ? 'url("/paint-previews/rainbow-striped.svg") center / cover'
          : Number.isFinite(paintHex) ? `linear-gradient(135deg,#ffffff44,transparent 40%),linear-gradient(110deg,#0003,transparent 45%,#fff2),#${paintHex.toString(16).padStart(6, '0')}` : '#354047';
        card.append(chip);
      }
      const title = document.createElement('b'); title.textContent = name.trim(); card.append(title);
      const description = detail.trim() || (id === 'tank-color' ? ownedPaints.has(option.value) ? 'Pintura disponível' : 'Obtenha em contêiner' : 'Selecionar configuração');
      const small = document.createElement('small'); small.textContent = description; card.append(small);
      if (id === 'tank-color' && !ownedPaints.has(option.value)) {
        const locked = document.createElement('em'); locked.textContent = 'CONTÊINER'; card.append(locked);
      } else if (option.value === select.value) {
        const equipped = document.createElement('span'); equipped.className = 'garage-item-equipped'; equipped.textContent = 'EQUIPADO'; card.append(equipped);
      }
      card.addEventListener('click', () => {
        if (option.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        refreshGarageItemGrids();
      });
      grid.append(card);
    }
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
let garageReturnToMenu = false;
let performanceReadoutEnabled = false;

function setLobbyOverlayVisibility(visible: boolean) {
  hud.classList.toggle('overlay-open', visible);
  minimapFrame.style.visibility = visible ? 'hidden' : 'visible';
  fpsHud.style.visibility = visible || !performanceReadoutEnabled ? 'hidden' : 'visible';
}

function showMainMenu() {
  if (garageOpen) closeGarage();
  mainMenuOpen = true;
  syncMobileControls();
  setLobbyOverlayVisibility(true);
  mainMenu.classList.remove('hidden');
  mainMenu.querySelectorAll('.main-menu-nav button').forEach(button => button.classList.remove('active'));
  mainMenu.querySelectorAll('.main-menu-panel').forEach(section => section.classList.remove('active'));
  mainMenu.querySelector('[data-menu-panel="battle"]')?.classList.add('active');
  mainMenu.querySelector('[data-menu-section="battle"]')?.classList.add('active');
  (mainMenu.querySelector('.battle-browser-view') as HTMLElement).hidden = false;
  (mainMenu.querySelector('.battle-create-view') as HTMLElement).hidden = true;
  (document.getElementById('main-menu-resume') as HTMLButtonElement).hidden = !battleHasStarted || matchEnded;
  (document.getElementById('main-menu-leave-header') as HTMLButtonElement).hidden = !battleHasStarted || matchEnded;
  (document.getElementById('main-menu-mode') as HTMLSelectElement).value = (document.getElementById('game-mode') as HTMLSelectElement).value;
  (document.getElementById('main-menu-team-size') as HTMLSelectElement).value = String(battleTeamSize);
  (document.getElementById('garage-player-count') as HTMLSelectElement).value = String(battleTeamSize);
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
  syncMobileControls();
  mainMenu.classList.add('hidden');
  if (!garageOpen) setLobbyOverlayVisibility(false);
  fpsFrameCount = 0;
  fpsWindowStart = performance.now();
}

function openGarage() {
  hideMainMenu();
  garageOpen = true;
  syncMobileControls();
  setLobbyOverlayVisibility(true);
  garage.classList.remove('hidden');
  setGarageTab('vehicle');
  requestAnimationFrame(resizeGaragePreview);
  const returnButton = document.getElementById('garage-close') as HTMLButtonElement;
  (document.getElementById('tank-weapon') as HTMLSelectElement).value = selectedWeapon;
  (document.getElementById('game-mode') as HTMLSelectElement).value = gameMode;
  (document.getElementById('garage-player-count') as HTMLSelectElement).value = String(battleTeamSize);
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
  syncMobileControls();
  garage.classList.add('hidden');
  if (!mainMenuOpen) setLobbyOverlayVisibility(false);
  // Zera a janela de FPS para a garagem aberta não contaminar a medição.
  fpsFrameCount = 0;
  fpsWindowStart = performance.now();
  if (garageReturnToMenu) {
    garageReturnToMenu = false;
    showMainMenu();
  }
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
const syncMainMenuObjective = () => {
  const mode = (document.getElementById('main-menu-mode') as HTMLSelectElement).value;
  const objective = document.getElementById('main-menu-objective');
  if (objective) objective.textContent = mode === 'ctf'
    ? 'Capture a bandeira inimiga e retorne à sua base'
    : mode === 'ffa' ? 'Cada tanque luta por si. Faça mais eliminações que os outros.'
    : mode === 'survival' ? 'Sobreviva às ondas e elimine a força adversária'
    : 'Elimine a equipe adversária antes do tempo acabar';
};
(document.getElementById('main-menu-mode') as HTMLSelectElement).addEventListener('change', syncMainMenuObjective);
document.getElementById('main-menu-mode')!.addEventListener('change', () => {
  const mode = (document.getElementById('main-menu-mode') as HTMLSelectElement).value;
  const size = document.getElementById('main-menu-team-size') as HTMLSelectElement;
  const twoPlayers = size.querySelector<HTMLOptionElement>('option[value="2"]')!;
  twoPlayers.disabled = mode !== 'ffa' && mode !== 'survival';
  if (twoPlayers.disabled && Number(size.value) < 4) size.value = '4';
});
const battleRows = Array.from(document.querySelectorAll<HTMLButtonElement>('.local-battle-row'));
const battleMapNames: Record<string, string> = { field: 'Campo de Operações', desert: 'Dunas', industrial: 'Complexo Industrial', canyon: 'Desfiladeiro', snow: 'Base Glacial', harbor: 'Porto de Carga', volcano: 'Cratera Vulcânica', metropolis: 'Zona Urbana', swamp: 'Pântano', moon: 'Estação Lunar' };
const battleModeNames: Record<string, string> = { ctf: 'ROUBA-BANDEIRA', deathmatch: 'MATA-MATA EM EQUIPE', ffa: 'CADA TANQUE POR SI', survival: 'SOBREVIVÊNCIA' };
function selectBattleRow(row: HTMLButtonElement) {
  battleRows.forEach(item => item.classList.toggle('active', item === row));
  const map = row.dataset.joinMap ?? 'harbor';
  const mode = row.dataset.joinMode ?? 'ctf';
  const mapName = battleMapNames[map] ?? map;
  const modeName = `${battleModeNames[mode] ?? mode} · ${mode === 'survival' ? 'NOITE' : 'DIA'}`;
  (document.getElementById('battle-detail-map') as HTMLElement).textContent = mapName;
  (document.getElementById('battle-detail-mode') as HTMLElement).textContent = modeName;
  (document.getElementById('battle-detail-players') as HTMLElement).textContent = row.querySelector('.battle-population')?.textContent ?? '5 BOTS';
  const banner = document.getElementById('battle-details-banner')!;
  banner.className = `battle-details-banner ${map}`;
  const detailImage = document.getElementById('battle-details-image') as HTMLImageElement;
  detailImage.src = `/map-previews/${map}.svg`;
  detailImage.alt = `Prévia de ${mapName}`;
  (document.getElementById('battle-detail-description') as HTMLElement).textContent = mode === 'ctf'
    ? 'Capture a bandeira inimiga e retorne à sua base. Treino local contra bots.'
    : mode === 'ffa' ? 'Sem equipes: todos os tanques são adversários. Vença pelo número de eliminações.'
    : mode === 'survival' ? 'Enfrente ondas de adversários e tente sobreviver o máximo possível.'
    : 'Elimine a equipe adversária antes do fim do tempo nesta arena local.';
}
battleRows.forEach(row => row.addEventListener('click', () => selectBattleRow(row)));
const createModeSelect = document.getElementById('main-menu-mode') as HTMLSelectElement;
const createMapSelect = document.getElementById('main-menu-map') as HTMLSelectElement;
function syncCreateMode(mode: string) {
  createModeSelect.value = mode;
  document.querySelectorAll<HTMLButtonElement>('[data-create-mode]').forEach(button => button.classList.toggle('active', button.dataset.createMode === mode));
  createModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
}
function syncCreateMap(map: string) {
  createMapSelect.value = map;
  document.querySelectorAll<HTMLButtonElement>('[data-create-map]').forEach(button => button.classList.toggle('active', button.dataset.createMap === map));
  const mapName = battleMapNames[map] ?? map;
  (document.getElementById('create-map-preview') as HTMLImageElement).src = `/map-previews/${map}.svg`;
  (document.getElementById('create-map-preview') as HTMLImageElement).alt = `Prévia de ${mapName}`;
  (document.getElementById('create-map-name') as HTMLElement).textContent = mapName;
}
document.querySelectorAll<HTMLButtonElement>('[data-create-mode]').forEach(button => button.addEventListener('click', () => syncCreateMode(button.dataset.createMode ?? 'ctf')));
document.querySelectorAll<HTMLButtonElement>('[data-create-map]').forEach(button => button.addEventListener('click', () => syncCreateMap(button.dataset.createMap ?? 'field')));
syncCreateMode('ctf');
syncCreateMap('harbor');
document.querySelectorAll<HTMLButtonElement>('[data-battle-filter]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll<HTMLButtonElement>('[data-battle-filter]').forEach(item => item.classList.toggle('active', item === button));
  const filter = button.dataset.battleFilter ?? 'all';
  const term = (document.getElementById('battle-search-input') as HTMLInputElement).value.trim().toLocaleLowerCase('pt-BR');
  battleRows.forEach(row => {
    const visible = (filter === 'all' || row.dataset.joinMode === filter) && row.textContent?.toLocaleLowerCase('pt-BR').includes(term);
    row.hidden = !visible;
  });
  const visibleRows = battleRows.filter(row => !row.hidden);
  (mainMenu.querySelector('.battle-empty-state') as HTMLElement).hidden = visibleRows.length > 0;
  if (visibleRows.length && !visibleRows.some(row => row.classList.contains('active'))) selectBattleRow(visibleRows[0]);
}));
function filterBattleList() {
  const activeFilter = mainMenu.querySelector<HTMLButtonElement>('[data-battle-filter].active')?.dataset.battleFilter ?? 'all';
  const term = (document.getElementById('battle-search-input') as HTMLInputElement).value.trim().toLocaleLowerCase('pt-BR');
  battleRows.forEach(row => { row.hidden = (activeFilter !== 'all' && row.dataset.joinMode !== activeFilter) || !row.textContent?.toLocaleLowerCase('pt-BR').includes(term); });
  const visibleRows = battleRows.filter(row => !row.hidden);
  (mainMenu.querySelector('.battle-empty-state') as HTMLElement).hidden = visibleRows.length > 0;
  if (visibleRows.length && !visibleRows.some(row => row.classList.contains('active'))) selectBattleRow(visibleRows[0]);
}
(document.getElementById('battle-search-input') as HTMLInputElement).addEventListener('input', filterBattleList);
(document.getElementById('create-battle-open') as HTMLButtonElement).addEventListener('click', () => {
  (mainMenu.querySelector('.battle-browser-view') as HTMLElement).hidden = true;
  (mainMenu.querySelector('.battle-create-view') as HTMLElement).hidden = false;
  syncCreateMode(createModeSelect.value);
  syncCreateMap(createMapSelect.value);
});
(document.getElementById('battle-create-back') as HTMLButtonElement).addEventListener('click', () => {
  (mainMenu.querySelector('.battle-browser-view') as HTMLElement).hidden = false;
  (mainMenu.querySelector('.battle-create-view') as HTMLElement).hidden = true;
});
(document.getElementById('join-selected-battle') as HTMLButtonElement).addEventListener('click', () => {
  const row = battleRows.find(item => item.classList.contains('active'));
  if (!row) return;
  (document.getElementById('main-menu-mode') as HTMLSelectElement).value = row.dataset.joinMode ?? 'ctf';
  (document.getElementById('main-menu-map') as HTMLSelectElement).value = row.dataset.joinMap ?? 'harbor';
  (document.getElementById('main-menu-team-size') as HTMLSelectElement).value = row.dataset.teamSize ?? '3';
  (document.getElementById('main-menu-lighting') as HTMLSelectElement).value = row.dataset.joinMode === 'survival' ? 'night' : 'day';
  syncMainMenuObjective();
  (document.getElementById('main-menu-play') as HTMLButtonElement).click();
});
document.querySelectorAll<HTMLButtonElement>('[data-menu-panel]').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('[data-menu-panel]').forEach(item => item.classList.remove('active'));
    document.querySelectorAll<HTMLElement>('[data-menu-section]').forEach(section => section.classList.remove('active'));
    button.classList.add('active');
    const section = mainMenu.querySelector(`[data-menu-section="${button.dataset.menuPanel}"]`);
    section?.classList.add('active');
  });
});
const openMenuGarage = (event: Event) => {
  const button = event.currentTarget as HTMLButtonElement;
  garageReturnToMenu = true;
  openGarage();
  if (button.dataset.garageTabTarget) setGarageTab(button.dataset.garageTabTarget);
};
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
  battleTeamSize = Number((document.getElementById('main-menu-team-size') as HTMLSelectElement).value) || 6;
  if ((menuMode.value === 'ctf' || menuMode.value === 'deathmatch') && battleTeamSize < 4) battleTeamSize = 4;
  mapSelect.value = (document.getElementById('main-menu-map') as HTMLSelectElement).value;
  mapSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const lightingSelect = document.getElementById('lighting-mode') as HTMLSelectElement;
  lightingSelect.value = (document.getElementById('main-menu-lighting') as HTMLSelectElement).value;
  lightingSelect.dispatchEvent(new Event('change', { bubbles: true }));
  battleMode.value = menuMode.value;
  battleMode.dispatchEvent(new Event('change', { bubbles: true }));
  battleHasStarted = true;
  (document.getElementById('main-menu-resume') as HTMLButtonElement).hidden = false;
  (document.getElementById('main-menu-leave-header') as HTMLButtonElement).hidden = false;
  hideMainMenu();
});
(document.getElementById('main-menu-leave') as HTMLButtonElement).addEventListener('click', () => {
  leaveBattle();
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

document.getElementById('garage-player-count')!.addEventListener('change', event => {
  const requested = Number((event.target as HTMLSelectElement).value);
  battleTeamSize = (gameMode === 'ctf' || gameMode === 'deathmatch') ? Math.max(4, requested) : requested;
  (document.getElementById('main-menu-team-size') as HTMLSelectElement).value = String(battleTeamSize);
  spawnRosterForMode();
  updateHUD();
});

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

  // Reconstrói as equipes sem alterar o modo ou a quantidade escolhidos.
  clearProjectiles();
  spawnRosterForMode();
  resetCaptureTheFlag();
  updateHUD();
  respawnMessage.textContent = `VOCÊ ESTÁ NO TIME ${playerTeam === 'black' ? 'PRETO' : 'BRANCO'}`;
  window.setTimeout(() => { respawnMessage.textContent = ''; }, 1400);
});

document.getElementById('tank-weapon')!.addEventListener('change', event => {
  const requested = (event.target as HTMLSelectElement).value as WeaponType;
  if (!['cannon', 'rapid', 'mortar', 'plasma', 'ricochet'].includes(requested)) return;
  selectedWeapon = requested;
  applyWeaponVisual(playerParts, selectedWeapon, selectedTankClass);
  syncGaragePreview();
  updateHUD();
  const status = document.getElementById('garage-status');
  if (status) status.textContent = `TORRE EQUIPADA: ${({ cannon: 'CANHÃO', rapid: 'AUTOCANHÃO', mortar: 'OBUSEIRO', plasma: 'PULSO', ricochet: 'RICOCHETE' })[selectedWeapon]}`;
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
  applyWeaponVisual(playerParts, selectedWeapon, selectedTankClass);
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
  const paintId = (event.target as HTMLSelectElement).value;
  const rainbow = paintId === RAINBOW_PAINT_ID;
  const value = rainbow ? 0xffffff : Number(paintId);
  playerPaintVariant = rainbow ? 'rainbow-striped' : 'solid';
  rainbowLivery.visible = rainbow;
  rainbowTurretLivery.visible = rainbow;

  // O conjunto é clonado para a pintura especial do jogador não alterar bots.
  const [baseMain, baseDark, baseLight] = makeTankPaintSet(0x5c6240);
  const [paintMain, paintDark, paintLight] = [baseMain, baseDark, baseLight].map(material => material.clone());
  const paintTexture = rainbow ? getRainbowPaintTexture() : getTankPaintTextures().map;
  paintMain.map = paintDark.map = paintLight.map = paintTexture;
  paintMain.color.setHex(value);
  paintDark.color.setHex(value).multiplyScalar(0.72);
  paintLight.color.setHex(value);
  paintMain.needsUpdate = paintDark.needsUpdate = paintLight.needsUpdate = true;
  playerParts.hull.material = paintMain;
  playerParts.turretBody.material = paintMain;
  playerParts.paintDetailsMaterial.map = paintTexture;
  playerParts.paintDetailsMaterial.color.setHex(value);
  playerParts.paintDetailsMaterial.needsUpdate = true;
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
  if ((upgrade === 'engine' && playerMoveMultiplier >= 1.3) || (upgrade === 'damage' && playerDamageMultiplier >= 1.6)) {
    respawnMessage.textContent = 'MELHORIA JÁ ESTÁ NO LIMITE';
    window.setTimeout(() => { respawnMessage.textContent = ''; }, 1200);
    return;
  }

  playerCredits -= 50;

  if (upgrade === 'engine') {
    upgradeLevels.engine++;
    const oldSpeed = playerMoveMultiplier;
    playerMoveMultiplier = Math.min(1.3, playerMoveMultiplier + 0.1);
    playerSpeedBonus += playerMoveMultiplier - oldSpeed;
  } else if (upgrade === 'armor') {
    upgradeLevels.armor++;
    playerHealthBonus += 20;
    playerMaxHealth += 20;
    playerHealth = Math.min(playerMaxHealth, playerHealth + 20);
    const oldArmor = playerArmor;
    playerArmor = Math.min(0.35, playerArmor + 0.1);
    playerArmorBonus += playerArmor - oldArmor;
  } else if (upgrade === 'damage') {
    upgradeLevels.damage++;
    playerDamageMultiplier = Math.min(1.6, playerDamageMultiplier + 0.15);
  }

  selector.value = 'none';
  updateHUD();
  respawnMessage.textContent = 'MELHORIA INSTALADA!';
  window.setTimeout(() => { respawnMessage.textContent = ''; }, 1200);
});

function applyQuality() {
  const useDynamicShadows = graphicsQuality === 'maximum';
  renderer.shadowMap.enabled = useDynamicShadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  sun.castShadow = useDynamicShadows;
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
  adaptiveRenderScale = 1;
  lowFpsWindows = highFpsWindows = 0;
  fxAutoDisabled = false;
  applyQuality();
  const status = document.getElementById('garage-status');
  if (status) status.textContent = `GRÁFICOS: ${quality === 'maximum' ? 'ULTRA' : quality === 'high' ? 'ALTO' : 'EQUILIBRADO'}`;
});

function applyBattleLighting() {
  const night = lightingStyle === 'night';
  const skyStyle: SkyStyle = night ? 'night' : mapStyleName;
  skyMaterial.map = getSkyTexture(skyStyle);
  skyMaterial.needsUpdate = true;
  hemi.color.setHex(night ? 0x8fa8d8 : 0xffffff);
  const groundLights: Record<MapStyle, number> = { field: 0x526044, desert: 0x7a6a45, industrial: 0x465157, canyon: 0x7a6a45, snow: 0x91a4b0, harbor: 0x536873, volcano: 0x59423c, metropolis: 0x4e5a60, swamp: 0x46553d, moon: 0x484b58 };
  hemi.groundColor.setHex(night ? 0x1a2230 : groundLights[mapStyleName]);
  hemi.intensity = night ? 1.15 : mapStyleName === 'desert' || mapStyleName === 'volcano' ? 1.7 : 1.8;
  sun.color.setHex(night ? 0x9db8ff : mapStyleName === 'desert' || mapStyleName === 'volcano' ? 0xffe2b0 : mapStyleName === 'moon' ? 0xc4d2f0 : 0xfff3dc);
  sun.intensity = night ? 1.25 : mapStyleName === 'desert' || mapStyleName === 'volcano' ? 2.7 : 2.4;
  fxLightGain = night ? 0.42 : 1;
  if (night) {
    scene.background = new THREE.Color(0x111827);
    scene.fog = new THREE.Fog(0x111827, 45, 115);
    setGridColor(0x40546b);
  } else {
    const colors: Record<MapStyle, number> = { field: 0x87b9d9, desert: 0xe0bd83, industrial: 0x788890, canyon: 0xd5b28a, snow: 0xb8d0df, harbor: 0x9bb3c1, volcano: 0x9a6b59, metropolis: 0x89959b, swamp: 0x9aaa83, moon: 0x555b68 };
    const grids: Record<MapStyle, number> = { field: 0x526b40, desert: 0x8c754e, industrial: 0x63727b, canyon: 0x8c754e, snow: 0x8099a6, harbor: 0x627d89, volcano: 0x754d42, metropolis: 0x626d73, swamp: 0x59694c, moon: 0x555a69 };
    scene.background = new THREE.Color(colors[mapStyleName]);
    scene.fog = new THREE.Fog(colors[mapStyleName], 55, 125);
    setGridColor(grids[mapStyleName]);
  }
  applyAtmosphere();
  updateBattlefieldTheme();
}

document.getElementById('map-style')!.addEventListener('change', event => {
  const nextMap = (event.target as HTMLSelectElement).value as MapStyle;
  const mapChanged = nextMap !== mapStyleName;
  mapStyleName = nextMap;
  setMapLayout(mapStyleName);
  clearBattlefieldMarks();
  if (mapChanged) {
    clearProjectiles();
    if (playerAlive) {
      player.position.copy(findSafePlayerSpawn());
      playerLinearSpeed = 0;
      previousPlayerPosition.copy(player.position);
      syncTankGearToWorld(playerParts);
    }
    spawnRosterForMode();
    resetCaptureTheFlag();
  }
  if (mapStyleName === 'desert' || mapStyleName === 'canyon') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0xb9a06f : 0xb49a63);
    dustColor.setHex(0xc9a66b);
    hillMaterial.color.setHex(0x9c8456);
  } else if (mapStyleName === 'volcano') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0x66534c : 0x453936);
    dustColor.setHex(0x9c5941);
    hillMaterial.color.setHex(0x684b43);
  } else if (mapStyleName === 'snow' || mapStyleName === 'moon') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0xc0ccd2 : 0x9cabb5);
    dustColor.setHex(0xaabac2);
    hillMaterial.color.setHex(0xc2d1dc);
  } else if (mapStyleName === 'industrial' || mapStyleName === 'metropolis') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0x737d80 : 0x485459);
    dustColor.setHex(0x777a72);
    hillMaterial.color.setHex(0x59636a);
  } else if (mapStyleName === 'harbor') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0x798987 : 0x566a69);
    dustColor.setHex(0x8a8875);
    hillMaterial.color.setHex(0x657774);
  } else if (mapStyleName === 'swamp') {
    groundMaterial.color.setHex(groundTextureLoaded ? 0x717b56 : 0x4a5a3e);
    dustColor.setHex(0x727752);
    hillMaterial.color.setHex(0x566746);
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
  gameMode = (event.target as HTMLSelectElement).value as GameMode;
  if ((gameMode === 'ctf' || gameMode === 'deathmatch') && battleTeamSize < 4) battleTeamSize = 4;
  (document.getElementById('main-menu-mode') as HTMLSelectElement).value = gameMode;
  (document.getElementById('main-menu-team-size') as HTMLSelectElement).value = String(battleTeamSize);
  (document.getElementById('garage-player-count') as HTMLSelectElement).value = String(battleTeamSize);
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
    : gameMode === 'ctf' ? 'ROUBA-BANDEIRA — 3 PONTOS PARA VENCER'
    : gameMode === 'ffa' ? 'CADA TANQUE POR SI — 3 MINUTOS'
    : 'MATA-MATA EM EQUIPES — 3 MINUTOS';
  waveBannerTimer = 2.5;

  setDecorativeFlagsVisible(gameMode === 'ctf');
  resetCaptureTheFlag();
  clearProjectiles();
  spawnRosterForMode();

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
  weapon: WeaponType;
  owner: 'player' | 'enemy';
  team: Team;
  shooter: Enemy | null;
  damage: number;
  bouncesLeft: number;
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
const playerProjectileMaterial = new THREE.MeshStandardMaterial({ color: 0xb8a06e, metalness: 0.62, roughness: 0.34 });
const enemyProjectileMaterial = new THREE.MeshStandardMaterial({ color: 0x99756c, metalness: 0.58, roughness: 0.38 });
const playerRapidProjectileMaterial = new THREE.MeshStandardMaterial({ color: 0xd0b98b, metalness: 0.55, roughness: 0.4 });
const playerPlasmaProjectileMaterial = new THREE.MeshStandardMaterial({ color: 0x9daca8, metalness: 0.48, roughness: 0.42 });
const enemyRapidProjectileMaterial = new THREE.MeshStandardMaterial({ color: 0xb18b80, metalness: 0.5, roughness: 0.42 });
const enemyPlasmaProjectileMaterial = new THREE.MeshStandardMaterial({ color: 0xaa9992, metalness: 0.5, roughness: 0.42 });
const ricochetProjectileMaterial = new THREE.MeshStandardMaterial({ color: 0xc17b43, metalness: 0.72, roughness: 0.27 });
const projectileTrailGeometry = new THREE.ConeGeometry(0.10,0.72,12,1,true);
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
  weapon: WeaponType = 'cannon',
  tankClass: TankClass = 'medium'
) {
  const projectileMaterial = weapon === 'rapid'
    ? (owner === 'player' ? playerRapidProjectileMaterial : enemyRapidProjectileMaterial)
    : weapon === 'plasma' ? (owner === 'player' ? playerPlasmaProjectileMaterial : enemyPlasmaProjectileMaterial)
    : weapon === 'ricochet' ? ricochetProjectileMaterial
    : owner === 'player' ? playerProjectileMaterial : enemyProjectileMaterial;
  const mesh = new THREE.Mesh(
    weapon === 'rapid' || weapon === 'plasma' || weapon === 'ricochet' ? projectileGeometry : cannonShellGeometry,
    projectileMaterial
  );

  const bodyScale = weapon === 'rapid' ? 0.62 : weapon === 'plasma' ? 1.02 : weapon === 'ricochet' ? 0.88 : weapon === 'mortar' ? 1.3 : tankClass === 'artillery' ? 1.18 : tankClass === 'heavy' ? 1.08 : 1;
  mesh.scale.setScalar(bodyScale);
  mesh.position.copy(origin);
  const trail = new THREE.Mesh(projectileTrailGeometry, projectileMaterial);
  trail.rotation.x = Math.PI / 2;
  trail.position.z = weapon === 'rapid' ? -0.20 : -0.29;
  trail.scale.setScalar(weapon === 'rapid' ? 0.7 : 1);
  mesh.add(trail);
  mesh.quaternion.setFromUnitVectors(projectileForward,direction.clone().normalize());
  scene.add(mesh);

  // A munição leva o perfil de quem disparou; a arma atualmente selecionada
  // pelo jogador não pode alterar tiros que já estão no ar nem tiros dos bots.
  const speed = weapon === 'rapid' ? (owner === 'player' ? 30 : 31)
    : weapon === 'plasma' ? 25 : weapon === 'ricochet' ? 31 : weapon === 'mortar' ? 25
    : tankClass === 'artillery' ? 42 : tankClass === 'heavy' ? 30 : 34;
  const normalizedDirection = direction.clone().normalize();
  const velocity = normalizedDirection.clone().multiplyScalar(speed);
  if (weapon === 'mortar') velocity.y = 9;
  projectiles.push({
    mesh,
    direction: normalizedDirection,
    velocity,
    gravity: weapon === 'rapid' || weapon === 'plasma' ? 0.08 : weapon === 'ricochet' ? 0.65 : weapon === 'mortar' ? 7.7 : tankClass === 'artillery' ? 1.25 : 1.05,
    splashRadius: weapon === 'mortar' ? 4.8 : weapon === 'cannon' && tankClass === 'artillery' ? 3.6 : 0,
    splashScale: 0.72,
    weapon,
    owner,
    team,
    shooter,
    damage,
    bouncesLeft: weapon === 'ricochet' ? 2 : 0,
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
  const weaponDamage = selectedWeapon === 'cannon' ? 2 : selectedWeapon === 'rapid' ? 1 : selectedWeapon === 'mortar' ? 4.8 : selectedWeapon === 'ricochet' ? 1.45 : 1.55;
  const weaponCooldown = selectedWeapon === 'cannon' ? 0.48 : selectedWeapon === 'rapid' ? 0.12 : selectedWeapon === 'mortar' ? 1.12 : selectedWeapon === 'ricochet' ? 0.34 : 0.32;
  const damage = weaponDamage * classStats.damage * (powerDamageTimer > 0 ? 2 : 1);
  playerFireCooldown = weaponCooldown * classStats.fireRate;
  playerBarrelRecoil = Math.max(playerBarrelRecoil, selectedWeapon === 'rapid' || selectedWeapon === 'plasma' ? 0.09 : 0.25);

  const direction = getTurretDirection(player, playerTurret);
  const origin = (playerParts.model?.muzzle ?? DEFAULT_MUZZLE).clone();
  playerTurret.localToWorld(origin);

  createProjectile(origin, direction, 'player', damage * playerDamageMultiplier, playerTeam, null, selectedWeapon, selectedTankClass);
  if (onlineRoomId) onlineSend({ type: 'fire', team: playerTeam, shot: {
    x: origin.x, y: origin.y, z: origin.z, dx: direction.x, dy: direction.y, dz: direction.z,
    weapon: selectedWeapon, tankClass: selectedTankClass, damage: damage * playerDamageMultiplier
  } });
  const muzzleColor = selectedWeapon === 'plasma' ? 0xb4a084 : selectedWeapon === 'mortar' ? 0xff9b55 : selectedWeapon === 'ricochet' ? 0xc88954 : 0xffc060;
  createParticles(origin, muzzleColor, selectedWeapon === 'cannon' || selectedWeapon === 'mortar' ? 5 : 2);
  spawnFlash(origin, 0.5, selectedWeapon === 'mortar' ? 3.1 : selectedWeapon === 'cannon' ? 2.6 : 1.4, 0.09, muzzleColor);
  if (selectedWeapon === 'cannon' || selectedWeapon === 'mortar') { createParticles(origin, 0x55504a, 2); cameraShake = Math.max(cameraShake, selectedWeapon === 'mortar' ? 0.13 : 0.07); }
  playSound(selectedWeapon === 'rapid' ? 180 : selectedWeapon === 'plasma' ? 125 : selectedWeapon === 'mortar' ? 82 : selectedWeapon === 'ricochet' ? 145 : 110, 0.13, 0.07);
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

  const enemyWeapon: WeaponType = enemy.tankClass === 'light' || enemy.tankClass === 'scout' ? 'rapid' : enemy.tankClass === 'artillery' ? 'mortar' : 'cannon';
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
  const angle = obstacle.rotation ?? 0;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const offsetX = start.x - obstacle.center.x;
  const offsetZ = start.z - obstacle.center.z;
  const startX = offsetX * cos - offsetZ * sin;
  const startZ = offsetX * sin + offsetZ * cos;
  const moveX = movement.x * cos - movement.z * sin;
  const moveZ = movement.x * sin + movement.z * cos;
  if (obstacle.shape === 'ellipse') {
    const rx = obstacle.halfX + padding, rz = obstacle.halfZ + padding;
    const a = (moveX * moveX) / (rx * rx) + (moveZ * moveZ) / (rz * rz);
    const b = 2 * (startX * moveX / (rx * rx) + startZ * moveZ / (rz * rz));
    const c = (startX * startX) / (rx * rx) + (startZ * startZ) / (rz * rz) - 1;
    if (c <= 0) return start.y <= obstacle.height + 0.2 && start.y >= 0 ? 0 : null;
    if (a < 1e-9) return null;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0 || t > 1) return null;
    const impactY = start.y + movement.y * t;
    return impactY >= 0 && impactY <= obstacle.height + 0.2 ? t : null;
  }
  const minX = -obstacle.halfX - padding;
  const maxX = obstacle.halfX + padding;
  const minZ = -obstacle.halfZ - padding;
  const maxZ = obstacle.halfZ + padding;

  let tMin = 0;
  let tMax = 1;

  if (Math.abs(moveX) < 0.000001) {
    if (startX < minX || startX > maxX) return null;
  } else {
    const tx1 = (minX - startX) / moveX;
    const tx2 = (maxX - startX) / moveX;

    tMin = Math.max(tMin, Math.min(tx1, tx2));
    tMax = Math.min(tMax, Math.max(tx1, tx2));
  }

  if (Math.abs(moveZ) < 0.000001) {
    if (startZ < minZ || startZ > maxZ) return null;
  } else {
    const tz1 = (minZ - startZ) / moveZ;
    const tz2 = (maxZ - startZ) / moveZ;

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

  const appliedDamage = amount * armorDamageMultiplier(enemy.parts.root, TANK_CLASSES[enemy.tankClass].armor, incomingDirection);
  enemy.health -= appliedDamage;
  if (playerKill) spawnDamageNumber(enemy.parts.root.position, appliedDamage);
  showHitMarker();

  enemy.healthBar.update(enemy.health, enemy.maxHealth);
  if (enemy.health <= 0) {
    enemy.alive = false;
    enemy.respawnTimer = 5;
    if (flags[oppositeTeam(enemy.team)]?.carrier === enemy) dropFlag(oppositeTeam(enemy.team));
    if (playerKill) {
      playerKills++;
      playerBattleKills++;
      playerCredits += 10;
      updateRank();
    }
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

    const startsGroundHit = start.y >= 0.14 && end.y <= 0.14;
    let nearestT = startsGroundHit
      ? THREE.MathUtils.clamp((start.y - 0.14) / Math.max(0.0001, start.y - end.y), 0, 1)
      : Infinity;
    let hitObstacle: Obstacle | null = null;
    let hitEnemy: Enemy | null = null;
    let hitRemote: OnlineRemote | null = null;
    let hitPlayer = false;

    for (const bot of enemies) {
      if (!bot.alive || bot === projectile.shooter || (gameMode !== 'ffa' && bot.team === projectile.team)) continue;
      const center = projectileTargetCenter.copy(bot.parts.root.position);
      center.y = 0.9;
      const result = segmentDistance(start, movement, center);
      if (result.distance < 2.05 && result.t < nearestT) {
        nearestT = result.t;
        hitEnemy = bot;
        hitPlayer = false;
      }
    }

    if (projectile.owner === 'player') {
      for (const remote of onlineRemotes.values()) {
        if (!remote.alive || (gameMode !== 'ffa' && remote.team === projectile.team)) continue;
        const center = projectileTargetCenter.copy(remote.parts.root.position);
        center.y = 0.9;
        const result = segmentDistance(start, movement, center);
        if (result.distance < 2.05 && result.t < nearestT) {
          nearestT = result.t;
          hitRemote = remote;
          hitEnemy = null;
          hitPlayer = false;
        }
      }
    }

    if (playerAlive && projectile.owner !== 'player' && (gameMode === 'ffa' || playerTeam !== projectile.team)) {
      const center = projectileTargetCenter.copy(player.position);
      center.y = 0.9;
      const result = segmentDistance(start, movement, center);
      if (result.distance < 2.05 && result.t < nearestT) {
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
        hitRemote = null;
        hitPlayer = false;
        hitObstacle = obstacle;
      }
    }

    if (hitEnemy || hitPlayer || nearestT < Infinity) {
      const impact = projectileImpact.copy(start).addScaledVector(movement, nearestT);

      if (projectile.weapon === 'ricochet' && projectile.bouncesLeft > 0 && !hitEnemy && !hitRemote && !hitPlayer) {
        if (hitObstacle) {
          const rotation = hitObstacle.rotation ?? 0;
          const localHit = impact.clone().sub(hitObstacle.center).applyAxisAngle(worldUp, -rotation);
          const dx = Math.abs(Math.abs(localHit.x) - hitObstacle.halfX);
          const dz = Math.abs(Math.abs(localHit.z) - hitObstacle.halfZ);
          const localNormal = dx < dz
            ? new THREE.Vector3(Math.sign(localHit.x) || 1, 0, 0)
            : new THREE.Vector3(0, 0, Math.sign(localHit.z) || 1);
          const normal = localNormal.applyAxisAngle(worldUp, rotation).normalize();
          projectile.velocity.addScaledVector(normal, -2 * projectile.velocity.dot(normal)).multiplyScalar(0.91);
          projectile.mesh.position.copy(impact).addScaledVector(normal, 0.16);
        } else {
          projectile.mesh.position.copy(impact);
          projectile.mesh.position.y = 0.18;
          projectile.velocity.y = Math.max(7, Math.abs(projectile.velocity.y) * 0.78);
          projectile.velocity.x *= 0.91;
          projectile.velocity.z *= 0.91;
        }
        projectile.bouncesLeft--;
        projectile.damage *= 0.82;
        projectile.direction.copy(projectile.velocity).normalize();
        projectile.mesh.quaternion.setFromUnitVectors(projectileForward, projectile.direction);
        createParticles(impact, 0xb97943, 2);
        continue;
      }

      projectile.alive = false;
      scene.remove(projectile.mesh);

      // Tanques recebem dano sem clarões/faíscas; o estado é mostrado pelas barras de vida.
      if (!hitEnemy && !hitPlayer && !hitRemote) {
        createParticles(impact, projectile.weapon === 'rapid' ? 0x55504a : 0xffc04a, 3);
        spawnFlash(impact, 0.35, 0.9, 0.08, 0xffc27a, 1.4);
      }
      if (!hitEnemy && !hitPlayer && !hitRemote && impact.y < 0.65) {
        const scorchRadius = projectile.weapon === 'rapid' ? 0.32 : projectile.splashRadius > 0 ? 1.35 : 0.82;
        addScorch(impact, scorchRadius);
      }

      const baseDamage = projectile.owner === 'player' ? projectile.damage : projectile.damage / 10;
      if (projectile.splashRadius > 0) {
        for (const bot of enemies) {
          if (!bot.alive || bot === projectile.shooter || (gameMode !== 'ffa' && bot.team === projectile.team)) continue;
          const distance = bot.parts.root.position.distanceTo(impact);
          if (distance > projectile.splashRadius) continue;
          const falloff = 1 - (distance / projectile.splashRadius) * (1 - projectile.splashScale);
          projectileImpactDirection.subVectors(bot.parts.root.position, impact).normalize();
          damageEnemy(bot, baseDamage * falloff, projectile.owner === 'player', projectileImpactDirection);
        }
        if (playerAlive && projectile.owner !== 'player' && (gameMode === 'ffa' || playerTeam !== projectile.team)) {
          const distance = player.position.distanceTo(impact);
          if (distance <= projectile.splashRadius) {
            const falloff = 1 - (distance / projectile.splashRadius) * (1 - projectile.splashScale);
            projectileImpactDirection.subVectors(player.position, impact).normalize();
            damagePlayer(baseDamage * falloff, false, projectileImpactDirection);
          }
        }
        if (projectile.owner === 'player') {
          for (const remote of onlineRemotes.values()) {
            if (!remote.alive || (gameMode !== 'ffa' && remote.team === projectile.team)) continue;
            const distance = remote.parts.root.position.distanceTo(impact);
            if (distance > projectile.splashRadius) continue;
            const falloff = 1 - (distance / projectile.splashRadius) * (1 - projectile.splashScale);
            const direction = projectileImpactDirection.subVectors(remote.parts.root.position, impact).normalize();
            onlineSend({ type: 'hit', targetId: remote.id, hit: { damage: baseDamage * falloff, direction: { x: direction.x, y: direction.y, z: direction.z } } });
          }
        }
      } else {
        if (hitEnemy) damageEnemy(hitEnemy, baseDamage, projectile.owner === 'player', projectile.direction);
        if (hitPlayer) damagePlayer(baseDamage, false, projectile.direction);
        if (hitRemote) onlineSend({ type: 'hit', targetId: hitRemote.id, hit: { damage: baseDamage, direction: { x: projectile.direction.x, y: projectile.direction.y, z: projectile.direction.z } } });
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
    if (!projectile.alive || projectile.shooter === enemy || (gameMode !== 'ffa' && projectile.team === enemy.team)) continue;

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
const enemySlideProbe = new THREE.Vector3();
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
    if (!returningFlag && playerAlive && areHostile(playerTeam, enemy.team)) {
      const d = tank.position.distanceTo(player.position);
      if (d < bestDistance) { bestDistance = d; target = player; }
    }
    for (const other of enemies) {
      if (returningFlag || other === enemy || !other.alive || !areHostile(other.team, enemy.team)) continue;
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
      } else if (enemy.tankClass === 'heavy' || enemy.tankClass === 'assault') {
        if (distance < 6.5) retreatSpeed = 2.5;
        else if (distance < 14) { orbitRange = 11; orbitSpeed = 1.8; }
        else if (distance < 25) approachSpeed = 3.7;
        else if (distance < 35) { orbitRange = 22; orbitSpeed = 2.6; }
        else approachSpeed = 3.2;
      } else if (enemy.tankClass === 'light' || enemy.tankClass === 'scout') {
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
    else if (canEnemyMoveTo(enemySlideProbe.set(next.x, tank.position.y, tank.position.z), enemy)) tank.position.x = next.x;
    else if (canEnemyMoveTo(enemySlideProbe.set(tank.position.x, tank.position.y, next.z), enemy)) tank.position.z = next.z;
    else { enemy.navTimer = 0; enemy.recoveryAngle = findRecoveryAngle(enemy); enemy.recoveryTimer = Math.max(enemy.recoveryTimer, 0.4); }

    const traveledThisFrame = Math.hypot(tank.position.x - enemy.lastPosition.x, tank.position.z - enemy.lastPosition.z);
    advanceTankTreads(enemy.parts, traveledThisFrame, angleDifference(priorHeading, tank.rotation.y));
    const enemySpeedRatio = THREE.MathUtils.clamp(traveledThisFrame / Math.max(0.001, delta * 3.6 * stats.speed), 0, 1);
    tank.position.y = Math.sin(clock.elapsedTime * 8 + tank.id) * 0.026 * enemySpeedRatio;
    enemy.barrelRecoil = Math.max(0, enemy.barrelRecoil - delta * 1.1);
    enemy.parts.barrel.position.z = -1.27 + enemy.barrelRecoil;
    for (const detail of enemy.parts.weaponDetails.children) {
      if (typeof detail.userData.recoilBaseZ === 'number') detail.position.z = detail.userData.recoilBaseZ + enemy.barrelRecoil * 0.8;
    }

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

  if (gameMode === 'deathmatch' || gameMode === 'ffa') {
    if (matchEnded) return;

    matchTime = Math.max(0, matchTime - delta);

    setText(waveText, `Tempo: ${Math.ceil(matchTime)}s`);
    setText(waveBanner, `${gameMode === 'ffa' ? 'CADA TANQUE POR SI' : 'MATA-MATA EM EQUIPES'} · ${Math.ceil(matchTime)}s · ${playerBattleKills} eliminações`);

    if (matchTime <= 0) {
      finishBattle(`FIM DE JOGO · ${playerBattleKills} eliminações`);
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
    saveLocalEconomy();
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
const mobileControls = document.createElement('div');
mobileControls.id = 'mobile-controls';
mobileControls.innerHTML = '<div class="mobile-stick" id="mobile-move-stick" aria-label="Movimento"><i></i><b></b></div><div class="mobile-stick mobile-aim-stick" id="mobile-aim-stick" aria-label="Mira"><i></i><b></b></div><button id="mobile-fire" type="button" aria-label="Disparar">ATIRAR</button>';
document.body.appendChild(mobileControls);
const mobileControlsStyle = document.createElement('style');
mobileControlsStyle.textContent = `
  #mobile-controls{display:none;position:fixed;inset:0;z-index:50;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none}
  #mobile-controls.active{display:block}
  .mobile-stick{position:absolute;left:22px;bottom:26px;width:112px;height:112px;border:1px solid #d6e5e766;border-radius:50%;background:#09111655;box-shadow:inset 0 0 25px #0005;pointer-events:auto;touch-action:none}
  .mobile-stick i{position:absolute;inset:29px;border:1px dashed #ffffff35;border-radius:50%}
  .mobile-stick b{position:absolute;left:35px;top:35px;width:40px;height:40px;border:1px solid #f0d29b99;border-radius:50%;background:#b7833d88;box-shadow:0 3px 14px #0008;transform:translate(0,0)}
  .mobile-aim-stick{left:auto;right:140px;border-color:#75d1c477;background:#09111644}
  .mobile-aim-stick b{border-color:#79d4c8aa;background:#317b7188}
  #mobile-fire{position:absolute;right:20px;bottom:48px;width:98px;height:64px;border:1px solid #e4b96b;border-radius:50%;background:linear-gradient(145deg,#815d32dd,#472f1ddd);box-shadow:0 5px 18px #0008;color:#fff0ca;font-size:12px;font-weight:900;letter-spacing:1px;pointer-events:auto;touch-action:none}
  #mobile-fire:active{background:#b57e39;color:white;transform:scale(.96)}
  @media(pointer:coarse) and (max-width:900px){#mobile-controls.active{display:block}#help{display:none!important}.mobile-stick:after{position:absolute;left:0;right:0;bottom:-19px;color:#d6e2e3aa;text-align:center;font:700 8px/1 Arial,sans-serif;letter-spacing:1px}.mobile-stick:not(.mobile-aim-stick):after{content:'MOVER'}.mobile-aim-stick:after{content:'MIRAR'}}
`;
document.head.appendChild(mobileControlsStyle);
const mobileMoveStick = mobileControls.querySelector<HTMLElement>('#mobile-move-stick')!;
const mobileAimStick = mobileControls.querySelector<HTMLElement>('#mobile-aim-stick')!;
const mobileFireButton = mobileControls.querySelector<HTMLButtonElement>('#mobile-fire')!;
let movePointerId: number | null = null;
let aimPointerId: number | null = null;
let aimLastX = 0;
const movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
function clearMobileMovement() {
  movementKeys.forEach(code => keys.delete(code));
  const knob = mobileMoveStick.querySelector<HTMLElement>('b')!;
  knob.style.transform = 'translate(0,0)';
}
mobileMoveStick.addEventListener('pointerdown', event => {
  event.preventDefault();
  movePointerId = event.pointerId;
  mobileMoveStick.setPointerCapture(event.pointerId);
  updateMobileMove(event);
});
function updateMobileMove(event: PointerEvent) {
  if (movePointerId !== event.pointerId) return;
  const rect = mobileMoveStick.getBoundingClientRect();
  const max = rect.width * 0.31;
  const dx = THREE.MathUtils.clamp(event.clientX - (rect.left + rect.width / 2), -max, max);
  const dy = THREE.MathUtils.clamp(event.clientY - (rect.top + rect.height / 2), -max, max);
  mobileMoveStick.querySelector<HTMLElement>('b')!.style.transform = `translate(${dx}px,${dy}px)`;
  for (const code of movementKeys) keys.delete(code);
  if (dy < -max * 0.28) keys.add('KeyW');
  if (dy > max * 0.28) keys.add('KeyS');
  if (dx < -max * 0.32) keys.add('KeyA');
  if (dx > max * 0.32) keys.add('KeyD');
}
mobileMoveStick.addEventListener('pointermove', updateMobileMove);
function stopMobileMove(event: PointerEvent) {
  if (movePointerId !== event.pointerId) return;
  movePointerId = null;
  clearMobileMovement();
}
mobileMoveStick.addEventListener('pointerup', stopMobileMove);
mobileMoveStick.addEventListener('pointercancel', stopMobileMove);
mobileAimStick.addEventListener('pointerdown', event => {
  event.preventDefault();
  aimPointerId = event.pointerId;
  aimLastX = event.clientX;
  mobileAimStick.setPointerCapture(event.pointerId);
});
mobileAimStick.addEventListener('pointermove', event => {
  if (aimPointerId !== event.pointerId) return;
  const delta = event.clientX - aimLastX;
  aimLastX = event.clientX;
  playerTurret.rotation.y -= delta * 0.009;
});
function stopMobileAim(event: PointerEvent) { if (aimPointerId === event.pointerId) aimPointerId = null; }
mobileAimStick.addEventListener('pointerup', stopMobileAim);
mobileAimStick.addEventListener('pointercancel', stopMobileAim);
mobileFireButton.addEventListener('pointerdown', event => { event.preventDefault(); mobileFireButton.setPointerCapture(event.pointerId); firing = true; });
const stopMobileFire = () => { firing = false; };
mobileFireButton.addEventListener('pointerup', stopMobileFire);
mobileFireButton.addEventListener('pointercancel', stopMobileFire);
mobileFireButton.addEventListener('lostpointercapture', stopMobileFire);
function syncMobileControls() {
  mobileControls.classList.toggle('active', battleHasStarted && !mainMenuOpen && !garageOpen);
}
const playerForward = new THREE.Vector3();
const playerNextPosition = new THREE.Vector3();
const playerSlideProbe = new THREE.Vector3();
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
  } else if (canPlayerMoveTo(playerSlideProbe.set(next.x, player.position.y, player.position.z))) {
    player.position.x = next.x;
  } else if (canPlayerMoveTo(playerSlideProbe.set(player.position.x, player.position.y, next.z))) {
    player.position.z = next.z;
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
  for (const detail of playerParts.weaponDetails.children) {
    if (typeof detail.userData.recoilBaseZ === 'number') detail.position.z = detail.userData.recoilBaseZ + playerBarrelRecoil * 0.8;
  }

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
  if (event.code === 'Escape' && !event.repeat) {
    event.preventDefault();
    firing = false;
    mouseFiring = false;
    battleScoreboard.classList.add('hidden');
    if (garageOpen) closeGarage();
    else if (mainMenuOpen) hideMainMenu();
    else showMainMenu();
    return;
  }
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
    adaptiveRenderScale = 1;
    lowFpsWindows = highFpsWindows = 0;
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

  if (event.code === 'F4' && !event.repeat) {
    event.preventDefault();
    performanceReadoutEnabled = !performanceReadoutEnabled;
    setLobbyOverlayVisibility(mainMenuOpen || garageOpen);
    respawnMessage.textContent = performanceReadoutEnabled ? 'DIAGNÓSTICO DE DESEMPENHO ATIVADO' : 'DIAGNÓSTICO DE DESEMPENHO OCULTO';
    window.setTimeout(() => { respawnMessage.textContent = ''; }, 1200);
    return;
  }

  if (garageOpen || mainMenuOpen) return;

  keys.add(event.code);

  if (event.code === 'Space') firing = true;
  if (event.code === 'KeyC') centerTurret = true;

  const weaponHotkeys: Record<string, WeaponType> = { Digit1: 'cannon', Digit2: 'rapid', Digit3: 'mortar', Digit4: 'plasma', Digit5: 'ricochet' };
  const hotkeyWeapon = weaponHotkeys[event.code];
  if (hotkeyWeapon) {
    selectedWeapon = hotkeyWeapon;
    (document.getElementById('tank-weapon') as HTMLSelectElement).value = selectedWeapon;
    applyWeaponVisual(playerParts, selectedWeapon, selectedTankClass);
    syncGaragePreview();
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

  if (!mainMenuOpen && !garageOpen) {
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

  updateOnlineRemotes(delta);

  // O mundo fica pausado e a última imagem permanece no canvas atrás dos overlays.
  // A garagem mantém somente sua prévia 3D ativa; a cena de batalha retoma ao voltar.
  if (!mainMenuOpen && !garageOpen) {
    if (composer && postFxActive) composer.render(delta);
    else renderer.render(scene, camera);
  }
  lastCpuFrameMs = performance.now() - cpuFrameStartedAt;
  if (garageOpen && !garage.classList.contains('hidden')) {
    const width = garagePreviewElement.clientWidth;
    const height = garagePreviewElement.clientHeight;
    if (width > 2 && height > 2) {
      if (garagePreviewRenderer.domElement.width !== Math.floor(width * Math.min(window.devicePixelRatio || 1, 1)) || garagePreviewRenderer.domElement.height !== Math.floor(height * Math.min(window.devicePixelRatio || 1, 1))) resizeGaragePreview();
      if (!garagePreviewDragging) garagePreviewTank.rotation.y += delta * 0.12;
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
  updateDamageNumbers(performance.now());
  updateFpsCounter(performance.now());
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyPixelRatio();
  const nextMinimapSize = Math.min(150, Math.max(88, window.innerWidth * 0.14));
  minimapFrame.style.width = `${nextMinimapSize}px`;
  if (garageOpen) resizeGaragePreview();
});

// Qualidade gráfica inicial (pós-processamento, sombras, resolução).
(document.getElementById('graphics-quality') as HTMLSelectElement).value = graphicsQuality;
applyQuality();
refreshPaintAvailability();
updateRank();

// Pré-aquecimento: compila os shaders dos projéteis/efeitos escondidos sob o chão,
// para o primeiro tiro não causar engasgo.
{
  const warm: THREE.Object3D[] = [
    new THREE.Mesh(projectileGeometry, playerProjectileMaterial),
    new THREE.Mesh(projectileGeometry, enemyProjectileMaterial),
    new THREE.Mesh(projectileGeometry, playerRapidProjectileMaterial),
    new THREE.Mesh(projectileGeometry, enemyRapidProjectileMaterial),
    new THREE.Mesh(projectileGeometry, ricochetProjectileMaterial),
    new THREE.Mesh(cannonShellGeometry, playerProjectileMaterial),
    new THREE.Mesh(cannonShellGeometry, enemyProjectileMaterial)
  ];
  warm.forEach(object => { object.position.set(player.position.x, -3, player.position.z - 6); scene.add(object); });
  window.setTimeout(() => warm.forEach(object => scene.remove(object)), 700);
}

// Modelos 3D e texturas PBR opcionais (ignorados em silêncio se os arquivos não existirem).
loadTankModels();
loadBattlefieldAssets();

// Inicialização real do modo padrão depois que HUD e controles já existem.
(document.getElementById('game-mode') as HTMLSelectElement).value = 'ctf';
setDecorativeFlagsVisible(true);
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
connectOnlineLobby();
showMainMenu();
animate();
