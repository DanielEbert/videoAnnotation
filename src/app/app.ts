import {
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  signal,
  ViewChild,
} from '@angular/core';
import concaveman from 'concaveman';
import { CoreShapeComponent, StageComponent } from 'ng2-konva';
import polygonClipping from 'polygon-clipping';
import type { Pair, Polygon, MultiPolygon } from 'polygon-clipping';

interface CarPose {
  timestamp: number;
  worldX: number;
  worldY: number;
  yaw: number;
}

interface PolygonAnnotation {
  id: number;
  worldVertices: { worldX: number; worldY: number }[];
  holes: { worldX: number; worldY: number }[][];
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

  // state
  isDrawingMode = signal(true);
  annotations = signal<PolygonAnnotation[]>([]);
  carPose = signal<CarPose>({ timestamp: 0, worldX: 50, worldY: 50, yaw: 0 });
  videoDims = signal({ width: 640, height: 360 });

  private _nextId = 1;
  hoveredAnnotationId = signal<number | null>(null);
  selectedAnnotationId = signal<number | null>(null);
  // used to set hover text position
  mousePos = signal({ x: 0, y: 0 });

  private _lassoStart: { x: number; y: number } | null = null;
  lassoPoints = signal<{ x: number; y: number }[]>([]);
  shiftKeyDown = signal(false);

  private _deleteLassoStart: { x: number; y: number } | null = null;
  deleteLassoPoints = signal<{ x: number; y: number }[]>([]);

  private _draggingAnnotationId: number | null = null;
  dragStartScreen = signal<{ x: number; y: number } | null>(null);
  private _dragStartWorldVertices: { worldX: number; worldY: number }[] = [];

  editComment = signal('');
  private _commentTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingComment: { id: number; comment: string } | null = null;

  // undo / redo
  private readonly MAX_HISTORY = 200;
  private undoStack = signal<{ annotations: PolygonAnnotation[]; nextId: number }[]>([]);
  private redoStack = signal<{ annotations: PolygonAnnotation[]; nextId: number }[]>([]);

  // derivations

  layerConfig = computed(() => {
    const { width, height } = this.videoDims();
    const { worldX, worldY, yaw } = this.carPose();
    return {
      x: width / 2,
      y: height / 2,
      offsetX: worldX,
      offsetY: worldY,
      scaleX: this.pixelsPerMeter,
      scaleY: this.pixelsPerMeter,
      rotation: (-yaw * 180) / Math.PI,
    };
  });

  polygonConfigs = computed(() => {
    const selId = this.selectedAnnotationId();
    const hoverId = this.hoveredAnnotationId();
    const ppm = this.pixelsPerMeter;
    return this.annotations().map((a) => {
      const isSel = a.id === selId;
      const isHover = a.id === hoverId;
      const fill = isSel
        ? 'rgba(255,255,0,0.25)'
        : isHover
          ? 'rgba(255,255,255,0.10)'
          : 'rgba(255,0,0,0.15)';
      const stroke = isSel
        ? 'rgba(255,255,0,0.9)'
        : isHover
          ? 'rgba(200,200,255,0.5)'
          : 'rgba(255,0,0,0.7)';
      const strokeWidth = isSel ? 3 / ppm : 2 / ppm;
      return {
        annotationId: a.id,
        type: 'shape' as const,
        config: {
          sceneFunc: (ctx: any, shape: any) =>
            this._drawAnnotationPath(ctx, shape, a.worldVertices, a.holes),
          fillRule: 'evenodd',
          fill,
          stroke,
          strokeWidth,
        },
      };
    });
  });

  labelConfigs = computed(() => {
    const p = this.carPose();
    return this.annotations().map((a) => {
      const { worldX, worldY } = this.polygonCentroid(a.worldVertices);
      const s = this.worldToScreen(worldX, worldY, p);
      return { x: s.x + 10, y: s.y + 5, text: a.label, fontSize: 14, fill: 'white' };
    });
  });

