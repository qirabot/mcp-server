/**
 * HTTP + WebSocket client for the server-lite API.
 */

import { Agent } from "undici";
import WebSocket from "ws";

const keepAliveDispatcher = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

export interface DeviceInfo {
  id: string;
  name: string;
  os: string;
  osVersion: string;
  deviceType: string;
  width: number;
  height: number;
  isActive: boolean;
  hostname: string;
  ipAddress: string;
  source?: string;
}

export interface SessionResponse {
  id: string;
  deviceId: string;
  status: string;
}

export interface TaskAction {
  type: string;
  params?: Record<string, unknown>;
}

export interface RunTaskResponse {
  taskId: string;
  message: string;
}

export interface TaskSummary {
  id: string;
  status: string;
  currentStep: number;
  source: string;
  errorMessage?: string;
  deviceId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface TaskStep {
  id: number;
  taskId: string;
  stepNumber: number;
  actionType: string;
  status: string;
  decision?: string;
  actionParams?: string;
  actionOutput?: string;
  screenshotPath?: string;
  model?: string;
  createdAt: string;
  actionDurationTime?: number;
  stepDuration?: number;
  llmDecisionTime?: number;
  coordinateParseTime?: number;
}

export interface ModelAlias {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  model: string;
  isActive: boolean;
  isSystem: boolean;
}

// --- WebSocket message types ---

interface WSMessage {
  type: string;
  taskId?: string;
  [key: string]: unknown;
}

export interface StepCompletePayload {
  taskId: string;
  stepNumber: number;
  actionType: string;
  actionParams?: string;
  status: string;
  decision?: string;
  error?: string;
  actionDurationTime?: number;
  stepDuration?: number;
  llmDecisionTime?: number;
  coordinateParseTime?: number;
  model?: string;
}

export interface TaskEndPayload {
  taskId: string;
  status: string;
  error?: string;
}

export interface WatchResult {
  task: TaskSummary;
  steps: TaskStep[];
  timedOut: boolean;
}

export type StepCallback = (step: StepCompletePayload) => void;

export class QiraClient {
  private baseURL: string;
  private apiKey: string;
  private ws: WebSocket | null = null;
  private wsReady: Promise<void> | null = null;
  private taskListeners = new Map<
    string,
    {
      onStep: (payload: StepCompletePayload) => void;
      onEnd: (payload: TaskEndPayload) => void;
    }
  >();

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  // --- HTTP helpers ---

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = this.baseURL + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      dispatcher: keepAliveDispatcher,
    } as RequestInit);

    if (!resp.ok) {
      let msg = await resp.text();
      try {
        const err = JSON.parse(msg) as { message?: string; code?: string };
        if (err.message) {
          msg = `${err.message} (${err.code ?? resp.status})`;
        }
      } catch {
        // use raw text
      }
      throw new Error(`API error ${resp.status}: ${msg}`);
    }

    const text = await resp.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async requestRaw(
    method: string,
    path: string
  ): Promise<{ data: Buffer; contentType: string }> {
    const url = this.baseURL + path;
    const resp = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}` },
      dispatcher: keepAliveDispatcher,
    } as RequestInit);

    if (!resp.ok) {
      const msg = await resp.text();
      throw new Error(`API error ${resp.status}: ${msg}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    // Detect content type from magic bytes
    let contentType = "image/png";
    if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) {
      contentType = "image/jpeg";
    } else if (data.length > 4 && data.subarray(0, 4).toString() === "RIFF") {
      contentType = "image/webp";
    }

    return { data, contentType };
  }

  // --- WebSocket ---

  private wsURL(): string {
    const base = this.baseURL.replace(/^http/, "ws");
    return `${base}/api/v1/tasks/ws`;
  }

  connectWebSocket(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.wsReady) {
      return this.wsReady;
    }

    this.wsReady = new Promise<void>((resolve, reject) => {
      const url = this.wsURL();
      const ws = new WebSocket(url, [`bearer.${this.apiKey}`]);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("WebSocket connection timeout"));
      }, 10_000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.wsReady = null;
        console.error("[qira-mcp-server] websocket connected");
        resolve();
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as WSMessage;
          this.handleWSMessage(msg);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", () => {
        this.ws = null;
        this.wsReady = null;
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        this.ws = null;
        this.wsReady = null;
        reject(err);
      });
    });

    return this.wsReady;
  }

  private handleWSMessage(msg: WSMessage): void {
    const taskId = msg.taskId as string | undefined;
    if (!taskId) return;

    const listener = this.taskListeners.get(taskId);
    if (!listener) return;

    switch (msg.type) {
      case "step_complete":
        listener.onStep(msg as unknown as StepCompletePayload);
        break;
      case "task_complete":
      case "task_failed":
      case "task_cancelled":
      case "task_timeout":
        listener.onEnd(msg as unknown as TaskEndPayload);
        break;
    }
  }

  closeWebSocket(): void {
    if (this.ws) {
      this.ws.close(1000, "normal");
      this.ws = null;
    }
  }

  /**
   * Watch a task via WebSocket, receiving real-time step updates.
   * Falls back to HTTP polling if WebSocket is unavailable.
   */
  async watchTask(
    taskId: string,
    timeoutMs = 90_000,
    signal?: AbortSignal,
    onStep?: StepCallback
  ): Promise<WatchResult> {
    // Try WebSocket first
    try {
      await this.connectWebSocket();
    } catch {
      console.error(
        "[qira-mcp-server] websocket unavailable, falling back to polling"
      );
      return this.pollUntilDone(taskId, 3000, timeoutMs, signal);
    }

    return new Promise<WatchResult>((resolve, reject) => {
      const steps: TaskStep[] = [];
      let settled = false;

      const cleanup = () => {
        this.taskListeners.delete(taskId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      // Timeout
      const timer = setTimeout(async () => {
        settle(async () => {
          const exec = await this.getTask(taskId).catch(() => ({
            id: taskId,
            status: "running",
            currentStep: steps.length,
            source: "mcp",
            createdAt: "",
          }));
          resolve({ task: exec, steps, timedOut: true });
        });
      }, timeoutMs);

      // Abort signal
      const onAbort = () => {
        settle(() => reject(new Error("aborted")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) {
        settle(() => reject(new Error("aborted")));
        return;
      }

      // Register task listener
      this.taskListeners.set(taskId, {
        onStep: (payload) => {
          const step: TaskStep = {
            id: 0,
            taskId: payload.taskId,
            stepNumber: payload.stepNumber,
            actionType: payload.actionType,
            status: payload.status,
            decision: payload.decision,
            actionParams: payload.actionParams,
            createdAt: "",
            actionDurationTime: payload.actionDurationTime,
            llmDecisionTime: payload.llmDecisionTime,
            coordinateParseTime: payload.coordinateParseTime,
          };
          steps.push(step);
          onStep?.(payload);
        },
        onEnd: async (payload) => {
          settle(async () => {
            const exec = await this.getTask(taskId).catch(() => ({
              id: taskId,
              status: payload.status,
              currentStep: steps.length,
              source: "mcp",
              errorMessage: payload.error,
              createdAt: "",
            }));
            resolve({ task: exec, steps, timedOut: false });
          });
        },
      });

      // Also check if already completed (race condition: task finished before listener registered)
      this.getTask(taskId).then((exec) => {
        if (
          exec.status !== "pending" &&
          exec.status !== "running"
        ) {
          this.getTaskSteps(taskId)
            .catch(() => [] as TaskStep[])
            .then((fetchedSteps) => {
              settle(() =>
                resolve({
                  task: exec,
                  steps: fetchedSteps,
                  timedOut: false,
                })
              );
            });
        }
      });
    });
  }

  // --- REST API methods ---

  async listActiveDevices(): Promise<DeviceInfo[]> {
    return this.request<DeviceInfo[]>("GET", "/api/v1/devices/active");
  }

  async getDevice(deviceId: string): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("GET", `/api/v1/devices/${deviceId}`);
  }

  async takeDeviceScreenshot(
    deviceId: string
  ): Promise<{ data: Buffer; contentType: string }> {
    return this.requestRaw("GET", `/api/v1/devices/${deviceId}/screenshot`);
  }

  async createSession(deviceId: string): Promise<SessionResponse> {
    return this.request<SessionResponse>("POST", "/api/v1/sessions", {
      deviceId,
      source: "mcp",
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/v1/sessions/${sessionId}`);
  }

  async runTask(
    deviceId: string,
    sessionId: string,
    actions: TaskAction[],
    modelAlias?: string
  ): Promise<RunTaskResponse> {
    const body: Record<string, unknown> = { deviceId, sessionId, actions };
    if (modelAlias) {
      body.modelAlias = modelAlias;
    }
    return this.request<RunTaskResponse>("POST", "/api/v1/tasks/run", body);
  }

  async getTask(taskId: string): Promise<TaskSummary> {
    return this.request<TaskSummary>(
      "GET",
      `/api/v1/tasks/${taskId}`
    );
  }

  async getTaskSteps(taskId: string): Promise<TaskStep[]> {
    return this.request<TaskStep[]>(
      "GET",
      `/api/v1/tasks/${taskId}/steps`
    );
  }

  async pollUntilDone(
    taskId: string,
    intervalMs = 3000,
    timeoutMs = 90_000,
    signal?: AbortSignal
  ): Promise<WatchResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const exec = await this.getTask(taskId);
      if (exec.status !== "pending" && exec.status !== "running") {
        const steps = await this.getTaskSteps(taskId).catch(
          () => [] as TaskStep[]
        );
        return { task: exec, steps, timedOut: false };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, intervalMs);

        function onAbort() {
          clearTimeout(timer);
          cleanup();
          reject(new Error("aborted"));
        }

        function cleanup() {
          signal?.removeEventListener("abort", onAbort);
        }

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    const exec = await this.getTask(taskId);
    const steps = await this.getTaskSteps(taskId).catch(
      () => [] as TaskStep[]
    );
    return { task: exec, steps, timedOut: true };
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.request<void>(
      "POST",
      `/api/v1/tasks/${taskId}/cancel`
    );
  }

  async listModelAliases(): Promise<ModelAlias[]> {
    const resp = await this.request<{ aliases: ModelAlias[] }>(
      "GET",
      "/api/v1/model-aliases"
    );
    return resp.aliases.filter((a) => a.isActive);
  }
}
