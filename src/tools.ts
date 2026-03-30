import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { QiraClient } from "./client.js";

export function registerTools(
  server: McpServer,
  client: QiraClient,
  shutdownSignal?: AbortSignal
): void {
  registerListDevices(server, client);
  registerListModelAliases(server, client);
  registerTakeScreenshot(server, client);
  registerRunTask(server, client, shutdownSignal);
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
        "List available model aliases (e.g. 'gemini-vertex-balanced', 'claude-vertex-fast'). Use the alias name as the model_alias parameter in run_task.",
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

// --- run_task ---

function registerRunTask(
  server: McpServer,
  client: QiraClient,
  shutdownSignal?: AbortSignal
): void {
  server.registerTool(
    "run_task",
    {
      description:
        "Perform UI automation on a device. The AI agent automatically handles app launching, " +
        "screen interactions (tapping, swiping, typing, navigating), and multi-step workflows.\n\n" +
        "Use this tool for:\n" +
        "- Opening apps and performing tasks: 'open Chrome and search for weather'\n" +
        "- In-app interactions: tapping, swiping, typing, navigating\n" +
        "- Content engagement: liking, commenting, sharing, following, subscribing\n" +
        "- Information gathering: reading screen content, searching, extracting data\n" +
        "- Web browsing: visiting URLs, filling forms, clicking links\n" +
        "- Messaging: sending messages, replying, forwarding\n\n" +
        "Do NOT use this tool to only take a screenshot — use take_screenshot instead.\n\n" +
        "Provide only the end goal in instruction (e.g., 'open WeChat and send hello to Zhang San'), not low-level steps.\n" +
        "Set wait=false to get immediately with a task ID. Use get_task to poll for status and results.\n" +
        "Set wait=true to wait for the task to complete and return all results in one call.\n" +
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
            "Model alias to use (e.g. 'gemini-vertex-balanced'). Use list_model_aliases to see available options."
          ),
        max_steps: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Maximum number of AI decision steps (default: 30). Increase for complex multi-step tasks."
          ),
        wait: z
          .boolean()
          .optional()
          .describe(
            "If true, wait for the task to complete and return results directly. " +
            "Defaults to false — returns immediately with a task ID for polling via get_task."
          ),
        timeout: z
          .number()
          .positive()
          .optional()
          .describe(
            "Maximum seconds to wait for task completion when wait=true (default: 90). " +
            "Only applies when wait is true. If the task is still running after this timeout, " +
            "returns current progress and the task ID for continued polling via get_task.\n\n" +
            "Guidelines for setting timeout based on task complexity:\n" +
            "- Simple actions (tap, click, type): 30-60s\n" +
            "- Moderate tasks (open app and navigate): 60-120s\n" +
            "- Complex multi-step tasks (search, fill forms, multi-page navigation): 120-300s\n" +
            "- Long workflows (multi-app interactions, content creation): 300-600s"
          ),
      },
    },
    async ({ device_id, instruction, model_alias, max_steps, wait, timeout }) => {
      console.error(
        `[run_task] device_id=${device_id} wait=${wait ?? false} timeout=${timeout ?? "(none)"}s max_steps=${max_steps ?? "(none)"} model_alias=${model_alias ?? "(none)"} instruction=${instruction}`
      );
      // Ensure WebSocket is ready before starting task to avoid missing events
      if (wait === true) {
        await client.connectWebSocket().catch(() => {});
      }

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

      // Cancel server-side task when pipe disconnects
      const onShutdown = () => {
        console.error(
          `[run_task] pipe disconnected, cancelling task ${resp.taskId}`
        );
        client.cancelTask(resp.taskId).catch(() => {});
        client.closeSession(sess.id).catch(() => {});
      };

      if (shutdownSignal?.aborted) {
        onShutdown();
        throw new Error("Task cancelled: pipe disconnected");
      }
      shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

      // async mode (default): return task ID immediately (shutdown listener stays active)
      if (wait !== true) {
        return {
          content: [
            {
              type: "text",
              text: `Task started.\n- Task ID: \`${resp.taskId}\`\n\nUse \`get_task\` to poll for status and results.`,
            },
          ],
        };
      }

      // sync mode (wait=true): stream via WebSocket, fall back to polling
      try {
        const timeoutMs = timeout !== undefined ? timeout * 1000 : undefined;

        const result = await client.watchTask(
          resp.taskId,
          timeoutMs,
          shutdownSignal
        );

        shutdownSignal?.removeEventListener("abort", onShutdown);

        const lines: string[] = [];
        lines.push(`Task \`${result.task.id}\`:`);
        lines.push(`- Status: **${result.task.status}**`);

        if (result.timedOut) {
          lines.push(
            `- Timed out, task still ${result.task.status}`
          );
          lines.push(
            `- Progress: step ${result.task.currentStep}, ${result.steps.length} step(s) completed`
          );
          lines.push(
            `- Use \`get_task\` with task ID \`${result.task.id}\` to continue tracking.`
          );
        }

        if (result.task.errorMessage) {
          lines.push(`- Error: ${result.task.errorMessage}`);
        }

        if (result.steps.length > 0) {
          lines.push("", `### Steps (${result.steps.length})`, "");
          for (const s of result.steps) {
            let stepLine = `**Step ${s.stepNumber}** — ${s.actionType} [${s.status}]`;
            if (s.decision) stepLine += `: ${s.decision}`;
            lines.push(stepLine);
            if (s.actionParams) lines.push(`  Params: ${s.actionParams}`);
            if (s.actionOutput) lines.push(`  Output: ${s.actionOutput}`);
            const totalTime =
              s.stepDuration ??
              (s.actionDurationTime ?? 0) +
              (s.llmDecisionTime ?? 0) +
              (s.coordinateParseTime ?? 0);
            if (totalTime > 0) {
              lines.push(`  Duration: ${totalTime}ms`);
            }
            lines.push("");
          }
        }

        return {
          isError: result.task.status === "failed",
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (err) {
        shutdownSignal?.removeEventListener("abort", onShutdown);
        if (shutdownSignal?.aborted) {
          throw new Error("Task cancelled: pipe disconnected");
        }
        throw err;
      }
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
      const exec = await client.getTask(task_id);

      const lines: string[] = [];
      lines.push(`Task \`${exec.id}\`:`);
      lines.push(`- Status: **${exec.status}**`);
      lines.push(`- Current Step: ${exec.currentStep}`);
      if (exec.errorMessage) {
        lines.push(`- Error: ${exec.errorMessage}`);
      }

      try {
        const steps = await client.getTaskSteps(task_id);
        if (steps.length > 0) {
          lines.push("", `### Steps (${steps.length})`, "");
          for (const s of steps) {
            let stepLine = `**Step ${s.stepNumber}** — ${s.actionType} [${s.status}]`;
            if (s.decision) stepLine += `: ${s.decision}`;
            lines.push(stepLine);
            if (s.actionParams) lines.push(`  Params: ${s.actionParams}`);
            if (s.actionOutput) lines.push(`  Output: ${s.actionOutput}`);
            const totalTime =
              s.stepDuration ??
              (s.actionDurationTime ?? 0) +
              (s.llmDecisionTime ?? 0) +
              (s.coordinateParseTime ?? 0);
            if (totalTime > 0) {
              lines.push(`  Duration: ${totalTime}ms`);
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
      await client.cancelTask(task_id);
      return {
        content: [{ type: "text", text: "Task cancelled successfully." }],
      };
    }
  );
}
