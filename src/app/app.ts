import { Component, computed, ElementRef, HostListener, signal, ViewChild } from '@angular/core';
import { RouterOutlet } from '@angular/router';
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
  imports: [RouterOutlet, StageComponent, CoreShapeComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  @ViewChild('videoPlayer') videoPlayer!: ElementRef<HTMLVideoElement>;
  @ViewChild('annotationStage', { read: ElementRef }) annotationStage!: ElementRef<HTMLDivElement>;

  private videoEl!: HTMLVideoElement;
  private pixelsPerMeter = 100;

  isDrawingMode = signal(true);
  annotations = signal<PolygonAnnotation[]>([]);
  carPose = signal<CarPose>({ timestamp: 0, worldX: 50, worldY: 50, yaw: 0 });
  videoDims = signal({ w: 640, h: 360 });

  isLassoing = signal(false);
  lassoPoints = signal<{ x: number; y: number }[]>([]);

  stageConfig = computed(() => ({
    width: this.videoDims().w,
    height: this.videoDims().h,
  }));

  layerConfig = computed(() => {
    const d = this.videoDims();
    const p = this.carPose();
    return {
      x: d.w / 2,
      y: d.h / 2,
      offsetX: p.worldX,
      offsetY: p.worldY,
      scaleX: this.pixelsPerMeter,
      scaleY: this.pixelsPerMeter,
      rotation: -p.yaw * 180 / Math.PI,
    };
  });

  polygonConfigs = computed(() =>
    this.annotations().map(a => {
      const pts: number[] = [];
      for (const v of a.worldVertices) {
        pts.push(v.worldX, v.worldY);
      }
      return {
        points: pts,
        closed: true,
        fill: 'rgba(255,0,0,0.15)',
        stroke: 'rgba(255,0,0,0.7)',
        strokeWidth: 2 / this.pixelsPerMeter,
      };
    })
  );

  labelConfigs = computed(() => {
    const p = this.carPose();
    return this.annotations().map(a => {
      const c = this.polygonCentroid(a.worldVertices);
      const s = this.worldToScreen(c.worldX, c.worldY, p);
      return { x: s.x + 10, y: s.y + 5, text: a.label, fontSize: 14, fill: 'white' };
    });
  });

  lassoLineConfig = computed(() => {
    const pts = this.lassoPoints();
    if (pts.length < 2) return null;
    const flat: number[] = [];
    for (const pt of pts) {
      flat.push(pt.x, pt.y);
    }
    return {
      points: flat,
      closed: true,
      fill: 'rgba(0,255,255,0.15)',
      stroke: 'rgba(0,255,255,0.6)',
      strokeWidth: 2,
      lineCap: 'round' as CanvasLineCap,
      lineJoin: 'round' as CanvasLineJoin,
    };
  });

  ngAfterViewInit() {
    this.videoEl = this.videoPlayer.nativeElement;
    this.videoEl.addEventListener('loadedmetadata', () => this.onVideoReady());
  }

  @HostListener('window:resize')
  onResize() {
    this.onVideoReady();
  }

  onVideoReady() {
    requestAnimationFrame(() => {
      this.videoDims.set({ w: this.videoEl.clientWidth, h: this.videoEl.clientHeight });
    });
  }

  onTimeUpdate() {
    this.carPose.set(this.getCarPositionAtTime(this.videoEl.currentTime));
  }

  toggleDrawingMode() {
    this.isDrawingMode.update(v => !v);
  }

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
    const rect = this.annotationStage.nativeElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.lassoPoints.update(pts => [...pts, { x, y }]);
  }

  @HostListener('window:mouseup')
  onWindowMouseUp() {
    if (!this.isLassoing()) return;
    this.isLassoing.set(false);
    const pts = this.lassoPoints();
    if (pts.length < 3) {
      this.lassoPoints.set([]);
      return;
    }
    const hull = concaveman(pts.map(p => [p.x, p.y] as [number, number]));
    const pose = this.carPose();
    const worldVerts = hull.map(([x, y]) => this.screenToWorld(x, y, pose));
    this.annotations.update(arr => [
      ...arr,
      { worldVertices: worldVerts, label: `#${arr.length + 1}` },
    ]);
    this.lassoPoints.set([]);
  }

  private getCarPositionAtTime(time: number): CarPose {
    return { timestamp: 0, worldX: 50 + time, worldY: 50, yaw: 0 };
  }

  private screenToWorld(sx: number, sy: number, cp: CarPose) {
    const vw = this.videoDims().w;
    const vh = this.videoDims().h;
    let x = sx - vw / 2;
    let y = sy - vh / 2;
    x /= this.pixelsPerMeter;
    y /= this.pixelsPerMeter;
    const cos = Math.cos(cp.yaw);
    const sin = Math.sin(cp.yaw);
    return {
      worldX: x * cos - y * sin + cp.worldX,
      worldY: x * sin + y * cos + cp.worldY,
    };
  }

  private worldToScreen(wx: number, wy: number, cp: CarPose) {
    const vw = this.videoDims().w;
    const vh = this.videoDims().h;
    let x = (wx - cp.worldX) * this.pixelsPerMeter;
    let y = (wy - cp.worldY) * this.pixelsPerMeter;
    const cos = Math.cos(-cp.yaw);
    const sin = Math.sin(-cp.yaw);
    return {
      x: x * cos - y * sin + vw / 2,
      y: x * sin + y * cos + vh / 2,
    };
  }

  private polygonCentroid(verts: { worldX: number; worldY: number }[]) {
    let cx = 0;
    let cy = 0;
    for (const v of verts) {
      cx += v.worldX;
      cy += v.worldY;
    }
    return { worldX: cx / verts.length, worldY: cy / verts.length };
  }

}
