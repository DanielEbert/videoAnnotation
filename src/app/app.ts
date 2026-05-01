import { Component, computed, effect, ElementRef, HostListener, signal, ViewChild } from '@angular/core';
import concaveman from 'concaveman';
import { CoreShapeComponent, StageComponent } from 'ng2-konva';

interface CarPose {
  timestamp: number;
  worldX: number;
  worldY: number;
  yaw: number;
}

interface PolygonAnnotation {
  id: number;
  worldVertices: { worldX: number; worldY: number }[];
  label: string;
  mistakeType: string;
  comment: string;
  timestamp: number;
}

const MISTAKE_TYPES = [
  'Unspecified',
  'Lane Departure',
  'Improper Lane Change',
  'Failure to Stop',
  'Speeding',
  'Tailgating',
  'Running Red Light',
  'Not Yielding',
  'Distracted Driving',
  'Other',
] as const;

@Component({
  selector: 'app-root',
  imports: [StageComponent, CoreShapeComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  @ViewChild('videoPlayer') videoPlayer!: ElementRef<HTMLVideoElement>;
  @ViewChild('annotationStage', { read: ElementRef }) annotationStage!: ElementRef<HTMLDivElement>;

  private videoEl!: HTMLVideoElement;
  private pixelsPerMeter = 100;

  // ── state ──
  isDrawingMode = signal(true);
  annotations = signal<PolygonAnnotation[]>([]);
  carPose = signal<CarPose>({ timestamp: 0, worldX: 50, worldY: 50, yaw: 0 });
  videoDims = signal({ width: 640, height: 360 });

  isLassoing = signal(false);
  lassoPoints = signal<{ x: number; y: number }[]>([]);

  private _nextId = 1;
  hoveredAnnotationId = signal<number | null>(null);
  selectedAnnotationId = signal<number | null>(null);
  mousePos = signal({ x: 0, y: 0 });
  private _mouseMoved = false;
  private _lassoStart = { x: 0, y: 0 };

  // edit form buffer signals (updated immediately for responsiveness)
  editType = signal('');
  editComment = signal('');
  private _commentTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingComment: { id: number; comment: string } | null = null;

  // undo / redo
  private readonly MAX_HISTORY = 200;
  private undoStack: { annotations: PolygonAnnotation[]; nextId: number }[] = [];
  private redoStack: { annotations: PolygonAnnotation[]; nextId: number }[] = [];
  private _historyVersion = signal(0);

  bumpHistory() { this._historyVersion.update(v => v + 1); }

  // ── derivations ──

  layerConfig = computed(() => {
    const { width, height } = this.videoDims();
    const { worldX, worldY, yaw } = this.carPose();
    return {
      x: width / 2, y: height / 2, offsetX: worldX, offsetY: worldY,
      scaleX: this.pixelsPerMeter, scaleY: this.pixelsPerMeter, rotation: -yaw * 180 / Math.PI
    };
  });

  polygonConfigs = computed(() => {
    const selId = this.selectedAnnotationId();
    const hoverId = this.hoveredAnnotationId();
    return this.annotations().map(a => {
      const isSel = a.id === selId;
      const isHover = a.id === hoverId;
      return {
        points: a.worldVertices.flatMap(v => [v.worldX, v.worldY]),
        closed: true,
        fill: isSel ? 'rgba(255,255,0,0.25)' : isHover ? 'rgba(255,255,255,0.10)' : 'rgba(255,0,0,0.15)',
        stroke: isSel ? 'rgba(255,255,0,0.9)' : isHover ? 'rgba(200,200,255,0.5)' : 'rgba(255,0,0,0.7)',
        strokeWidth: isSel ? 3 / this.pixelsPerMeter : 2 / this.pixelsPerMeter,
      };
    });
  });

  labelConfigs = computed(() => {
    const p = this.carPose();
    return this.annotations().map(a => {
      const { worldX, worldY } = this.polygonCentroid(a.worldVertices);
      const s = this.worldToScreen(worldX, worldY, p);
      return { x: s.x + 10, y: s.y + 5, text: a.label, fontSize: 14, fill: 'white' };
    });
  });

  lassoLineConfig = computed(() => {
    const pts = this.lassoPoints();
    if (pts.length < 2) return null;
    return {
      points: pts.flatMap(p => [p.x, p.y]),
      closed: true, fill: 'rgba(0,255,255,0.15)', stroke: 'rgba(0,255,255,0.6)',
      strokeWidth: 2, lineCap: 'round', lineJoin: 'round',
    };
  });

  hoveredAnnotation = computed(() => {
    const id = this.hoveredAnnotationId();
    return id !== null ? this.annotations().find(a => a.id === id) ?? null : null;
  });

  selectedAnnotation = computed(() => {
    const id = this.selectedAnnotationId();
    return id !== null ? this.annotations().find(a => a.id === id) ?? null : null;
  });

  sortedAnnotations = computed(() =>
    [...this.annotations()].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
  );

  canUndo = computed(() => { this._historyVersion(); return this.undoStack.length > 0; });
  canRedo = computed(() => { this._historyVersion(); return this.redoStack.length > 0; });

  editPanelAnnotation = computed(() => {
    const hovered = this.hoveredAnnotationId();
    const selected = this.selectedAnnotationId();
    const id = hovered ?? selected;
    return id !== null ? this.annotations().find(a => a.id === id) ?? null : null;
  });

  // ── lifecycle ──

  constructor() {
    effect(() => {
      const a = this.editPanelAnnotation();
      if (a) {
        this.editType.set(a.mistakeType);
        this.editComment.set(a.comment);
      } else {
        this.editType.set('');
        this.editComment.set('');
      }
    });
  }

  ngAfterViewInit() {
    this.videoEl = this.videoPlayer.nativeElement;
    this.videoEl.addEventListener('loadedmetadata', () => this.onVideoReady());
  }

  @HostListener('window:resize')
  onResize() { this.onVideoReady(); }

  onVideoReady() {
    const { clientWidth: width, clientHeight: height } = this.videoEl;
    requestAnimationFrame(() => this.videoDims.set({ width, height }));
  }

  onTimeUpdate() { this.carPose.set(this.getCarPositionAtTime(this.videoEl.currentTime)); }

  toggleDrawingMode() { this.isDrawingMode.update(v => !v); }

  // ── mouse handlers ──

  handleMouseDown(e: any) {
    if (!this.isDrawingMode()) return;
    const pos = e.event.currentTarget.getPointerPosition();
    if (!pos) return;
    e.event.evt?.preventDefault();
    this._mouseMoved = false;
    this._lassoStart = { x: pos.x, y: pos.y };
    this.isLassoing.set(true);
    this.lassoPoints.set([{ x: pos.x, y: pos.y }]);
  }

  @HostListener('window:mousemove', ['$event'])
  onWindowMouseMove(e: MouseEvent) {
    const { left, top } = this.annotationStage.nativeElement.getBoundingClientRect();
    const stageX = e.clientX - left;
    const stageY = e.clientY - top;
    this.mousePos.set({ x: e.clientX, y: e.clientY });

    this.checkAnnotationHover(stageX, stageY);

    if (!this.isLassoing()) return;

    const dx = stageX - this._lassoStart.x;
    const dy = stageY - this._lassoStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      this._mouseMoved = true;
    }

    this.lassoPoints.update(pts => [...pts, { x: stageX, y: stageY }]);
  }

  @HostListener('window:mouseup')
  onWindowMouseUp() {
    if (!this.isLassoing()) return;
    this.isLassoing.set(false);

    if (!this._mouseMoved) {
      this.lassoPoints.set([]);
      this.handleAnnotationClick(this._lassoStart.x, this._lassoStart.y);
      return;
    }

    const pts = this.lassoPoints();
    if (pts.length < 3) { this.lassoPoints.set([]); return; }
    const hull = concaveman(pts.map(p => [p.x, p.y]));
    const pose = this.carPose();
    const worldVerts = hull.map(([x, y]) => this.screenToWorld(x, y, pose));
    const id = this._nextId++;
    const timestamp = this.videoEl.currentTime;
    this.pushState();
    this.annotations.update(arr => [...arr, {
      id,
      worldVertices: worldVerts,
      label: `#${id}`,
      mistakeType: 'Unspecified',
      comment: '',
      timestamp,
    }]);
    this.lassoPoints.set([]);
    this.selectAnnotation(id);
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        this.redo();
      }
      return;
    }

    if (/^[0-9]$/.test(e.key)) {
      const a = this.editPanelAnnotation();
      if (!a) return;
      e.preventDefault();
      const idx = e.key === '0' ? 9 : parseInt(e.key) - 1;
      if (idx >= 0 && idx < MISTAKE_TYPES.length) {
        this.onTypeChange(a.id, MISTAKE_TYPES[idx]);
      }
    }
  }

  // ── hover / click detection ──

  private findAnnotationAtScreen(sx: number, sy: number): PolygonAnnotation | undefined {
    const pose = this.carPose();
    return this.annotations().find(a => {
      const screenVerts = a.worldVertices.map(v => {
        const s = this.worldToScreen(v.worldX, v.worldY, pose);
        return { x: s.x, y: s.y };
      });
      return this.pointInPolygon(sx, sy, screenVerts);
    });
  }

  private checkAnnotationHover(sx: number, sy: number) {
    const found = this.findAnnotationAtScreen(sx, sy);
    this.hoveredAnnotationId.set(found?.id ?? null);
  }

  private handleAnnotationClick(sx: number, sy: number) {
    const matched = this.findAnnotationAtScreen(sx, sy);
    matched ? this.selectAnnotation(matched.id) : this.clearSelection();
  }

  // ── annotation selection ──

  selectAnnotation(id: number) {
    this._flushCommentDebounce();
    const a = this.annotations().find(x => x.id === id);
    if (!a) return;
    this.selectedAnnotationId.set(id);
    this.editType.set(a.mistakeType);
    this.editComment.set(a.comment);
  }

  clearSelection() {
    this._flushCommentDebounce();
    this.selectedAnnotationId.set(null);
    this.editType.set('');
    this.editComment.set('');
  }

  // ── annotation field updates ──

  onTypeChange(id: number, type: string) {
    const existing = this.annotations().find(x => x.id === id);
    if (!existing || existing.mistakeType === type) return;
    this.pushState();
    this.editType.set(type);
    const label = type !== 'Unspecified' ? `${type} #${id}` : `#${id}`;
    this.annotations.update(arr => arr.map(a =>
      a.id === id ? { ...a, mistakeType: type, label } : a
    ));
  }

  onCommentInput(id: number, comment: string) {
    this.editComment.set(comment);
    this._pendingComment = { id, comment };
    if (this._commentTimer) clearTimeout(this._commentTimer);
    this._commentTimer = setTimeout(() => {
      this._saveComment();
    }, 300);
  }

  deleteAnnotation(id: number) {
    this._flushCommentDebounce();
    this.pushState();
    if (this.selectedAnnotationId() === id) {
      this.clearSelection();
    }
    this.annotations.update(arr => arr.filter(a => a.id !== id));
  }

  jumpToAnnotation(id: number) {
    const a = this.annotations().find(x => x.id === id);
    if (a && this.videoEl) {
      this.videoEl.currentTime = a.timestamp;
    }
  }

  formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private _saveComment() {
    if (this._pendingComment) {
      const { id, comment } = this._pendingComment;
      this.pushState();
      this.annotations.update(arr => arr.map(a =>
        a.id === id ? { ...a, comment } : a
      ));
      this._pendingComment = null;
    }
    this._commentTimer = null;
  }

  private _flushCommentDebounce() {
    if (this._commentTimer) {
      clearTimeout(this._commentTimer);
      this._saveComment();
    }
  }

  private pushState() {
    this.undoStack.push({
      annotations: JSON.parse(JSON.stringify(this.annotations())),
      nextId: this._nextId,
    });
    if (this.undoStack.length > this.MAX_HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.bumpHistory();
  }

  undo() {
    this._flushCommentDebounce();
    if (!this.canUndo()) return;
    this.redoStack.push({
      annotations: JSON.parse(JSON.stringify(this.annotations())),
      nextId: this._nextId,
    });
    const state = this.undoStack.pop()!;
    this.annotations.set(state.annotations);
    this._nextId = state.nextId;
    this.clearSelection();
    this.bumpHistory();
  }

  redo() {
    this._flushCommentDebounce();
    if (!this.canRedo()) return;
    this.undoStack.push({
      annotations: JSON.parse(JSON.stringify(this.annotations())),
      nextId: this._nextId,
    });
    const state = this.redoStack.pop()!;
    this.annotations.set(state.annotations);
    this._nextId = state.nextId;
    this.clearSelection();
    this.bumpHistory();
  }

  // ── export / import ──

  exportAnnotations() {
    const json = JSON.stringify(this.annotations(), null, 2);
    navigator.clipboard.writeText(json).catch(() => { });
  }

  async importAnnotations() {
    try {
      const text = await navigator.clipboard.readText();
      const data = JSON.parse(text) as PolygonAnnotation[];
      if (!Array.isArray(data)) return;
      this.pushState();
      this._nextId = Math.max(0, ...data.map(a => a.id)) + 1;
      this.annotations.set(data);
      this.clearSelection();
    } catch { /* invalid json or clipboard read failed */ }
  }

  // ── helpers ──

  private pointInPolygon(px: number, py: number, vertices: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i].x, yi = vertices[i].y;
      const xj = vertices[j].x, yj = vertices[j].y;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  private getCarPositionAtTime(time: number): CarPose {
    return { timestamp: 0, worldX: 50 + time, worldY: 50, yaw: 0 };
  }

  private screenToWorld(sx: number, sy: number, cp: CarPose) {
    const { width: vw, height: vh } = this.videoDims();
    const x = (sx - vw / 2) / this.pixelsPerMeter;
    const y = (sy - vh / 2) / this.pixelsPerMeter;
    const cos = Math.cos(cp.yaw), sin = Math.sin(cp.yaw);
    return { worldX: x * cos - y * sin + cp.worldX, worldY: x * sin + y * cos + cp.worldY };
  }

  private worldToScreen(wx: number, wy: number, cp: CarPose) {
    const { width: vw, height: vh } = this.videoDims();
    const x = (wx - cp.worldX) * this.pixelsPerMeter;
    const y = (wy - cp.worldY) * this.pixelsPerMeter;
    const cos = Math.cos(-cp.yaw), sin = Math.sin(-cp.yaw);
    return { x: x * cos - y * sin + vw / 2, y: x * sin + y * cos + vh / 2 };
  }

  private polygonCentroid(verts: { worldX: number; worldY: number }[]) {
    let cx = 0, cy = 0;
    for (const v of verts) { cx += v.worldX; cy += v.worldY; }
    return { worldX: cx / verts.length, worldY: cy / verts.length };
  }

  readonly MISTAKE_TYPES = MISTAKE_TYPES;
}
