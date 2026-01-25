#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getStockRobotClient } from "./robot-client-stock.js";
import { getMapStore } from "./map-store.js";

// Use stock client for Elegoo's built-in firmware
const getRobotClient = getStockRobotClient;
import { movementTools } from "./tools/movement.js";
import { visionTools } from "./tools/vision.js";
import { sensorTools } from "./tools/sensors.js";
import { navigationTools } from "./tools/navigation.js";
import { systemTools } from "./tools/system.js";

// Combine all tools
const allTools = {
  ...movementTools,
  ...visionTools,
  ...sensorTools,
  ...navigationTools,
  ...systemTools,
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
  const robotUrl = process.env.ROBOT_URL || "ws://192.168.4.1:8080";

  console.error(`Elegoo Robot Car MCP Server starting...`);
  console.error(`Robot URL: ${robotUrl}`);

  // Initialize robot client (connection happens lazily)
  const robot = getRobotClient(robotUrl);

  // Initialize map store
  getMapStore();

  // Attempt to connect to robot
  try {
    await robot.connect();
    console.error("Connected to robot!");
  } catch (error) {
    console.error(
      `Warning: Could not connect to robot at ${robotUrl}. Tools will attempt to reconnect when used.`
    );
  }

  // Set up event handlers
  robot.on("connected", () => {
    console.error("Robot connected");
  });

  robot.on("disconnected", () => {
    console.error("Robot disconnected - will attempt to reconnect");
  });

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
