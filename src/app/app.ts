import { Component, computed, ElementRef, HostListener, signal, ViewChild } from '@angular/core';
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
    return this.annotations().map(a => {
      const isSel = a.id === selId;
      return {
        points: a.worldVertices.flatMap(v => [v.worldX, v.worldY]),
        closed: true,
        fill: isSel ? 'rgba(255,255,0,0.25)' : 'rgba(255,0,0,0.15)',
        stroke: isSel ? 'rgba(255,255,0,0.9)' : 'rgba(255,0,0,0.7)',
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

  // ── lifecycle ──

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

  // ── hover / click detection ──

  private checkAnnotationHover(sx: number, sy: number) {
    const pose = this.carPose();
    for (const a of this.annotations()) {
      const screenVerts = a.worldVertices.map(v => {
        const s = this.worldToScreen(v.worldX, v.worldY, pose);
        return { x: s.x, y: s.y };
      });
      if (this.pointInPolygon(sx, sy, screenVerts)) {
        this.hoveredAnnotationId.set(a.id);
        return;
      }
    }
    this.hoveredAnnotationId.set(null);
  }

  private handleAnnotationClick(sx: number, sy: number) {
    const pose = this.carPose();
    const matched = this.annotations().find(a => {
      const screenVerts = a.worldVertices.map(v => {
        const s = this.worldToScreen(v.worldX, v.worldY, pose);
        return { x: s.x, y: s.y };
      });
      return this.pointInPolygon(sx, sy, screenVerts);
    });
    if (matched) {
      this.selectAnnotation(matched.id);
    } else {
      this.clearSelection();
    }
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
