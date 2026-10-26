import type { Observation } from "../domain.js";
import { Adapter } from "./adapter.js";

/**
 * DesktopCaptureAdapter — optional Screenpipe-style or OS accessibility capture.
 *
 * Stub: no hard dependency on any commercial capture product in the core. A
 * real implementation reads OS accessibility events / OCR and returns
 * `Observation` records. Until wired, it reports itself as unsupported so the
 * host stays quiet instead of fabricating desktop evidence.
 */
export class DesktopCaptureAdapter extends Adapter {
  readonly id = "desktop";

  supports(): boolean {
    return false;
  }

  async capture(): Promise<Observation[]> {
    return [];
  }

  readiness() {
    return { ...super.readiness(), state: "unsupported" as const };
  }

  status(): string {
    return "desktop: not wired (optional adapter)";
  }
}