  lassoLineConfig = computed(() => {
    const pts = this.lassoPoints();
    if (pts.length < 2) return null;
    const mergeMode = this.shiftKeyDown();
    return {
      points: pts.flatMap((p) => [p.x, p.y]),
      closed: true,
      fill: mergeMode ? 'rgba(0,200,100,0.20)' : 'rgba(0,255,255,0.15)',
      stroke: mergeMode ? 'rgba(0,200,100,0.7)' : 'rgba(0,255,255,0.6)',
      strokeWidth: 2,
      lineCap: 'round',
      lineJoin: 'round',
      dash: mergeMode ? [6, 3] : undefined,
    };
  });

  deleteLassoLineConfig = computed(() => {
    const pts = this.deleteLassoPoints();
    if (pts.length < 2) return null;
    return {
      points: pts.flatMap((p) => [p.x, p.y]),
      closed: true,
      fill: 'rgba(255,40,40,0.18)',
      stroke: 'rgba(255,80,80,0.65)',
      strokeWidth: 2,
      lineCap: 'round',
      lineJoin: 'round',
      dash: [6, 3],
    };
  });

  hoveredAnnotation = computed(
    () => this.annotations().find((a) => a.id === this.hoveredAnnotationId()) ?? null,
  );

  sortedAnnotations = computed(() =>
    [...this.annotations()].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id),
  );

  canUndo = computed(() => this.undoStack().length > 0);
  canRedo = computed(() => this.redoStack().length > 0);

  editPanelAnnotation = computed(() => {
    const id = this.hoveredAnnotationId() ?? this.selectedAnnotationId();
    return this.annotations().find((a) => a.id === id) ?? null;
  });

  // ── lifecycle ──

  constructor() {
    effect(() => {
      const a = this.editPanelAnnotation();
      this.editComment.set(a?.comment ?? '');
    });
  }

  ngAfterViewInit() {
    this.videoEl = this.videoPlayer.nativeElement;
    this.videoEl.addEventListener('loadedmetadata', () => this.onVideoReady());
  }

  @HostListener('window:resize')
  onResize() {
    this.onVideoReady();
  }

  onVideoReady() {
    const { clientWidth: width, clientHeight: height } = this.videoEl;
    requestAnimationFrame(() => this.videoDims.set({ width, height }));
  }

  onTimeUpdate() {
    this.carPose.set(this.getCarPositionAtTime(this.videoEl.currentTime));
  }

  toggleDrawingMode() {
    this.isDrawingMode.update((v) => !v);
  }

  handleMouseDown(e: any) {
    if (!this.isDrawingMode()) return;
    if (e.event.evt?.button === 1 || e.event.evt?.button === 2) return;
    const pos = e.event.currentTarget.getPointerPosition();
    if (!pos) return;
    e.event.evt?.preventDefault();
    this._lassoStart = { x: pos.x, y: pos.y };
    this.lassoPoints.set([{ x: pos.x, y: pos.y }]);
  }

  @HostListener('window:mousedown', ['$event'])
  onWindowMouseDown(e: MouseEvent) {
    if (e.button === 1) {
      const pos = this._screenCoordsInStage(e);
      if (!pos) return;
      e.preventDefault();
      this._deleteLassoStart = pos;
      this.deleteLassoPoints.set([pos]);
      return;
    }
    if (e.button !== 2) return;
    const pos = this._screenCoordsInStage(e);
    if (!pos) return;
    const found = this.findAnnotationAtScreen(pos.x, pos.y);
    if (!found) return;
    e.preventDefault();
    this._flushCommentDebounce();
    this.pushState();
    this.selectAnnotation(found.id);
    this._draggingAnnotationId = found.id;
    this.dragStartScreen.set(pos);
    this._dragStartWorldVertices = JSON.parse(JSON.stringify(found.worldVertices));
  }

  @HostListener('window:contextmenu', ['$event'])
  onContextMenu(e: MouseEvent) {
    const rect = this.annotationStage?.nativeElement?.getBoundingClientRect();
    if (
      rect &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    ) {
      e.preventDefault();
    }
  }

  @HostListener('window:mousemove', ['$event'])
  onWindowMouseMove(e: MouseEvent) {
    const { left, top } = this.annotationStage.nativeElement.getBoundingClientRect();
    const stageX = e.clientX - left;
    const stageY = e.clientY - top;
    this.mousePos.set({ x: e.clientX, y: e.clientY });

    this.checkAnnotationHover(stageX, stageY);

    const dragStart = this.dragStartScreen();
    if (dragStart !== null) {
      const pose = this.carPose();
      const startWorld = this.screenToWorld(dragStart.x, dragStart.y, pose);
      const curWorld = this.screenToWorld(stageX, stageY, pose);
      const worldDx = curWorld.worldX - startWorld.worldX;
      const worldDy = curWorld.worldY - startWorld.worldY;
      const orig = this._dragStartWorldVertices;
      this.annotations.update((arr) =>
        arr.map((a) => {
          if (a.id !== this._draggingAnnotationId) return a;
          return {
            ...a,
            worldVertices: orig.map((v) => ({
              worldX: v.worldX + worldDx,
              worldY: v.worldY + worldDy,
            })),
            holes: this._translateHoles(a.holes, worldDx, worldDy),
          };
        }),
      );
      return;
    }

    const lassoStart = this._lassoStart;
    if (lassoStart !== null) {
      this.lassoPoints.update((pts) => [...pts, { x: stageX, y: stageY }]);
      return;
    }

    const deleteLassoStart = this._deleteLassoStart;
    if (deleteLassoStart !== null) {
      this.deleteLassoPoints.update((pts) => [...pts, { x: stageX, y: stageY }]);
    }
  }

  @HostListener('window:mouseup', ['$event'])
  onWindowMouseUp(e: MouseEvent) {
    if (this.dragStartScreen() !== null) {
      const dragged = this.annotations().find((a) => a.id === this._draggingAnnotationId);
      if (
        dragged &&
        this._dragStartWorldVertices.every(
          (v, i) =>
            Math.abs(v.worldX - dragged.worldVertices[i].worldX) < 0.01 &&
            Math.abs(v.worldY - dragged.worldVertices[i].worldY) < 0.01,
        )
      ) {
        this.undoStack.update((s) => {
          s.pop();
          return [...s];
        });
      }
      this.dragStartScreen.set(null);
      this._draggingAnnotationId = null;
      return;
    }

    const deleteLassoStart = this._deleteLassoStart;
    if (deleteLassoStart !== null) {
      this._deleteLassoStart = null;
      const pts = this.deleteLassoPoints();
      this.deleteLassoPoints.set([]);

      const anyMoved = pts.some(
        (p) => Math.abs(p.x - deleteLassoStart.x) > 3 || Math.abs(p.y - deleteLassoStart.y) > 3,
      );
      if (!anyMoved || pts.length < 3) return;

      const hull = concaveman(pts.map((p) => [p.x, p.y]));
      if (hull.length < 3) return;

      const pose = this.carPose();
      const deleteWorldVerts = hull.map(([x, y]) => this.screenToWorld(x, y, pose));
      this._applyDeletePolygon(deleteWorldVerts);
      return;
    }

    const lassoStart = this._lassoStart;
    if (lassoStart === null) return;

    const anyMoved = this.lassoPoints().some(
      (p) => Math.abs(p.x - lassoStart.x) > 3 || Math.abs(p.y - lassoStart.y) > 3,
    );
    if (!anyMoved) {
      this.lassoPoints.set([]);
      this.handleAnnotationClick(lassoStart.x, lassoStart.y);
      this._lassoStart = null;
      return;
    }

    const pts = this.lassoPoints();
    if (pts.length < 3) {
      this.lassoPoints.set([]);
      this._lassoStart = null;
      return;
    }
    const hull = concaveman(pts.map((p) => [p.x, p.y]));
    const pose = this.carPose();
    const worldVerts = hull.map(([x, y]) => this.screenToWorld(x, y, pose));
    const timestamp = this.videoEl.currentTime;

    if (e.shiftKey) {
      const newPolygon = this._toPolygon(worldVerts);
      const targetId = this._findBestMergeTarget(newPolygon);
      if (targetId !== null) {
        this.pushState();
        this.annotations.update((arr) =>
          arr.map((a) => {
            if (a.id !== targetId) return a;
            const existing = this._toPolygon(a.worldVertices);
            try {
              const merged: MultiPolygon = polygonClipping.union(existing, newPolygon);
              if (merged.length > 0) {
                return { ...a, worldVertices: this._ringToVertices(merged[0][0]) };
              }
            } catch {}
            return { ...a, worldVertices: [...a.worldVertices, ...worldVerts] };
          }),
        );
        this.selectAnnotation(targetId);
      } else {
        const id = this._createAnnotation(worldVerts, timestamp);
        this.selectAnnotation(id);
      }
    } else {
      const id = this._createAnnotation(worldVerts, timestamp);
      this.selectAnnotation(id);
    }
    this.lassoPoints.set([]);
    this._lassoStart = null;
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Shift') this.shiftKeyDown.set(true);

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

    if (e.key.startsWith('Arrow')) {
      const a = this.editPanelAnnotation();
      if (!a) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      this.nudgeAnnotation(a.id, e.key, e.shiftKey);
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const a = this.editPanelAnnotation();
      if (!a) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      this.deleteAnnotation(a.id);
      return;
    }

    if (/^[0-9]$/.test(e.key)) {
      const a = this.hoveredAnnotation();
      if (!a) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      const idx = e.key === '0' ? 9 : parseInt(e.key) - 1;
      if (idx >= 0 && idx < MISTAKE_TYPES.length) {
        this.onTypeChange(a.id, MISTAKE_TYPES[idx]);
      }
    }
  }

  @HostListener('window:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent) {
    if (e.key === 'Shift') this.shiftKeyDown.set(false);
  }

  // ── hover / click detection ──

  private findAnnotationAtScreen(sx: number, sy: number): PolygonAnnotation | undefined {
    const pose = this.carPose();
    return this.annotations().find((a) => {
      const screenVerts: Pair[] = a.worldVertices.map((v) => {
        const s = this.worldToScreen(v.worldX, v.worldY, pose);
        return [s.x, s.y];
      });
      if (!this.pointInPolygon(sx, sy, screenVerts)) return false;
      for (const hole of a.holes) {
        const holeScreenVerts: Pair[] = hole.map((v) => {
          const s = this.worldToScreen(v.worldX, v.worldY, pose);
          return [s.x, s.y];
        });
        if (this.pointInPolygon(sx, sy, holeScreenVerts)) return false;
      }
      return true;
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

  // annotation selection

  selectAnnotation(id: number) {
    this._flushCommentDebounce();
    const a = this.annotations().find((x) => x.id === id);
    if (!a) return;
    this.selectedAnnotationId.set(id);
    this.editComment.set(a.comment);
  }

  clearSelection() {
    this._flushCommentDebounce();
    this.selectedAnnotationId.set(null);
    this.editComment.set('');
  }

  // annotation field updates

  onTypeChange(id: number, type: string) {
    const existing = this.annotations().find((x) => x.id === id);
    if (!existing || existing.mistakeType === type) return;
    this.pushState();
    const label = type !== 'Unspecified' ? `${type} #${id}` : `#${id}`;
    this.annotations.update((arr) =>
      arr.map((a) => (a.id === id ? { ...a, mistakeType: type, label } : a)),
    );
  }

  onCommentInput(id: number, comment: string) {
    this.editComment.set(comment);
    this._pendingComment = { id, comment };
    if (this._commentTimer) clearTimeout(this._commentTimer);
    this._commentTimer = setTimeout(() => {
      this._saveComment();
    }, 300);
  }

  private _saveComment() {
    if (this._pendingComment) {
      const { id, comment } = this._pendingComment;
      this.pushState();
      this.annotations.update((arr) => arr.map((a) => (a.id === id ? { ...a, comment } : a)));
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

  nudgeAnnotation(id: number, key: string, shiftKey: boolean) {
    const pixelStep = shiftKey ? 1 : 5;
    let screenDx = 0,
      screenDy = 0;
    if (key === 'ArrowUp') screenDy = -pixelStep;
    else if (key === 'ArrowDown') screenDy = pixelStep;
    else if (key === 'ArrowLeft') screenDx = -pixelStep;
    else if (key === 'ArrowRight') screenDx = pixelStep;

    if (screenDx === 0 && screenDy === 0) return;

    const yaw = this.carPose().yaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const ppm = this.pixelsPerMeter;
    const worldDx = (screenDx * cos - screenDy * sin) / ppm;
    const worldDy = (screenDx * sin + screenDy * cos) / ppm;

    this.pushState();
    this.annotations.update((arr) =>
      arr.map((a) => {
        if (a.id !== id) return a;
        return {
          ...a,
          worldVertices: a.worldVertices.map((v) => ({
            worldX: v.worldX + worldDx,
            worldY: v.worldY + worldDy,
          })),
          holes: this._translateHoles(a.holes, worldDx, worldDy),
        };
      }),
    );
  }

  deleteAnnotation(id: number) {
    this._flushCommentDebounce();
    this.pushState();
    if (this.selectedAnnotationId() === id) this.clearSelection();
    this.annotations.update((arr) => arr.filter((a) => a.id !== id));
  }

  onTimestampChange(id: number, value: string) {
    const seconds = this.parseTimestamp(value);
    if (isNaN(seconds)) return;
    const existing = this.annotations().find((x) => x.id === id);
    if (!existing || existing.timestamp === seconds) return;
    this._flushCommentDebounce();
    this.pushState();
    this.annotations.update((arr) =>
      arr.map((a) => (a.id === id ? { ...a, timestamp: seconds } : a)),
    );
  }

  jumpToAnnotation(id: number) {
    const a = this.annotations().find((x) => x.id === id);
    if (a && this.videoEl) this.videoEl.currentTime = a.timestamp;
  }

  formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // undo / redo

  private _snapshot() {
    return { annotations: JSON.parse(JSON.stringify(this.annotations())), nextId: this._nextId };
  }

  private pushState() {
    this.undoStack.update((s) => {
      s.push(this._snapshot());
      if (s.length > this.MAX_HISTORY) s.shift();
      return [...s];
    });
    this.redoStack.set([]);
  }

  undo() {
    this._flushCommentDebounce();
    if (!this.canUndo()) return;
    let state: { annotations: PolygonAnnotation[]; nextId: number };
    this.undoStack.update((s) => {
      state = s.pop()!;
      return [...s];
    });
    this.redoStack.update((s) => {
      s.push(this._snapshot());
      return [...s];
    });
    this.annotations.set(state!.annotations);
    this._nextId = state!.nextId;
    this.clearSelection();
  }

  redo() {
    this._flushCommentDebounce();
    if (!this.canRedo()) return;
    let state: { annotations: PolygonAnnotation[]; nextId: number };
    this.redoStack.update((s) => {
      state = s.pop()!;
      return [...s];
    });
    this.undoStack.update((s) => {
      s.push(this._snapshot());
      return [...s];
    });
    this.annotations.set(state!.annotations);
    this._nextId = state!.nextId;
    this.clearSelection();
  }

  // export / import

  exportAnnotations() {
    const json = JSON.stringify(this.annotations(), null, 2);
    navigator.clipboard.writeText(json).catch(() => {});
  }

  async importAnnotations() {
    try {
      const text = await navigator.clipboard.readText();
      const data = JSON.parse(text) as any[];
      if (!Array.isArray(data)) return;
      data.forEach((a) => {
        if (!Array.isArray(a.holes)) a.holes = [];
      });
      this.pushState();
      this._nextId = Math.max(0, ...data.map((a: any) => a.id)) + 1;
      this.annotations.set(data);
      this.clearSelection();
    } catch {
      /* invalid json or clipboard read failed */
    }
  }

  // ── delete polygon (middle mouse) ──

  private _applyDeletePolygon(deleteWorldVerts: { worldX: number; worldY: number }[]) {
    const clipPolygon = this._toPolygon(deleteWorldVerts);

    // First pass: check if the delete lasso is fully inside any annotation's outer
    // polygon (not connected to the outside) and doesn't overlap existing holes.
    for (const a of this.annotations()) {
      const outerPolygon = this._toPolygon(a.worldVertices);
      if (!this._polygonsIntersect(outerPolygon, clipPolygon)) continue;
      try {
        const diff = polygonClipping.difference(clipPolygon, outerPolygon);
        if (diff.length === 0) {
          // Check if clip overlaps any existing hole
          let overlapsHole = false;
          for (const hole of a.holes) {
            if (this._polygonsIntersect(clipPolygon, this._toPolygon(hole))) {
              overlapsHole = true;
              break;
            }
          }
          if (!overlapsHole) {
            this.pushState();
            this.annotations.update((arr) =>
              arr.map((aa) =>
                aa.id === a.id ? { ...aa, holes: [...aa.holes, deleteWorldVerts] } : aa,
              ),
            );
            return;
          }
        }
      } catch {}
    }

    // Fallback: unified difference on the full polygon (outer + holes)
    const toDelete: number[] = [];
    const toReplace: {
      id: number;
      worldVertices: { worldX: number; worldY: number }[];
      holes: { worldX: number; worldY: number }[][];
    }[] = [];
    const newAnnotations: PolygonAnnotation[] = [];

    for (const a of this.annotations()) {
      const subjectPolygon = this._toPolygon(a.worldVertices);
      if (!this._polygonsIntersect(subjectPolygon, clipPolygon)) continue;
      try {
        // Build the full polygon: outer ring + all holes
        const fullPolygon: Polygon = [
          a.worldVertices.map((v) => [v.worldX, v.worldY] as Pair),
          ...a.holes.map((h) => h.map((v) => [v.worldX, v.worldY] as Pair)),
        ];
        const result: MultiPolygon = polygonClipping.difference(
          [fullPolygon] as MultiPolygon,
          clipPolygon,
        );
        if (result.length === 0) {
          toDelete.push(a.id);
        } else {
          const newHoles = result[0].slice(1).map((r) => this._ringToVertices(r));
          toReplace.push({
            id: a.id,
            worldVertices: this._ringToVertices(result[0][0]),
            holes: newHoles,
          });
          for (let i = 1; i < result.length; i++) {
            const newId = this._nextId++;
            const splitHoles = result[i].slice(1).map((r) => this._ringToVertices(r));
            newAnnotations.push({
              id: newId,
              worldVertices: this._ringToVertices(result[i][0]),
              holes: splitHoles,
              label: `#${newId}`,
              mistakeType: a.mistakeType,
              comment: a.comment,
              timestamp: a.timestamp,
            });
          }
        }
      } catch {}
    }

    if (toDelete.length === 0 && toReplace.length === 0 && newAnnotations.length === 0) return;
    this.pushState();
    this.annotations.update((arr) => {
      let next = arr.filter((a) => !toDelete.includes(a.id));
      next = next.map((a) => {
        const r = toReplace.find((x) => x.id === a.id);
        return r ? { ...a, worldVertices: r.worldVertices, holes: r.holes } : a;
      });
      return [...next, ...newAnnotations];
    });
    if (toDelete.includes(this.selectedAnnotationId()!)) this.clearSelection();
  }

  // ── merge polygon (shift + left mouse) ──

  private _findBestMergeTarget(newPolygon: Polygon): number | null {
    const newArea = this._polygonArea(newPolygon[0]);
    if (newArea <= 0) return null;
    let bestId: number | null = null;
    let bestRatio = 0;

    for (const a of this.annotations()) {
      const existing = this._toPolygon(a.worldVertices);
      if (!this._polygonsIntersect(existing, newPolygon)) continue;
      try {
        const overlap = polygonClipping.intersection(existing, newPolygon);
        let overlapArea = 0;
        for (const poly of overlap) overlapArea += this._polygonArea(poly[0]);
        const ratio = overlapArea / newArea;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestId = a.id;
        }
      } catch {}
    }
    return bestRatio > 0.05 ? bestId : null;
  }

  private _polygonArea(vertices: Pair[]): number {
    let area = 0;
    for (let i = 0; i < vertices.length; i++) {
      const j = (i + 1) % vertices.length;
      area += vertices[i][0] * vertices[j][1];
      area -= vertices[j][0] * vertices[i][1];
    }
    return Math.abs(area) / 2;
  }

  private _polygonsIntersect(a: Polygon, b: Polygon): boolean {
    const [aPts, bPts] = [a[0], b[0]];
    const bb = (pts: Pair[]) => ({
      minX: Math.min(...pts.map((p) => p[0])),
      maxX: Math.max(...pts.map((p) => p[0])),
      minY: Math.min(...pts.map((p) => p[1])),
      maxY: Math.max(...pts.map((p) => p[1])),
    });
    const ba = bb(aPts);
    const bb2 = bb(bPts);
    if (ba.maxX < bb2.minX || ba.minX > bb2.maxX || ba.maxY < bb2.minY || ba.minY > bb2.maxY)
      return false;
    for (const [px, py] of aPts) if (this.pointInPolygon(px, py, bPts)) return true;
    for (const [px, py] of bPts) if (this.pointInPolygon(px, py, aPts)) return true;
    return false;
  }

  // helpers

  private _toPolygon(verts: { worldX: number; worldY: number }[]): Polygon {
    return [verts.map((v) => [v.worldX, v.worldY] as Pair)];
  }

  private _ringToVertices(ring: Pair[]): { worldX: number; worldY: number }[] {
    return ring.map(([wx, wy]) => ({ worldX: wx, worldY: wy }));
  }

  private _createAnnotation(
    worldVerts: { worldX: number; worldY: number }[],
    timestamp: number,
  ): number {
    const id = this._nextId++;
    this.pushState();
    this.annotations.update((arr) => [
      ...arr,
      {
        id,
        worldVertices: worldVerts,
        holes: [],
        label: `#${id}`,
        mistakeType: 'Unspecified',
        comment: '',
        timestamp,
      },
    ]);
    return id;
  }

  private _translateHoles(holes: { worldX: number; worldY: number }[][], dx: number, dy: number) {
    return holes.map((hole) => hole.map((v) => ({ worldX: v.worldX + dx, worldY: v.worldY + dy })));
  }

  private _drawAnnotationPath(
    ctx: any,
    shape: any,
    verts: { worldX: number; worldY: number }[],
    holes: { worldX: number; worldY: number }[][],
  ) {
    ctx.beginPath();
    ctx.moveTo(verts[0].worldX, verts[0].worldY);
    for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].worldX, verts[i].worldY);
    ctx.closePath();
    for (const hole of holes) {
      ctx.moveTo(hole[0].worldX, hole[0].worldY);
      for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].worldX, hole[i].worldY);
      ctx.closePath();
    }
    ctx.fillStrokeShape(shape);
  }

  private _screenCoordsInStage(e: MouseEvent): { x: number; y: number } | null {
    const rect = this.annotationStage?.nativeElement?.getBoundingClientRect();
    if (!rect) return null;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const vd = this.videoDims();
    if (sx < 0 || sy < 0 || sx > vd.width || sy > vd.height) return null;
    return { x: sx, y: sy };
  }

  private pointInPolygon(px: number, py: number, vertices: Pair[]): boolean {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i][0],
        yi = vertices[i][1];
      const xj = vertices[j][0],
        yj = vertices[j][1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  private parseTimestamp(value: string): number {
    const trimmed = value.trim();
    const colonMatch = trimmed.match(/^(\d+):(\d{1,2})$/);
    if (colonMatch) {
      return parseInt(colonMatch[1]) * 60 + parseInt(colonMatch[2]);
    }
    const num = parseFloat(trimmed);
    if (!isNaN(num) && num >= 0) return num;
    return NaN;
  }

  private getCarPositionAtTime(time: number): CarPose {
    return { timestamp: 0, worldX: 50 + time, worldY: 50, yaw: 0 };
  }

  private screenToWorld(sx: number, sy: number, cp: CarPose) {
    const { width: vw, height: vh } = this.videoDims();
    const x = (sx - vw / 2) / this.pixelsPerMeter;
    const y = (sy - vh / 2) / this.pixelsPerMeter;
    const cos = Math.cos(cp.yaw),
      sin = Math.sin(cp.yaw);
    return { worldX: x * cos - y * sin + cp.worldX, worldY: x * sin + y * cos + cp.worldY };
  }

  private worldToScreen(wx: number, wy: number, cp: CarPose) {
    const { width: vw, height: vh } = this.videoDims();
    const x = (wx - cp.worldX) * this.pixelsPerMeter;
    const y = (wy - cp.worldY) * this.pixelsPerMeter;
    const cos = Math.cos(-cp.yaw),
      sin = Math.sin(-cp.yaw);
    return { x: x * cos - y * sin + vw / 2, y: x * sin + y * cos + vh / 2 };
  }

  private polygonCentroid(verts: { worldX: number; worldY: number }[]) {
    let cx = 0,
      cy = 0;
    for (const v of verts) {
      cx += v.worldX;
      cy += v.worldY;
    }
    return { worldX: cx / verts.length, worldY: cy / verts.length };
  }

  readonly MISTAKE_TYPES = MISTAKE_TYPES;
}
