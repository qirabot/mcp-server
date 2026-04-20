/**
 * HTTP client for the server-lite API.
 */

import { Agent } from "undici";

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
  name?: string;
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

export class QiraClient {
  private baseURL: string;
  private apiKey: string;

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
