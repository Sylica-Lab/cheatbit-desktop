// ScreenshotHelper.ts

import path from "node:path";
import fs from "node:fs";
import { app, nativeImage, screen } from "electron";
import { v4 as uuidv4 } from "uuid";
import { execFile } from "child_process";
import { promisify } from "util";
import screenshot from "screenshot-desktop";
import os from "os";
import type { ScreenRegionSelection } from "./RegionSelectionOverlay";

const execFileAsync = promisify(execFile);

export class ScreenshotHelper {
  private screenshotQueue: string[] = [];
  private extraScreenshotQueue: string[] = [];
  private readonly MAX_SCREENSHOTS = 5;

  private readonly screenshotDir: string;
  private readonly extraScreenshotDir: string;
  private readonly tempDir: string;

  private view: "queue" | "solutions" | "debug" = "queue";

  constructor(view: "queue" | "solutions" | "debug" = "queue") {
    this.view = view;

    // Initialize directories
    this.screenshotDir = path.join(app.getPath("userData"), "screenshots");
    this.extraScreenshotDir = path.join(
      app.getPath("userData"),
      "extra_screenshots"
    );
    this.tempDir = path.join(
      app.getPath("temp"),
      "sylica-ai-screenshots"
    );

    // Create directories if they don't exist
    this.ensureDirectoriesExist();

    // Clean existing screenshot directories when starting the app
    this.cleanScreenshotDirectories();
  }

