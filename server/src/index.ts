#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CompleteRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createServer } from "http";

import { getStockRobotClient } from "./robot-client-stock.js";
import { getMapStore } from "./map-store.js";

// Use stock client for Elegoo's built-in firmware
const getRobotClient = getStockRobotClient;
import { movementTools } from "./tools/movement.js";
import { visionTools } from "./tools/vision.js";
import { sensorTools } from "./tools/sensors.js";
import { navigationTools } from "./tools/navigation.js";
import { systemTools } from "./tools/system.js";
import { sequenceTools } from "./tools/sequences.js";
import { tacticalTools } from "./tools/tactical.js";

// Combine all tools
const allTools = {
  ...movementTools,
  ...visionTools,
  ...sensorTools,
  ...navigationTools,
  ...systemTools,
  ...sequenceTools,
  ...tacticalTools,
};

type ToolName = keyof typeof allTools;

// Create MCP server
const server = new Server(
  {
    name: "elegoo-robot-car",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      completions: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = Object.entries(allTools).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema),
  }));

  return { tools };
});

// Handle completions (required by reloaderoo proxy)
server.setRequestHandler(CompleteRequestSchema, async () => {
  return { completion: { values: [] } };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = allTools[name as ToolName];
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    // Validate arguments
    const validatedArgs = tool.schema.parse(args || {});

    // Call handler
    const result = await tool.handler(validatedArgs as never);

    // Handle different result types
    if (typeof result === "string") {
      return {
        content: [{ type: "text", text: result }],
      };
    }

    // For tools that return structured content (like capture_image)
    if (result && typeof result === "object" && "content" in result) {
      return result;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid arguments: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
      isError: true,
    };
  }
});

// Convert Zod schema to JSON Schema
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = {
    type: "object",
    properties: {},
    required: [] as string[],
  };

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const fieldSchema = value as z.ZodTypeAny;
      properties[key] = zodFieldToJsonSchema(fieldSchema);

      // Check if required (not optional)
      if (!(fieldSchema instanceof z.ZodOptional) && !(fieldSchema instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    jsonSchema.properties = properties;
    if (required.length > 0) {
      jsonSchema.required = required;
    }
  }

  return jsonSchema;
}

function zodFieldToJsonSchema(field: z.ZodTypeAny): Record<string, unknown> {
  const schema: Record<string, unknown> = {};

  // Handle wrapped types
  let unwrapped = field;
  if (field instanceof z.ZodOptional) {
    unwrapped = field.unwrap();
  }
  if (field instanceof z.ZodDefault) {
    unwrapped = field._def.innerType;
    schema.default = field._def.defaultValue();
  }

  // Get description
  const description = unwrapped._def.description;
  if (description) {
    schema.description = description;
  }

  // Determine type
  if (unwrapped instanceof z.ZodString) {
    schema.type = "string";
  } else if (unwrapped instanceof z.ZodNumber) {
    schema.type = "number";
    if (unwrapped._def.checks) {
      for (const check of unwrapped._def.checks) {
        if (check.kind === "min") schema.minimum = check.value;
        if (check.kind === "max") schema.maximum = check.value;
      }
    }
  } else if (unwrapped instanceof z.ZodBoolean) {
    schema.type = "boolean";
  } else if (unwrapped instanceof z.ZodEnum) {
    schema.type = "string";
    schema.enum = unwrapped._def.values;
  } else if (unwrapped instanceof z.ZodArray) {
    schema.type = "array";
    schema.items = zodFieldToJsonSchema(unwrapped._def.type);
  }

  return schema;
}

// Initialize and run
async function main() {
  const robotHost = process.env.ROBOT_HOST || "192.168.4.1";
  const robotPort = parseInt(process.env.ROBOT_PORT || "100");
  const visionUrl = process.env.VISION_SERVICE_URL || "http://localhost:8765";
  const useHttp = process.argv.includes("--http") || process.env.MCP_HTTP === "true";
  const httpPort = parseInt(process.env.MCP_PORT || "3456");

  console.error(`Elegoo Robot Car MCP Server starting...`);
  console.error(`Robot: ${robotHost}:${robotPort} (stock Elegoo firmware)`);
  console.error(`Vision service: ${visionUrl}`);
  console.error(`Transport: ${useHttp ? `HTTP/SSE on port ${httpPort}` : "stdio"}`);

  // Initialize robot client for stock Elegoo firmware (TCP port 100)
  const robot = getRobotClient(robotHost, robotPort);

  // Initialize map store
  getMapStore();

  // Attempt to connect to robot
  try {
    await robot.connect();
    console.error("Connected to robot!");
  } catch {
    console.error(
      `Warning: Could not connect to robot at ${robotHost}:${robotPort}. Tools will attempt to reconnect when used.`
    );
    console.error(
      "Make sure you're connected to the ELEGOO WiFi network and the robot is powered on."
    );
  }

  // Set up event handlers
  robot.on("connected", () => {
    console.error("Robot connected");
  });

  robot.on("disconnected", () => {
    console.error("Robot disconnected - will attempt to reconnect");
  });

  if (useHttp) {
    // HTTP/SSE mode - allows watch/restart without breaking Claude connection
    const transports: Map<string, SSEServerTransport> = new Map();

    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || "", `http://localhost:${httpPort}`);

      // Handle SSE connections
      if (url.pathname === "/sse") {
        console.error("New SSE connection");
        const transport = new SSEServerTransport("/message", res);
        transports.set(transport.sessionId, transport);

        res.on("close", () => {
          transports.delete(transport.sessionId);
          console.error("SSE connection closed");
        });

        await server.connect(transport);
        return;
      }

      // Handle messages
      if (url.pathname === "/message" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? transports.get(sessionId) : null;

        if (transport) {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            await transport.handlePostMessage(req, res, body);
          });
        } else {
          res.writeHead(404);
          res.end("Session not found");
        }
        return;
      }

      // Health check
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", robot: robot.isConnected() }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(httpPort, () => {
      console.error(`MCP server running on http://localhost:${httpPort}/sse`);
    });
  } else {
    // Stdio mode - standard MCP transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
