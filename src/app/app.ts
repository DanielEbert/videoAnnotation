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
    return this.annotations().map((a) => {
      const isSel = a.id === selId;
      const isHover = a.id === hoverId;
      return {
        points: a.worldVertices.flatMap((v) => [v.worldX, v.worldY]),
        closed: true,
        fill: isSel
          ? 'rgba(255,255,0,0.25)'
          : isHover
            ? 'rgba(255,255,255,0.10)'
            : 'rgba(255,0,0,0.15)',
        stroke: isSel
          ? 'rgba(255,255,0,0.9)'
          : isHover
            ? 'rgba(200,200,255,0.5)'
            : 'rgba(255,0,0,0.7)',
        strokeWidth: isSel ? 3 / this.pixelsPerMeter : 2 / this.pixelsPerMeter,
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
      const rect = this.annotationStage?.nativeElement?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const vd = this.videoDims();
      if (sx < 0 || sy < 0 || sx > vd.width || sy > vd.height) return;
      e.preventDefault();
      this._deleteLassoStart = { x: sx, y: sy };
      this.deleteLassoPoints.set([{ x: sx, y: sy }]);
      return;
    }
    if (e.button !== 2) return;
    const rect = this.annotationStage?.nativeElement?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const vd = this.videoDims();
    if (sx < 0 || sy < 0 || sx > vd.width || sy > vd.height) return;
    const found = this.findAnnotationAtScreen(sx, sy);
    if (!found) return;
    e.preventDefault();
    this._flushCommentDebounce();
    this.pushState();
    this.selectAnnotation(found.id);
    this._draggingAnnotationId = found.id;
    this.dragStartScreen.set({ x: sx, y: sy });
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
      const newPolygon: Polygon = [worldVerts.map((v) => [v.worldX, v.worldY] as Pair)];
      const targetId = this._findBestMergeTarget(newPolygon);
      if (targetId !== null) {
        this.pushState();
        this.annotations.update((arr) =>
          arr.map((a) => {
            if (a.id !== targetId) return a;
            const existing: Polygon = [
              a.worldVertices.map((v) => [v.worldX, v.worldY] as Pair),
            ];
            try {
              const merged: MultiPolygon = polygonClipping.union(existing, newPolygon);
              if (merged.length > 0) {
                const ring = merged[0][0];
                return {
                  ...a,
                  worldVertices: ring.map(([wx, wy]) => ({ worldX: wx, worldY: wy })),
                };
              }
            } catch {
              // union failed, merge by appending as-is
            }
            return {
              ...a,
              worldVertices: [...a.worldVertices, ...worldVerts],
            };
          }),
        );
        this.selectAnnotation(targetId);
      } else {
        const id = this._nextId++;
        this.pushState();
        this.annotations.update((arr) => [
          ...arr,
          {
            id,
            worldVertices: worldVerts,
            label: `#${id}`,
            mistakeType: 'Unspecified',
            comment: '',
            timestamp,
          },
        ]);
        this.selectAnnotation(id);
      }
    } else {
      const id = this._nextId++;
      this.pushState();
      this.annotations.update((arr) => [
        ...arr,
        {
          id,
          worldVertices: worldVerts,
          label: `#${id}`,
          mistakeType: 'Unspecified',
          comment: '',
          timestamp,
        },
      ]);
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
      const screenVerts = a.worldVertices.map((v) => {
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
      const data = JSON.parse(text) as PolygonAnnotation[];
      if (!Array.isArray(data)) return;
      this.pushState();
      this._nextId = Math.max(0, ...data.map((a) => a.id)) + 1;
      this.annotations.set(data);
      this.clearSelection();
    } catch {
      /* invalid json or clipboard read failed */
    }
  }

  // ── delete polygon (middle mouse) ──

  private _applyDeletePolygon(deleteWorldVerts: { worldX: number; worldY: number }[]) {
    const clipPolygon: Polygon = [deleteWorldVerts.map((v) => [v.worldX, v.worldY] as Pair)];
    const toDelete: number[] = [];
    const toReplace: { id: number; worldVertices: { worldX: number; worldY: number }[] }[] = [];
    const newAnnotations: PolygonAnnotation[] = [];

    for (const a of this.annotations()) {
      const subjectPolygon: Polygon = [
        a.worldVertices.map((v) => [v.worldX, v.worldY] as Pair),
      ];

      // check if there is any overlap before computing difference
      if (!this._polygonsIntersect(subjectPolygon, clipPolygon)) continue;

      try {
        const result: MultiPolygon = polygonClipping.difference(subjectPolygon, clipPolygon);

        if (result.length === 0) {
          // fully enclosed — delete the annotation
          toDelete.push(a.id);
        } else if (result.length === 1) {
          const ring = result[0][0];
          const newVerts = ring.map(([wx, wy]) => ({ worldX: wx, worldY: wy }));
          toReplace.push({ id: a.id, worldVertices: newVerts });
        } else {
          // multiple resulting polygons — keep one for original id, new for rest
          const ring = result[0][0];
          const verts0 = ring.map(([wx, wy]) => ({ worldX: wx, worldY: wy }));
          toReplace.push({ id: a.id, worldVertices: verts0 });
          for (let i = 1; i < result.length; i++) {
            const ringI = result[i][0];
            const vertsI = ringI.map(([wx, wy]) => ({ worldX: wx, worldY: wy }));
            const newId = this._nextId++;
            newAnnotations.push({
              id: newId,
              worldVertices: vertsI,
              label: `#${newId}`,
              mistakeType: a.mistakeType,
              comment: a.comment,
              timestamp: a.timestamp,
            });
          }
        }
      } catch {
        // if difference fails, skip this annotation
      }
    }

    if (toDelete.length === 0 && toReplace.length === 0 && newAnnotations.length === 0) return;

    this.pushState();
    this.annotations.update((arr) => {
      let result = arr.filter((a) => !toDelete.includes(a.id));
      result = result.map((a) => {
        const r = toReplace.find((x) => x.id === a.id);
        return r ? { ...a, worldVertices: r.worldVertices } : a;
      });
      return [...result, ...newAnnotations];
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
      const existing: Polygon = [
        a.worldVertices.map((v) => [v.worldX, v.worldY] as Pair),
      ];

      if (!this._polygonsIntersect(existing, newPolygon)) continue;

      try {
        const overlap = polygonClipping.intersection(existing, newPolygon);
        let overlapArea = 0;
        for (const poly of overlap) {
          overlapArea += this._polygonArea(poly[0]);
        }
        const ratio = overlapArea / newArea;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestId = a.id;
        }
      } catch {
        // skip
      }
    }

    // require at least 5% overlap for a merge
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
    const aPts = a[0];
    const bPts = b[0];

    // fast bounding box check
    const aMinX = Math.min(...aPts.map((p) => p[0]));
    const aMaxX = Math.max(...aPts.map((p) => p[0]));
    const aMinY = Math.min(...aPts.map((p) => p[1]));
    const aMaxY = Math.max(...aPts.map((p) => p[1]));
    const bMinX = Math.min(...bPts.map((p) => p[0]));
    const bMaxX = Math.max(...bPts.map((p) => p[0]));
    const bMinY = Math.min(...bPts.map((p) => p[1]));
    const bMaxY = Math.max(...bPts.map((p) => p[1]));

    if (aMaxX < bMinX || aMinX > bMaxX || aMaxY < bMinY || aMinY > bMaxY) return false;

    // check if any vertex of a is inside b or vice versa
    for (const [px, py] of aPts) {
      if (this._pointInPolygonWorld(px, py, bPts)) return true;
    }
    for (const [px, py] of bPts) {
      if (this._pointInPolygonWorld(px, py, aPts)) return true;
    }

    return false;
  }

  private _pointInPolygonWorld(
    px: number,
    py: number,
    vertices: Pair[],
  ): boolean {
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

  // helpers

  private pointInPolygon(px: number, py: number, vertices: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i].x,
        yi = vertices[i].y;
      const xj = vertices[j].x,
        yj = vertices[j].y;
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
