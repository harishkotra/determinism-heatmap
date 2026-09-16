import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AUTHOR } from './author';
import { darken, determinismToRgb } from './color';
import type { CellAggregate, PromptDef } from './types';

export interface HoverInfo {
  cellIndex: number;
  cell: CellAggregate;
  clientX: number;
  clientY: number;
}

export interface SceneData {
  prompts: PromptDef[];
  cells: CellAggregate[];
  reps: number;
  modelA: string;
  modelB: string;
}

const CELL_W = 1.5;
const CELL_D = 1.5;
const ROW_SPACING = 1.95;
/** Half-distance between the two model columns; the gap is what makes A vs B read instantly. */
const GROUP_OFFSET = 1.25;
const MAX_HEIGHT = 3.4;
/** Minimum height so a zero-reasoning cell still reads as a tile, not a hole. */
const MIN_HEIGHT = 0.12;
const PENDING_HEIGHT = 0.05;

const COL_A = -GROUP_OFFSET;
const COL_B = GROUP_OFFSET;

function makeLabelSprite(
  text: string,
  opts: { color?: string; fontSize?: number; bold?: boolean; align?: 'left' | 'center' } = {},
): THREE.Sprite {
  const fontSize = opts.fontSize ?? 64;
  const bold = opts.bold ?? false;
  const font = `${bold ? '700 ' : '500 '}${fontSize}px ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;

  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 24;
  const h = Math.ceil(fontSize * 1.45);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = opts.color ?? '#e8ecf4';
  ctx.textBaseline = 'middle';
  ctx.textAlign = opts.align === 'center' ? 'center' : 'left';
  ctx.fillText(text, opts.align === 'center' ? w / 2 : 12, h / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.anisotropy = 4;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  const scale = 0.62;
  sprite.scale.set((w / h) * scale, scale, 1);
  return sprite;
}

export class HeatmapScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly canvas: HTMLCanvasElement;

  private mesh: THREE.InstancedMesh | null = null;
  private labels: THREE.Sprite[] = [];
  private data: SceneData | null = null;
  private hovered: number | null = null;
  private hoverEnabled = true;

  private frameId = 0;
  private idleTimer: number | null = null;
  private lastPointer = { x: 0, y: 0 };
  private readonly onHover: (info: HoverInfo | null) => void;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, onHover: (info: HoverInfo | null) => void) {
    this.canvas = canvas;
    this.onHover = onHover;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      // Required so the 2x export can read the framebuffer back.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping: this is a data visualisation, so a cell's rendered
    // colour must equal the ramp colour shown in the legend. Filmic tone
    // mapping would desaturate and shift the ramp, making the legend a lie.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#080b12');
    this.scene.fog = new THREE.Fog('#080b12', 26, 62);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    this.camera.position.set(9, 11, 14);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 60;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.42;
    this.controls.target.set(0, 1.1, 0);

    this.setupLights();
    this.setupFloor();

    // Pause auto-rotate while the user is driving, resume once idle.
    this.controls.addEventListener('start', () => {
      this.controls.autoRotate = false;
      if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    });
    this.controls.addEventListener('end', () => this.scheduleAutoRotate());

    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();

    this.animate();
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight('#9fb6ff', '#0a0d14', 0.85));
    this.scene.add(new THREE.AmbientLight('#ffffff', 0.32));

    const key = new THREE.DirectionalLight('#ffffff', 1.85);
    key.position.set(9, 16, 8);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight('#6f8cff', 0.9);
    rim.position.set(-11, 7, -9);
    this.scene.add(rim);

    const fill = new THREE.PointLight('#ff9d5c', 0.5, 60);
    fill.position.set(0, 6, 12);
    this.scene.add(fill);
  }

  private setupFloor(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: '#0b0f18', roughness: 0.95, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(80, 80, '#1b2436', '#131a28');
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(grid);
  }

  private scheduleAutoRotate(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.controls.autoRotate = true;
    }, 3500);
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.hoverEnabled = true;
  };

  private handlePointerLeave = (): void => {
    this.hoverEnabled = false;
    if (this.hovered !== null) {
      this.hovered = null;
      this.onHover(null);
    }
  };

  /** Rebuild the grid for a new sweep shape (prompt count may change). */
  setData(data: SceneData): void {
    const shapeChanged =
      !this.data ||
      this.data.prompts.length !== data.prompts.length ||
      this.data.prompts.map((p) => p.id).join('|') !== data.prompts.map((p) => p.id).join('|');

    this.data = data;

    if (shapeChanged) this.rebuildGrid();
    this.updateInstances();
  }

  private rebuildGrid(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh.dispose();
      this.mesh = null;
    }
    for (const label of this.labels) {
      this.scene.remove(label);
      label.material.map?.dispose();
      label.material.dispose();
    }
    this.labels = [];

    const data = this.data;
    if (!data) return;

    const rows = data.prompts.length;
    const total = rows * 2;

    const geometry = new THREE.BoxGeometry(CELL_W, 1, CELL_D);
    // Grow upward from the floor rather than around the centre.
    geometry.translate(0, 0.5, 0);

    const material = new THREE.MeshStandardMaterial({
      roughness: 0.38,
      metalness: 0.12,
      envMapIntensity: 0.6,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, total);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    // Column group headers.
    const headerY = 0.4;
    const headerA = makeLabelSprite(`MODEL A · ${data.modelA}`, {
      color: '#9fb0cc',
      fontSize: 46,
      bold: true,
      align: 'center',
    });
    headerA.position.set(COL_A, headerY, this.rowZ(0) - ROW_SPACING * 0.95);
    this.scene.add(headerA);
    this.labels.push(headerA);

    const headerB = makeLabelSprite(`MODEL B · ${data.modelB}`, {
      color: '#cfe0ff',
      fontSize: 46,
      bold: true,
      align: 'center',
    });
    headerB.position.set(COL_B, headerY, this.rowZ(0) - ROW_SPACING * 0.95);
    this.scene.add(headerB);
    this.labels.push(headerB);

    // Row labels: prompt names, left of group A.
    for (let r = 0; r < rows; r++) {
      const prompt = data.prompts[r]!;
      const sprite = makeLabelSprite(prompt.label, { color: '#c3ccdd', fontSize: 40 });
      const width = sprite.scale.x;
      sprite.position.set(COL_A - CELL_W / 2 - 0.35 - width, 0.28, this.rowZ(r));
      this.scene.add(sprite);
      this.labels.push(sprite);
    }

    this.fitCamera();
  }

  private rowZ(row: number): number {
    const rows = this.data?.prompts.length ?? 1;
    return (row - (rows - 1) / 2) * ROW_SPACING;
  }

  private fitCamera(): void {
    const rows = this.data?.prompts.length ?? 8;
    const depth = rows * ROW_SPACING;
    const width = 2 * GROUP_OFFSET + CELL_W * 2;
    const dist = Math.max(depth * 1.25, width * 1.5, 12);

    this.camera.position.set(dist * 0.52, dist * 0.62, dist * 0.66);
    this.controls.target.set(0, MAX_HEIGHT * 0.28, 0);
    this.controls.update();
  }

  /** Push current cell values into instance matrices and colours. */
  private updateInstances(): void {
    const data = this.data;
    const mesh = this.mesh;
    if (!data || !mesh) return;

    const maxTokens = Math.max(1, ...data.cells.map((c) => c.meanReasoningTokens));
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();

    for (let i = 0; i < mesh.count; i++) {
      const cell = data.cells[i];
      const row = Math.floor(i / 2);
      const slot = i % 2;
      const x = slot === 0 ? COL_A : COL_B;
      const z = this.rowZ(row);

      const measured = cell && cell.okCount + cell.errorCount > 0;

      let height = PENDING_HEIGHT;
      let rgb: [number, number, number] = [0.1, 0.12, 0.17];

      if (measured && cell) {
        const ratio = Math.min(1, cell.meanReasoningTokens / maxTokens);
        height = MIN_HEIGHT + ratio * MAX_HEIGHT;
        // Error-only cells are rendered as a neutral slate, never as "deterministic".
        rgb =
          cell.okCount === 0 ? [0.28, 0.3, 0.35] : determinismToRgb(cell.determinismScore);
      }

      const hovered = this.hovered === i;
      const scaleY = height * (hovered ? 1.04 : 1);

      matrix.makeScale(1, scaleY, 1);
      matrix.setPosition(x, 0, z);
      mesh.setMatrixAt(i, matrix);

      if (hovered) {
        color.setRGB(
          Math.min(1, rgb[0] * 1.5 + 0.12),
          Math.min(1, rgb[1] * 1.5 + 0.12),
          Math.min(1, rgb[2] * 1.5 + 0.12),
          THREE.SRGBColorSpace,
        );
      } else {
        const [r, g, b] = rgb;
        color.setRGB(r, g, b, THREE.SRGBColorSpace);
      }
      mesh.setColorAt(i, color);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  private pick(): void {
    if (!this.mesh || !this.data || !this.hoverEnabled) return;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    const hit = hits[0];

    if (!hit || hit.instanceId === undefined) {
      if (this.hovered !== null) {
        this.hovered = null;
        this.updateInstances();
        this.onHover(null);
      }
      return;
    }

    const cell = this.data.cells[hit.instanceId];
    if (!cell) return;

    if (this.hovered !== hit.instanceId) {
      this.hovered = hit.instanceId;
      this.updateInstances();
    }
    this.onHover({
      cellIndex: hit.instanceId,
      cell,
      clientX: this.lastPointer.x,
      clientY: this.lastPointer.y,
    });
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth || window.innerWidth;
    const height = parent?.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.pick();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Render at `scale`x and return a PNG data URL. The overlay text (title,
   * legend, audit line) is drawn with the 2D API so it stays crisp at 2x and
   * the exported file is self-contained.
   */
  exportPng(scale: number, meta: ExportMeta): string {
    const parent = this.canvas.parentElement;
    const cssW = parent?.clientWidth || window.innerWidth;
    const cssH = parent?.clientHeight || window.innerHeight;

    const prevPixelRatio = this.renderer.getPixelRatio();
    const prevSize = new THREE.Vector2();
    this.renderer.getSize(prevSize);

    // Render the 3D scene at 2x into the same canvas.
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(cssW * scale, cssH * scale, false);
    this.camera.aspect = cssW / Math.max(1, cssH);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);

    const out = document.createElement('canvas');
    out.width = cssW * scale;
    out.height = cssH * scale;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(this.canvas, 0, 0, out.width, out.height);

    drawExportOverlay(ctx, out.width, out.height, scale, meta);

    // Restore the interactive viewport.
    this.renderer.setPixelRatio(prevPixelRatio);
    this.renderer.setSize(prevSize.x, prevSize.y, false);
    this.camera.aspect = cssW / Math.max(1, cssH);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);

    return out.toDataURL('image/png');
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

export interface ExportMeta {
  prompts: number;
  reps: number;
  modelA: string;
  modelB: string;
  temperature: number;
  disableReasoning: boolean;
  nonceAudit: { issued: number; unique: number; duplicates: string[]; ok: boolean };
  maxReasoningTokens: number;
  timestamp: string;
}

/** Title, legend and audit footer, drawn directly onto the exported bitmap. */
function drawExportOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scale: number,
  meta: ExportMeta,
): void {
  const s = scale;
  const font = (size: number, weight = 500) =>
    `${weight} ${Math.round(size * s)}px ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`;

  // Legibility scrim behind the top-left title block.
  const grad = ctx.createLinearGradient(0, 0, 0, h * 0.34);
  grad.addColorStop(0, 'rgba(6,9,15,0.88)');
  grad.addColorStop(1, 'rgba(6,9,15,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h * 0.34);

  const pad = 40 * s;

  ctx.textBaseline = 'top';
  ctx.fillStyle = '#f2f5fb';
  ctx.font = font(40, 700);
  ctx.fillText('The Determinism Heatmap', pad, pad);

  ctx.fillStyle = '#9fb0cc';
  ctx.font = font(17, 500);
  const sub = `${meta.prompts} prompts × 2 models × ${meta.reps} repetitions · temperature ${meta.temperature}${
    meta.disableReasoning ? ' · reasoning disabled' : ''
  }`;
  ctx.fillText(sub, pad, pad + 52 * s);

  ctx.fillStyle = '#c3ccdd';
  ctx.font = font(15, 500);
  ctx.fillText(
    `A · ${meta.modelA}          B · ${meta.modelB}`,
    pad,
    pad + 78 * s,
  );

  // Legend, bottom-left.
  const barW = 300 * s;
  const barH = 16 * s;
  const barX = pad;
  const barY = h - pad - 96 * s;

  ctx.fillStyle = '#9fb0cc';
  ctx.font = font(13, 600);
  ctx.fillText('DETERMINISM SCORE', barX, barY - 26 * s);

  const legend = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const [r, g, b] = determinismToRgb(t);
    legend.addColorStop(t, `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`);
  }
  ctx.fillStyle = legend;
  ctx.fillRect(barX, barY, barW, barH);

  ctx.fillStyle = '#8f9db8';
  ctx.font = font(12, 500);
  ctx.fillText('0.0 · wanders', barX, barY + barH + 8 * s);
  ctx.textAlign = 'right';
  ctx.fillText('1.0 · byte-identical', barX + barW, barY + barH + 8 * s);
  ctx.textAlign = 'left';

  // Height legend.
  const hx = barX + barW + 56 * s;
  ctx.fillStyle = '#9fb0cc';
  ctx.font = font(13, 600);
  ctx.fillText('BAR HEIGHT', hx, barY - 26 * s);
  ctx.fillStyle = '#c3ccdd';
  ctx.font = font(13, 500);
  ctx.fillText(
    `mean reasoning tokens (grid max ${meta.maxReasoningTokens.toLocaleString()})`,
    hx,
    barY + 2 * s,
  );
  ctx.fillStyle = '#e8734a';
  ctx.font = font(13, 600);
  ctx.fillText('tall + red = expensive and unstable', hx, barY + 24 * s);

  // Audit footer, bottom-right.
  ctx.textAlign = 'right';
  const audit = meta.nonceAudit;
  ctx.font = font(13, 600);
  ctx.fillStyle = audit.ok ? '#17c964' : '#e01b3c';
  ctx.fillText(
    audit.ok
      ? `✓ nonce audit passed — ${audit.issued} calls, ${audit.unique} unique nonces, 0 reused`
      : `✗ NONCE REUSE DETECTED — ${audit.duplicates.length} duplicate(s); determinism invalid`,
    w - pad,
    barY - 26 * s,
  );
  ctx.fillStyle = '#8f9db8';
  ctx.font = font(12, 500);
  ctx.fillText(`sha256 of raw responses · ${meta.timestamp}`, w - pad, barY + 2 * s);
  ctx.fillText('raw records: data/sweeps.jsonl', w - pad, barY + 22 * s);

  // Attribution — this PNG is the shareable artifact, so the credit travels
  // with it. Centred so it reads as a signature rather than fine print.
  ctx.textAlign = 'center';
  ctx.font = font(13, 600);
  ctx.fillStyle = '#b9c6dd';
  ctx.fillText(
    `Built by ${AUTHOR.name} · ${AUTHOR.buildsUrl.replace('https://', '')}`,
    w / 2,
    h - pad - 12 * s,
  );
  ctx.textAlign = 'left';
}

export { darken };