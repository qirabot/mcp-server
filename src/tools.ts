import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QiraClient } from "./client.js";

export function registerTools(server: McpServer, client: QiraClient): void {
  registerListDevices(server, client);
  registerListModelAliases(server, client);
  registerTakeScreenshot(server, client);
  registerListApps(server, client);
  registerOpenApp(server, client);
  registerCloseApp(server, client);
  registerRunTask(server, client);
  registerGetTask(server, client);

  registerCancelTask(server, client);
}

// --- list_devices ---

function registerListDevices(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "list_devices",
    {
      description:
        "List all active devices connected to the server. Returns device ID, name, OS, type, screen resolution and host info. " +
        "Call this first to get the device_id required by take_screenshot, run_task, and other device tools.",
    },
    async () => {
      const devices = await client.listActiveDevices();
      if (devices.length === 0) {
        return {
          content: [{ type: "text", text: "No active devices found." }],
        };
      }

      const lines = [`Found ${devices.length} active device(s):\n`];
      for (const d of devices) {
        lines.push(`- **${d.name}** (ID: \`${d.id}\`)`);
        lines.push(
          `  OS: ${d.os} ${d.osVersion} | Type: ${d.deviceType} | Resolution: ${d.width}x${d.height}`
        );
        lines.push(`  Host: ${d.hostname} (${d.ipAddress})`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// --- list_model_aliases ---

function registerListModelAliases(
  server: McpServer,
  client: QiraClient
): void {
  server.registerTool(
    "list_model_aliases",
    {
      description:
        "List available model aliases (e.g. 'balanced', 'high_quality'). Use the alias name as the model_alias parameter in run_task.",
    },
    async () => {
      const aliases = await client.listModelAliases();
      if (aliases.length === 0) {
        return {
          content: [{ type: "text", text: "No model aliases configured." }],
        };
      }

      const lines = [`Available model aliases (${aliases.length}):\n`];
      for (const a of aliases) {
        let line = `- **${a.name}**`;
        if (a.displayName) line += ` (${a.displayName})`;
        line += ` — provider: ${a.provider}, model: ${a.model}`;
        lines.push(line);
        if (a.description) lines.push(`  ${a.description}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// --- take_screenshot ---

function registerTakeScreenshot(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "take_screenshot",
    {
      description:
        "Capture a live screenshot of the device's current screen. Returns the image directly (synchronous, up to 30s).\n\n" +
        "Use this tool when:\n" +
        "- You need to see what is currently displayed on the device screen.\n" +
        "- You want to verify the result after a run_task completes.\n" +
        "- You need to inspect the UI before deciding what action to take.\n\n" +
        "This returns the real-time screen.",
      inputSchema: {
        device_id: z
          .string()
          .describe("The device ID to capture a screenshot from"),
      },
    },
    async ({ device_id }) => {
      const img = await client.takeDeviceScreenshot(device_id);
      return {
        content: [
          {
            type: "image" as const,
            data: img.data.toString("base64"),
            mimeType: img.contentType,
          },
        ],
      };
    }
  );
}

// --- list_apps ---

function registerListApps(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "list_apps",
    {
      description:
        "List installed applications on a device. Returns app names and paths/bundle IDs.\n\n" +
        "Supported platforms: Desktop (macOS/Windows), iOS, Android.\n" +
        "Not supported on Chrome or Sandbox devices.",
      inputSchema: {
        device_id: z.string().describe("The device ID to list apps from"),
      },
    },
    async ({ device_id }) => {
      const apps = await client.listApps(device_id);
      if (apps.length === 0) {
        return {
          content: [{ type: "text", text: "No applications found." }],
        };
      }

      const lines = [`Found ${apps.length} application(s):\n`];
      for (const app of apps) {
        lines.push(`- **${app.name}** — ${app.path}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// --- open_app ---

function registerOpenApp(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "open_app",
    {
      description:
        "Open/launch an application on a device. Use list_apps first to find available app names.\n\n" +
        "Supported platforms: Desktop (macOS/Windows), iOS, Android.\n" +
        "On iOS/Android, use the bundle ID or package name as the app name.",
      inputSchema: {
        device_id: z.string().describe("The device ID to open the app on"),
        app_name: z
          .string()
          .describe(
            "Application name, path, bundle ID (iOS), or package name (Android)"
          ),
      },
    },
    async ({ device_id, app_name }) => {
      await client.openApp(device_id, app_name);
      return {
        content: [
          { type: "text", text: `Application '${app_name}' opened successfully.` },
        ],
      };
    }
  );
}

// --- close_app ---

function registerCloseApp(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "close_app",
    {
      description:
        "Close/stop a running application on a device.\n\n" +
        "Supported platforms: Desktop (macOS/Windows), iOS, Android.\n" +
        "On iOS/Android, use the bundle ID or package name as the app name.",
      inputSchema: {
        device_id: z.string().describe("The device ID to close the app on"),
        app_name: z
          .string()
          .describe(
            "Application name, bundle ID (iOS), or package name (Android)"
          ),
      },
    },
    async ({ device_id, app_name }) => {
      await client.closeApp(device_id, app_name);
      return {
        content: [
          { type: "text", text: `Application '${app_name}' closed successfully.` },
        ],
      };
    }
  );
}

// --- run_task ---

function registerRunTask(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "run_task",
    {
      description:
        "Perform UI automation on a device. This tool can automate ANY task a human can do on a device screen — " +
        "if a human can see it and interact with it, this tool can do it. " +
        "The underlying agent automatically analyzes screen content and decides action steps.\n\n" +
        "Use this tool when the user asks to perform ANY action on a device, including but not limited to:\n" +
        "- App interactions: opening apps, tapping, swiping, typing, navigating\n" +
        "- Content engagement: liking, commenting, sharing, following, subscribing\n" +
        "- Information gathering: reading screen content, searching, extracting data\n" +
        "- Web browsing: visiting URLs, filling forms, clicking links\n" +
        "- Messaging: sending messages, replying, forwarding\n\n" +
        "Do NOT use this tool when:\n" +
        "- You only need a screenshot — use take_screenshot instead.\n\n" +
        "Provide only the end goal in instruction (e.g., 'open WeChat and send a message to Zhang San'), not low-level steps.\n" +
        "After completion, call take_screenshot to verify the result.",
      inputSchema: {
        device_id: z
          .string()
          .describe("The device ID to execute the task on"),
        instruction: z
          .string()
          .describe(
            "Target description — describe only the end goal (e.g. 'open WeChat and send a message to Zhang San'), not specific operation steps."
          ),
        model_alias: z
          .string()
          .optional()
          .describe(
            "Model alias to use (e.g. 'balanced'). Use list_model_aliases to see available options."
          ),
        max_steps: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum number of AI decision steps (default: 30). Increase for complex multi-step tasks."
          ),
      },
    },
    async ({ device_id, instruction, model_alias, max_steps }) => {
      const sess = await client.createSession(device_id);

      const params: Record<string, unknown> = { instruction };
      if (max_steps !== undefined) {
        params.maxSteps = max_steps;
      }

      let resp;
      try {
        resp = await client.runTask(
          device_id,
          sess.id,
          [{ type: "ai_decision", params }],
          model_alias
        );
      } catch (err) {
        await client.closeSession(sess.id).catch(() => {});
        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text: `Task started successfully.\n- Task ID: \`${resp.executionId}\`\n\nUse \`get_task\` to poll for status and results.`,
          },
        ],
      };
    }
  );
}

// --- get_task ---

function registerGetTask(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "get_task",
    {
      description:
        "Get the status and step details of a task started by run_task.\n\n" +
        "Returns current status and all completed steps with action type, AI decision, params, and output.\n" +
        "Possible status values: pending, running, succeeded, failed, cancelled, timeout, partially_succeeded.\n" +
        "If status is 'pending' or 'running', poll again (recommended interval: 2-3 seconds).\n\n" +
        "Screenshots are not included in the response — use take_screenshot after completion to verify the result.",
      inputSchema: {
        task_id: z.string().describe("The task ID returned by run_task"),
      },
    },
    async ({ task_id }) => {
      const exec = await client.getExecution(task_id);

      const lines: string[] = [];
      lines.push(`Task \`${exec.id}\`:`);
      lines.push(`- Status: **${exec.status}**`);
      lines.push(`- Current Step: ${exec.currentStep}`);
      if (exec.errorMessage) {
        lines.push(`- Error: ${exec.errorMessage}`);
      }

      try {
        const steps = await client.getExecutionSteps(task_id);
        if (steps.length > 0) {
          lines.push("", `### Steps (${steps.length})`, "");
          for (const s of steps) {
            let stepLine = `**Step ${s.stepNumber}** — ${s.actionType} [${s.status}]`;
            if (s.decision) stepLine += `: ${s.decision}`;
            lines.push(stepLine);
            if (s.actionParams) lines.push(`  Params: ${s.actionParams}`);
            if (s.actionOutput) lines.push(`  Output: ${s.actionOutput}`);
            if (s.executionTime !== undefined) {
              lines.push(`  Duration: ${s.executionTime}ms`);
            }
            lines.push("");
          }
        }
      } catch {
        // steps fetch failed, return status only
      }

      return {
        isError: exec.status === "failed",
        content: [{ type: "text", text: lines.join("\n") }],
      };
    }
  );
}

// --- cancel_task ---

function registerCancelTask(server: McpServer, client: QiraClient): void {
  server.registerTool(
    "cancel_task",
    {
      description:
        "Cancel a task that is currently in 'pending' or 'running' status. " +
        "Has no effect on tasks that have already completed (succeeded, failed, timeout).",
      inputSchema: {
        task_id: z.string().describe("The task ID to cancel"),
      },
    },
    async ({ task_id }) => {
      await client.cancelExecution(task_id);
      return {
        content: [{ type: "text", text: "Task cancelled successfully." }],
      };
    }
  );
}
