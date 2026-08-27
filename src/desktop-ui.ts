export type ServerMode = "starting" | "tailscale" | "background" | "bundled" | "disconnected" | "error";

export type ConnectionStatus = {
  label: string;
  title: string;
  tone: "active" | "pending" | "inactive" | "error";
};

export function shouldUseSameViewLink(options: { nativeBridge: boolean; mobileViewport: boolean }): boolean {
  return !options.nativeBridge && options.mobileViewport;
}

export function connectionStatus(options: {
  platform: "macos" | "ios";
  serverMode: ServerMode;
  dashboardReady: boolean;
  dashboardError: boolean;
}): ConnectionStatus {
  if (options.serverMode === "error" || options.dashboardError) {
    return { label: "Connection issue", title: "LiveTree cannot reach the active server", tone: "error" };
  }

  if (options.platform === "ios") {
    if (options.dashboardReady || options.serverMode === "tailscale") {
      return { label: "Tailscale server", title: "Connected to a LiveTree server over Tailscale", tone: "active" };
    }
    if (options.serverMode === "starting") {
      return { label: "Connecting", title: "Connecting to the saved Tailscale server", tone: "pending" };
    }
    return { label: "No server", title: "Not connected to a LiveTree server", tone: "inactive" };
  }

  switch (options.serverMode) {
    case "background":
      return { label: "Background server", title: "Using the LiveTree server already running on this Mac", tone: "active" };
    case "bundled":
      return { label: "Bundled server", title: "Using the server bundled with this desktop app", tone: "active" };
    case "starting":
      return { label: "Starting server", title: "Starting the server bundled with this desktop app", tone: "pending" };
    case "tailscale":
      return { label: "Tailscale server", title: "Connected to a LiveTree server over Tailscale", tone: "active" };
    default:
      return { label: "Server offline", title: "No LiveTree server is connected", tone: "inactive" };
  }
}

type WheelSample = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  timeStamp: number;
};

export function createPaneBackSwipeRecognizer(options: { threshold?: number; idleMs?: number } = {}) {
  const threshold = options.threshold ?? 72;
  const idleMs = options.idleMs ?? 180;
  let distance = 0;
  let lastTime = Number.NEGATIVE_INFINITY;
  let activated = false;

  return {
    update(sample: WheelSample): boolean {
      if (sample.timeStamp - lastTime > idleMs) {
        distance = 0;
        activated = false;
      }
      lastTime = sample.timeStamp;

      // Trackpads report pixel deltas. Requiring a horizontally dominant pixel
      // gesture avoids treating mouse wheels and ordinary vertical scrolling as back.
      if (sample.deltaMode !== 0 || Math.abs(sample.deltaX) <= Math.abs(sample.deltaY) * 1.2) {
        distance = 0;
        return false;
      }
      if (activated) return false;

      // WebKit's back direction is a negative horizontal wheel delta (content
      // follows a two-finger swipe toward the right).
      if (sample.deltaX >= 0) {
        distance = 0;
        return false;
      }

      distance += -sample.deltaX;
      if (distance < threshold) return false;
      activated = true;
      return true;
    },
    reset(): void {
      distance = 0;
      lastTime = Number.NEGATIVE_INFINITY;
      activated = false;
    },
  };
}
