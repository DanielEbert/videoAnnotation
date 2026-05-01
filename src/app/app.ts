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
  worldVertices: { worldX: number; worldY: number }[];
  label: string;
}

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

  // ── derivations ──

  layerConfig = computed(() => {
    const { width, height } = this.videoDims();
    const { worldX, worldY, yaw } = this.carPose();
    return { x: width / 2, y: height / 2, offsetX: worldX, offsetY: worldY,
      scaleX: this.pixelsPerMeter, scaleY: this.pixelsPerMeter, rotation: -yaw * 180 / Math.PI };
  });

  polygonConfigs = computed(() =>
    this.annotations().map(a => ({
      points: a.worldVertices.flatMap(v => [v.worldX, v.worldY]),
      closed: true, fill: 'rgba(255,0,0,0.15)', stroke: 'rgba(255,0,0,0.7)',
      strokeWidth: 2 / this.pixelsPerMeter,
    }))
  );

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

  handleMouseDown(e: any) {
    if (!this.isDrawingMode()) return;
    const pos = e.event.currentTarget.getPointerPosition();
    if (!pos) return;
    e.event.evt?.preventDefault();
    this.isLassoing.set(true);
    this.lassoPoints.set([{ x: pos.x, y: pos.y }]);
  }

  @HostListener('window:mousemove', ['$event'])
  onWindowMouseMove(e: MouseEvent) {
    if (!this.isLassoing()) return;
    e.preventDefault();
    const { left, top } = this.annotationStage.nativeElement.getBoundingClientRect();
    this.lassoPoints.update(pts => [...pts, { x: e.clientX - left, y: e.clientY - top }]);
  }

  @HostListener('window:mouseup')
  onWindowMouseUp() {
    if (!this.isLassoing()) return;
    this.isLassoing.set(false);
    const pts = this.lassoPoints();
    if (pts.length < 3) { this.lassoPoints.set([]); return; }
    const hull = concaveman(pts.map(p => [p.x, p.y]));
    const pose = this.carPose();
    this.annotations.update(arr => [
      ...arr,
      { worldVertices: hull.map(([x, y]) => this.screenToWorld(x, y, pose)), label: `#${arr.length + 1}` },
    ]);
    this.lassoPoints.set([]);
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

}
