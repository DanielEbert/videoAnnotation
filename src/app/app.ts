import { Component, ElementRef, HostListener, signal, ViewChild } from '@angular/core';
import { RouterOutlet } from '@angular/router';

interface CarPose {
  timestamp: number;
  worldX: number;
  worldY: number;
  yaw: number;
}

interface PointAnnotation {
  worldX: number;
  worldY: number;
  label: string;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  @ViewChild('videoPlayer') videoPlayer!: ElementRef<HTMLVideoElement>;
  @ViewChild('annotationCanvas') annotationCanvas!: ElementRef<HTMLCanvasElement>;

  private videoEl!: HTMLVideoElement;
  private canvasEl!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;

  // TODO
  private pixelsPerMeter = 100;

  public isDrawingMode = true;

  private annotations = [];

  ngAfterViewInit() {
    this.videoEl = this.videoPlayer.nativeElement;
    this.canvasEl = this.annotationCanvas.nativeElement;
    this.ctx = this.canvasEl.getContext('2d')!;

    this.videoEl.addEventListener('loadedmetadata', () => {
      this.onVideoReady()
    });
  }

  @HostListener('window:resize')
  onResize(): void {
    this.onVideoReady();
  }

  public onVideoReady() {
    this.canvasEl.width = this.videoEl.videoWidth;
    this.canvasEl.height = this.videoEl.videoHeight;
    this.draw();
  }

  onTimeUpdate() {
    this.draw();
  }

  public toggleDrawingMode() {
    this.isDrawingMode = !this.isDrawingMode;
    console.log('Drawing mode:', this.isDrawingMode);
  }

  public handleCanvasClick(event: MouseEvent) {
    console.log('on handleCanvasClick')
    if (!this.isDrawingMode) return;
    const currentCarPose = this.getCarPositionAtTime(this.videoEl.currentTime);
    const canvasMousePos = this.getMousePos(event);
    const worldCoords = this.screenToWorld(canvasMousePos.x, canvasMousePos.y, currentCarPose);

    this.annotations.push({
      worldX: worldCoords.worldX,
      worldY: worldCoords.worldY,
      label: `Annotation #${this.annotations.length + 1}`
    })
    this.draw();
  }

  draw() {
    console.log(`Drawing Annotations: ${this.annotations.length} items`);

    const currentCarPose = this.getCarPositionAtTime(this.videoEl.currentTime);
    const canvas = this.annotationCanvas.nativeElement;
    this.ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.ctx.save();

    this.ctx.translate(this.canvasEl.width / 2, this.canvasEl.height / 2);
    this.ctx.rotate(-currentCarPose.yaw);
    this.ctx.scale(this.pixelsPerMeter, this.pixelsPerMeter);
    this.ctx.translate(-currentCarPose.worldX, -currentCarPose.worldY);

    this.annotations.forEach(ann => this.drawAnnotation(ann))
    this.ctx.restore();
  }

  // TODO
  private getCarPositionAtTime(time: number): CarPose {
    // This is placeholder logic.
    return { timestamp: 0, worldX: 50 + time, worldY: 50, yaw: 0 };
  }

  private drawAnnotation(annotation: PointAnnotation): void {
    this.ctx.beginPath();
    this.ctx.arc(annotation.worldX, annotation.worldY, 0.1, 0, 2 * Math.PI);
    this.ctx.fillStyle = 'rgba(255, 0, 0, 0.7)';
    this.ctx.fill();
    this.ctx.closePath();

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const screenPos = this.worldToScreen(annotation.worldX, annotation.worldY, this.getCarPositionAtTime(this.videoEl.currentTime)!);
    this.ctx.fillStyle = 'white';
    this.ctx.font = '14px Arial';
    this.ctx.fillText(annotation.label, screenPos.x + 10, screenPos.y + 5);
    this.ctx.restore();
  }

  // Converts mouse event coordinates to canvas-local coordinates.
  // Accounts for CSS scaling of the canvas element.
  private getMousePos(event: MouseEvent): { x: number, y: number } {
    const rect = this.canvasEl.getBoundingClientRect();
    const scaleX = this.canvasEl.width / rect.width;
    const scaleY = this.canvasEl.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  }

  // Converts a point from screen (canvas) space to world space.
  // This is the inverse of the drawing transformation.
  private screenToWorld(screenX: number, screenY: number, carPose: CarPose): { worldX: number, worldY: number } {
    const canvasCenterX = this.canvasEl.width / 2;
    const canvasCenterY = this.canvasEl.height / 2;

    // Undo the canvas center translation
    let x = screenX - canvasCenterX;
    let y = screenY - canvasCenterY;

    // Undo the scale
    x /= this.pixelsPerMeter;
    y /= this.pixelsPerMeter;

    // Undo the rotation by rotating in the positive direction of the car's yaw
    const cosYaw = Math.cos(carPose.yaw);
    const sinYaw = Math.sin(carPose.yaw);
    const rotatedX = x * cosYaw - y * sinYaw;
    const rotatedY = x * sinYaw + y * cosYaw;

    // Undo the car position translation
    const worldX = rotatedX + carPose.worldX;
    const worldY = rotatedY + carPose.worldY;

    return { worldX, worldY };
  }

  // Converts a point from world space to screen (canvas) space.
  // Useful for UI elements like labels that shouldn't be scaled/rotated.
  private worldToScreen(worldX: number, worldY: number, carPose: CarPose): { x: number, y: number } {
    const canvasCenterX = this.canvasEl.width / 2;
    const canvasCenterY = this.canvasEl.height / 2;

    // Translate relative to the car
    let x = worldX - carPose.worldX;
    let y = worldY - carPose.worldY;

    // Scale up to pixels
    x *= this.pixelsPerMeter;
    y *= this.pixelsPerMeter;

    // Rotate based on the car's yaw (negative)
    const cosYaw = Math.cos(-carPose.yaw);
    const sinYaw = Math.sin(-carPose.yaw);
    const rotatedX = x * cosYaw - y * sinYaw;
    const rotatedY = x * sinYaw + y * cosYaw;

    // Translate to canvas center
    return {
      x: rotatedX + canvasCenterX,
      y: rotatedY + canvasCenterY
    };
  }
}