  private ensureDirectoriesExist(): void {
    const directories = [
      this.screenshotDir,
      this.extraScreenshotDir,
      this.tempDir,
    ];

    for (const dir of directories) {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          console.log(`Created directory: ${dir}`);
        } catch (err) {
          console.error(`Error creating directory ${dir}:`, err);
        }
      }
    }
  }

  // This method replaces loadExistingScreenshots() to ensure we start with empty queues
  private cleanScreenshotDirectories(): void {
    try {
      // Clean main screenshots directory
      if (fs.existsSync(this.screenshotDir)) {
        const files = fs
          .readdirSync(this.screenshotDir)
          .filter((file) => file.endsWith(".png"))
          .map((file) => path.join(this.screenshotDir, file));

        // Delete each screenshot file
        for (const file of files) {
          try {
            fs.unlinkSync(file);
            console.log(`Deleted existing screenshot: ${file}`);
          } catch (err) {
            console.error(`Error deleting screenshot ${file}:`, err);
          }
        }
      }

      // Clean extra screenshots directory
      if (fs.existsSync(this.extraScreenshotDir)) {
        const files = fs
          .readdirSync(this.extraScreenshotDir)
          .filter((file) => file.endsWith(".png"))
          .map((file) => path.join(this.extraScreenshotDir, file));

        // Delete each screenshot file
        for (const file of files) {
          try {
            fs.unlinkSync(file);
            console.log(`Deleted existing extra screenshot: ${file}`);
          } catch (err) {
            console.error(`Error deleting extra screenshot ${file}:`, err);
          }
        }
      }

      console.log("Screenshot directories cleaned successfully");
    } catch (err) {
      console.error("Error cleaning screenshot directories:", err);
    }
  }

  public getView(): "queue" | "solutions" | "debug" {
    return this.view;
  }

  public setView(view: "queue" | "solutions" | "debug"): void {
    console.log("Setting view in ScreenshotHelper:", view);
    console.log(
      "Current queues - Main:",
      this.screenshotQueue,
      "Extra:",
      this.extraScreenshotQueue
    );
    this.view = view;
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotQueue;
  }

  public getExtraScreenshotQueue(): string[] {
    console.log("Getting extra screenshot queue:", this.extraScreenshotQueue);
    return this.extraScreenshotQueue;
  }

  public clearQueues(): void {
    // Clear screenshotQueue
    this.screenshotQueue.forEach((screenshotPath) => {
      fs.unlink(screenshotPath, (err) => {
        if (err)
          console.error(`Error deleting screenshot at ${screenshotPath}:`, err);
      });
    });
    this.screenshotQueue = [];

    // Clear extraScreenshotQueue
    this.extraScreenshotQueue.forEach((screenshotPath) => {
      fs.unlink(screenshotPath, (err) => {
        if (err)
          console.error(
            `Error deleting extra screenshot at ${screenshotPath}:`,
            err
          );
      });
    });
    this.extraScreenshotQueue = [];
  }

  private getHideDelay(): number {
    return process.platform === "win32" ? 220 : 140;
  }

  private getRestoreDelay(): number {
    return process.platform === "win32" ? 90 : 60;
  }

  private getEarlyRestoreDelay(): number {
    return process.platform === "win32" ? 80 : 0;
  }

  private getOrderedCaptureDisplays(displays: Array<Record<string, any>>) {
    if (process.platform === "darwin") {
      return displays;
    }

    return [...displays].sort((left, right) => {
      const leftX =
        typeof left.left === "number" ? left.left : Number(left.offsetX) || 0;
      const rightX =
        typeof right.left === "number" ? right.left : Number(right.offsetX) || 0;

      if (leftX !== rightX) {
        return leftX - rightX;
      }

      const leftY =
        typeof left.top === "number" ? left.top : Number(left.offsetY) || 0;
      const rightY =
        typeof right.top === "number" ? right.top : Number(right.offsetY) || 0;

      return leftY - rightY;
    });
  }

  private async captureDisplayScreenshot(displayIndex: number): Promise<Buffer> {
    if (process.platform === "win32") {
      return this.captureScreenshot();
    }

    const displays = this.getOrderedCaptureDisplays(
      (await screenshot.listDisplays()) as Array<Record<string, any>>
    );
    const targetDisplay = displays[displayIndex] || displays[0];

    if (!targetDisplay) {
      return this.captureScreenshot();
    }

    console.log("Capturing screenshot for display:", targetDisplay);
    return screenshot({
      format: "png",
      screen: targetDisplay.id,
    } as any);
  }

  private getVirtualDisplayBounds() {
    const displays = screen.getAllDisplays();

    if (displays.length === 0) {
      return {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      };
    }

    const minX = Math.min(...displays.map((display) => display.bounds.x));
    const minY = Math.min(...displays.map((display) => display.bounds.y));
    const maxRight = Math.max(
      ...displays.map((display) => display.bounds.x + display.bounds.width)
    );
    const maxBottom = Math.max(
      ...displays.map((display) => display.bounds.y + display.bounds.height)
    );

    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxRight - minX),
      height: Math.max(1, maxBottom - minY),
    };
  }

  private cropScreenshotBuffer(
    screenshotBuffer: Buffer,
    selection: ScreenRegionSelection
  ): Buffer {
    const image = nativeImage.createFromBuffer(screenshotBuffer);
    const size = image.getSize();
    const sourceBounds =
      process.platform === "win32"
        ? this.getVirtualDisplayBounds()
        : {
            x: 0,
            y: 0,
            width: selection.displayBounds.width,
            height: selection.displayBounds.height,
          };
    const regionX =
      process.platform === "win32"
        ? selection.displayOrigin.x + selection.region.x - sourceBounds.x
        : selection.region.x;
    const regionY =
      process.platform === "win32"
        ? selection.displayOrigin.y + selection.region.y - sourceBounds.y
        : selection.region.y;

    const scaleX = size.width / Math.max(sourceBounds.width, 1);
    const scaleY = size.height / Math.max(sourceBounds.height, 1);

    const cropX = Math.max(
      0,
      Math.min(size.width - 1, Math.round(regionX * scaleX))
    );
    const cropY = Math.max(
      0,
      Math.min(size.height - 1, Math.round(regionY * scaleY))
    );
    const cropWidth = Math.max(
      1,
      Math.min(
        size.width - cropX,
        Math.round(selection.region.width * scaleX)
      )
    );
    const cropHeight = Math.max(
      1,
      Math.min(
        size.height - cropY,
        Math.round(selection.region.height * scaleY)
      )
    );

    return image
      .crop({
        x: cropX,
        y: cropY,
        width: cropWidth,
        height: cropHeight,
      })
      .toPNG();
  }

  private async storeScreenshotBuffer(screenshotBuffer: Buffer): Promise<string> {
    let screenshotPath = "";

    if (this.view === "queue") {
      screenshotPath = path.join(this.screenshotDir, `${uuidv4()}.png`);
      const screenshotDir = path.dirname(screenshotPath);
      if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
      }
      await fs.promises.writeFile(screenshotPath, screenshotBuffer);
      console.log("Adding screenshot to main queue:", screenshotPath);
      this.screenshotQueue.push(screenshotPath);
      if (this.screenshotQueue.length > this.MAX_SCREENSHOTS) {
        const removedPath = this.screenshotQueue.shift();
        if (removedPath) {
          try {
            await fs.promises.unlink(removedPath);
            console.log(
              "Removed old screenshot from main queue:",
              removedPath
            );
          } catch (error) {
            console.error("Error removing old screenshot:", error);
          }
        }
      }
      return screenshotPath;
    }

    screenshotPath = path.join(this.extraScreenshotDir, `${uuidv4()}.png`);
    const screenshotDir = path.dirname(screenshotPath);
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    await fs.promises.writeFile(screenshotPath, screenshotBuffer);
    console.log("Adding screenshot to extra queue:", screenshotPath);
    this.extraScreenshotQueue.push(screenshotPath);
    if (this.extraScreenshotQueue.length > this.MAX_SCREENSHOTS) {
      const removedPath = this.extraScreenshotQueue.shift();
      if (removedPath) {
        try {
          await fs.promises.unlink(removedPath);
          console.log(
            "Removed old screenshot from extra queue:",
            removedPath
          );
        } catch (error) {
          console.error("Error removing old screenshot:", error);
        }
      }
    }

    return screenshotPath;
  }

  private async captureScreenshot(
    onCaptureStarted?: () => void
  ): Promise<Buffer> {
    try {
      console.log("Starting screenshot capture...");

      // For Windows, try multiple methods
      if (process.platform === "win32") {
        return await this.captureWindowsScreenshot(onCaptureStarted);
      }

      // For macOS and Linux, use buffer directly
      console.log("Taking screenshot on non-Windows platform");
      onCaptureStarted?.();
      const buffer = await screenshot({ format: "png" });
      console.log(
        `Screenshot captured successfully, size: ${buffer.length} bytes`
      );
      return buffer;
    } catch (error) {
      console.error("Error capturing screenshot:", error);
      throw new Error(`Failed to capture screenshot: ${error.message}`);
    }
  }

  /**
   * Windows-specific screenshot capture with multiple fallback mechanisms
   */
  private async captureWindowsScreenshot(
    onCaptureStarted?: () => void
  ): Promise<Buffer> {
    console.log("Attempting Windows screenshot with multiple methods");

    // Method 1: PowerShell capture is the most reliable in the bundled app.
    try {
      console.log("Attempting Windows screenshot with PowerShell (Method 1)");
      const tempFile = path.join(this.tempDir, `temp-${uuidv4()}.png`);
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms,System.Drawing
        $screens = [System.Windows.Forms.Screen]::AllScreens
        $top = ($screens | ForEach-Object {$_.Bounds.Top} | Measure-Object -Minimum).Minimum
        $left = ($screens | ForEach-Object {$_.Bounds.Left} | Measure-Object -Minimum).Minimum
        $width = ($screens | ForEach-Object {$_.Bounds.Right} | Measure-Object -Maximum).Maximum
        $height = ($screens | ForEach-Object {$_.Bounds.Bottom} | Measure-Object -Maximum).Maximum
        $bounds = [System.Drawing.Rectangle]::FromLTRB($left, $top, $width, $height)
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bmp)
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
        $bmp.Save('${tempFile.replace(
          /\\/g,
          "\\\\"
        )}', [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bmp.Dispose()
        `;

      const capturePromise = execFileAsync("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        psScript,
      ]);
      onCaptureStarted?.();
      await capturePromise;

      if (fs.existsSync(tempFile)) {
        const buffer = await fs.promises.readFile(tempFile);
        console.log(
          `Method 1 successful, screenshot size: ${buffer.length} bytes`
        );

        try {
          await fs.promises.unlink(tempFile);
        } catch (cleanupErr) {
          console.warn("Failed to clean up PowerShell temp file:", cleanupErr);
        }

        return buffer;
      }

      throw new Error("PowerShell screenshot file not created");
    } catch (psError) {
      console.warn("Windows screenshot Method 1 failed:", psError);

      // Method 2: Try screenshot-desktop when available in non-bundled environments.
      try {
        const tempFile = path.join(this.tempDir, `sd-temp-${uuidv4()}.png`);
        console.log(
          `Attempting screenshot-desktop capture (Method 2): ${tempFile}`
        );

        const capturePromise = screenshot({ filename: tempFile });
        onCaptureStarted?.();
        await capturePromise;

        if (fs.existsSync(tempFile)) {
          const buffer = await fs.promises.readFile(tempFile);
          console.log(
            `Method 2 successful, screenshot size: ${buffer.length} bytes`
          );

          try {
            await fs.promises.unlink(tempFile);
          } catch (cleanupErr) {
            console.warn("Failed to clean up temp file:", cleanupErr);
          }

          return buffer;
        }

        throw new Error("Screenshot file not created");
      } catch (error) {
        console.warn("Windows screenshot Method 2 failed:", error);
        throw new Error(
          "Could not capture screenshot with any method. Please check your Windows security settings and try again."
        );
      }
    }
  }

  public async takeScreenshot(
    hideMainWindow: () => void,
    showMainWindow: () => void
  ): Promise<string> {
    console.log("Taking screenshot in view:", this.view);
    hideMainWindow();

    await new Promise((resolve) => setTimeout(resolve, this.getHideDelay()));

    let restoreScheduled = false;
    const scheduleRestore = (delay: number) => {
      if (restoreScheduled) {
        return;
      }

      restoreScheduled = true;
      setTimeout(() => {
        showMainWindow();
      }, delay);
    };

    let screenshotBuffer: Buffer | null = null;
    try {
      screenshotBuffer = await this.captureScreenshot(() => {
        scheduleRestore(this.getEarlyRestoreDelay());
      });

      if (!screenshotBuffer || screenshotBuffer.length === 0) {
        throw new Error("Screenshot capture returned empty buffer");
      }
    } catch (error) {
      console.error("Screenshot error:", error);
      throw error;
    } finally {
      scheduleRestore(this.getRestoreDelay());
    }

    if (!screenshotBuffer || screenshotBuffer.length === 0) {
      throw new Error("Screenshot capture returned empty buffer");
    }

    return this.storeScreenshotBuffer(screenshotBuffer);
  }

  public async takeRegionScreenshot(
    selection: ScreenRegionSelection,
    showMainWindow: () => void
  ): Promise<string> {
    let screenshotBuffer: Buffer | null = null;

    try {
      const displayBuffer = await this.captureDisplayScreenshot(
        selection.captureDisplayIndex
      );
      screenshotBuffer = this.cropScreenshotBuffer(displayBuffer, selection);

      if (!screenshotBuffer || screenshotBuffer.length === 0) {
        throw new Error("Region screenshot capture returned empty buffer");
      }
    } catch (error) {
      console.error("Region screenshot error:", error);
      throw error;
    } finally {
      await new Promise((resolve) => setTimeout(resolve, this.getRestoreDelay()));
      showMainWindow();
    }

    if (!screenshotBuffer || screenshotBuffer.length === 0) {
      throw new Error("Region screenshot capture returned empty buffer");
    }

    return this.storeScreenshotBuffer(screenshotBuffer);
  }

  public async captureEphemeralScreenshot(
    hideMainWindow: () => void,
    showMainWindow: () => void
  ): Promise<{ data: string; preview: string }> {
    hideMainWindow();

    await new Promise((resolve) => setTimeout(resolve, this.getHideDelay()));

    let restoreScheduled = false;
    const scheduleRestore = (delay: number) => {
      if (restoreScheduled) {
        return;
      }

      restoreScheduled = true;
      setTimeout(() => {
        showMainWindow();
      }, delay);
    };

    let screenshotBuffer: Buffer | null = null;
    try {
      screenshotBuffer = await this.captureScreenshot(() => {
        scheduleRestore(this.getEarlyRestoreDelay());
      });

      if (!screenshotBuffer || screenshotBuffer.length === 0) {
        throw new Error("Screenshot capture returned empty buffer");
      }
    } finally {
      scheduleRestore(this.getRestoreDelay());
    }

    if (!screenshotBuffer || screenshotBuffer.length === 0) {
      throw new Error("Screenshot capture returned empty buffer");
    }

    const base64 = screenshotBuffer.toString("base64");
    return {
      data: base64,
      preview: `data:image/png;base64,${base64}`,
    };
  }

  public async getImagePreview(filepath: string): Promise<string> {
    try {
      if (!fs.existsSync(filepath)) {
        console.error(`Image file not found: ${filepath}`);
        return "";
      }

      const data = await fs.promises.readFile(filepath);
      return `data:image/png;base64,${data.toString("base64")}`;
    } catch (error) {
      console.error("Error reading image:", error);
      return "";
    }
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      if (fs.existsSync(path)) {
        await fs.promises.unlink(path);
      }

      this.screenshotQueue = this.screenshotQueue.filter(
        (filePath) => filePath !== path
      );
      this.extraScreenshotQueue = this.extraScreenshotQueue.filter(
        (filePath) => filePath !== path
      );
      return { success: true };
    } catch (error) {
      console.error("Error deleting file:", error);
      return { success: false, error: error.message };
    }
  }

  public clearExtraScreenshotQueue(): void {
    // Clear extraScreenshotQueue
    this.extraScreenshotQueue.forEach((screenshotPath) => {
      if (fs.existsSync(screenshotPath)) {
        fs.unlink(screenshotPath, (err) => {
          if (err)
            console.error(
              `Error deleting extra screenshot at ${screenshotPath}:`,
              err
            );
        });
      }
    });
    this.extraScreenshotQueue = [];
  }
}
