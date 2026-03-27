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
  executionId: string;
  message: string;
}

export interface ExecutionSummary {
  id: string;
  status: string;
  currentStep: number;
  executionSource: string;
  errorMessage?: string;
  deviceId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExecutionStep {
  id: number;
  executionId: string;
  stepNumber: number;
  actionType: string;
  status: string;
  decision?: string;
  actionParams?: string;
  actionOutput?: string;
  screenshotPath?: string;
  model?: string;
  createdAt: string;
  executionTime?: number;
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
  executionId?: string;
  [key: string]: unknown;
}

export interface StepCompletePayload {
  executionId: string;
  stepNumber: number;
  actionType: string;
  actionParams?: string;
  status: string;
  decision?: string;
  error?: string;
  executionTime?: number;
  llmDecisionTime?: number;
  coordinateParseTime?: number;
  model?: string;
}

export interface ExecutionEndPayload {
  executionId: string;
  status: string;
  error?: string;
}

export interface WatchResult {
  execution: ExecutionSummary;
  steps: ExecutionStep[];
  timedOut: boolean;
}

export type StepCallback = (step: StepCompletePayload) => void;

export class QiraClient {
  private baseURL: string;
  private apiKey: string;
  private ws: WebSocket | null = null;
  private wsReady: Promise<void> | null = null;
  private executionListeners = new Map<
    string,
    {
      onStep: (payload: StepCompletePayload) => void;
      onEnd: (payload: ExecutionEndPayload) => void;
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
    return `${base}/api/v1/executions/ws`;
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
    const execId = msg.executionId as string | undefined;
    if (!execId) return;

    const listener = this.executionListeners.get(execId);
    if (!listener) return;

    switch (msg.type) {
      case "step_complete":
        listener.onStep(msg as unknown as StepCompletePayload);
        break;
      case "execution_complete":
      case "execution_failed":
      case "execution_cancelled":
        listener.onEnd(msg as unknown as ExecutionEndPayload);
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
   * Watch an execution via WebSocket, receiving real-time step updates.
   * Falls back to HTTP polling if WebSocket is unavailable.
   */
  async watchExecution(
    executionId: string,
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
      return this.pollUntilDone(executionId, 3000, timeoutMs, signal);
    }

    return new Promise<WatchResult>((resolve, reject) => {
      const steps: ExecutionStep[] = [];
      let settled = false;

      const cleanup = () => {
        this.executionListeners.delete(executionId);
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
          const exec = await this.getExecution(executionId).catch(() => ({
            id: executionId,
            status: "running",
            currentStep: steps.length,
            executionSource: "mcp",
            createdAt: "",
          }));
          resolve({ execution: exec, steps, timedOut: true });
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

      // Register execution listener
      this.executionListeners.set(executionId, {
        onStep: (payload) => {
          const step: ExecutionStep = {
            id: 0,
            executionId: payload.executionId,
            stepNumber: payload.stepNumber,
            actionType: payload.actionType,
            status: payload.status,
            decision: payload.decision,
            actionParams: payload.actionParams,
            createdAt: "",
            executionTime: payload.executionTime,
            llmDecisionTime: payload.llmDecisionTime,
            coordinateParseTime: payload.coordinateParseTime,
          };
          steps.push(step);
          onStep?.(payload);
        },
        onEnd: async (payload) => {
          settle(async () => {
            const exec = await this.getExecution(executionId).catch(() => ({
              id: executionId,
              status: payload.status,
              currentStep: steps.length,
              executionSource: "mcp",
              errorMessage: payload.error,
              createdAt: "",
            }));
            resolve({ execution: exec, steps, timedOut: false });
          });
        },
      });

      // Also check if already completed (race condition: task finished before listener registered)
      this.getExecution(executionId).then((exec) => {
        if (
          exec.status !== "pending" &&
          exec.status !== "running"
        ) {
          this.getExecutionSteps(executionId)
            .catch(() => [] as ExecutionStep[])
            .then((fetchedSteps) => {
              settle(() =>
                resolve({
                  execution: exec,
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
    return this.request<RunTaskResponse>("POST", "/api/v1/task/run", body);
  }

  async getExecution(executionId: string): Promise<ExecutionSummary> {
    return this.request<ExecutionSummary>(
      "GET",
      `/api/v1/executions/${executionId}`
    );
  }

  async getExecutionSteps(executionId: string): Promise<ExecutionStep[]> {
    return this.request<ExecutionStep[]>(
      "GET",
      `/api/v1/executions/${executionId}/steps`
    );
  }

  async pollUntilDone(
    executionId: string,
    intervalMs = 3000,
    timeoutMs = 90_000,
    signal?: AbortSignal
  ): Promise<WatchResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const exec = await this.getExecution(executionId);
      if (exec.status !== "pending" && exec.status !== "running") {
        const steps = await this.getExecutionSteps(executionId).catch(
          () => [] as ExecutionStep[]
        );
        return { execution: exec, steps, timedOut: false };
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
    const exec = await this.getExecution(executionId);
    const steps = await this.getExecutionSteps(executionId).catch(
      () => [] as ExecutionStep[]
    );
    return { execution: exec, steps, timedOut: true };
  }

  async cancelExecution(executionId: string): Promise<void> {
    await this.request<void>(
      "POST",
      `/api/v1/executions/${executionId}/cancel`
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
