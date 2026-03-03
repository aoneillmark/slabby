#!/usr/bin/env node

/**
 * Slabby HTTP Server - MCP Server for Slab Knowledge Base Integration
 * 
 * HTTP/SSE transport for deployment on Cloud Run or similar platforms.
 * 
 * Features:
 * - Configurable read-only mode via SLAB_READONLY env var (defaults to "true")
 * - HTTP/SSE transport for cloud deployment
 * - Health check endpoint for load balancers
 * 
 * Based on the original Slabby by Russ White (Apache 2.0 License)
 */

import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import type { Request, Response } from "express";

import { ConfigService, makeConfigServiceLive } from "./config.ts";
import { SlabClientService, SlabClientServiceLive } from "./client.ts";
import { formatPostResponse, formatSearchResults, formatListResults } from "./formatters.ts";
import { extractPostId } from "./utils.ts";

/**
 * The main application layer combining all services
 * HTTP server defaults to read-only (SLAB_READONLY=true) for cloud deployment safety
 */
const HttpConfigServiceLive = makeConfigServiceLive(true);
const AppLayer = Layer.mergeAll(
  HttpConfigServiceLive,
  SlabClientServiceLive.pipe(Layer.provide(HttpConfigServiceLive))
);

/**
 * Read-only tool handlers (always available)
 */
const readToolHandlers: Record<string, (args: Record<string, unknown>) => Effect.Effect<string, any, any>> = {
  // 📖 READ: Fetch post content by ID or URL
  "slab__get_post": (args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const postId = yield* extractPostId(args.postId as string);
      const post = yield* client.getPost(postId);
      return formatPostResponse(post);
    }),

  // 🔍 SEARCH: Find posts across your workspace
  "slab__search": (args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const query = args.query as string;
      const results = yield* client.searchPosts(query);
      return formatSearchResults(results, query);
    }),

  // 📋 LIST: Browse posts by topic
  "slab__list_posts": (args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const posts = yield* client.listPosts(args.topicId as string | undefined);
      return formatListResults(posts);
    }),
};

/**
 * Write tool handlers (only available when SLAB_READONLY is not "true")
 */
const writeToolHandlers: Record<string, (args: Record<string, unknown>) => Effect.Effect<string, any, any>> = {
  // ✏️ WRITE: Update post content
  "slab__update_post": (args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const postId = yield* extractPostId(args.postId as string);
      const result = yield* client.updatePost(postId, args.content as string);
      return `Post updated successfully: ${JSON.stringify(result, null, 2)}`;
    }),
};

/**
 * Read-only tool definitions
 */
const readToolDefinitions = [
  {
    name: "slab__get_post",
    description: "Fetch a Slab post by ID or URL. Returns the post content in markdown format.",
    inputSchema: {
      type: "object" as const,
      properties: {
        postId: {
          type: "string",
          description:
            "The Slab post ID or full post URL (e.g., 'abc123' or 'https://team.slab.com/posts/abc123')",
        },
      },
      required: ["postId"],
    },
  },
  {
    name: "slab__search",
    description: "Search for posts across your Slab workspace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query string",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "slab__list_posts",
    description: "List posts in your Slab workspace, optionally filtered by topic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topicId: {
          type: "string",
          description: "Optional topic ID to filter posts",
        },
      },
    },
  },
];

/**
 * Write tool definitions (only exposed when readOnly is false)
 */
const writeToolDefinitions = [
  {
    name: "slab__update_post",
    description: "Update a Slab post with new content. Edits will be attributed to your user account.",
    inputSchema: {
      type: "object" as const,
      properties: {
        postId: {
          type: "string",
          description: "The Slab post ID or full post URL",
        },
        content: {
          type: "string",
          description: "The new content for the post in markdown format",
        },
      },
      required: ["postId", "content"],
    },
  },
];

/**
 * Create and configure the MCP server
 * @param readOnly - If true, write/update tools are disabled
 */
function createServer(readOnly: boolean): Server {
  const serverName = readOnly ? "slabby-http-readonly" : "slabby-http";
  const server = new Server(
    {
      name: serverName,
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Build the active tool handlers and definitions based on readOnly flag
  const activeHandlers: Record<string, (args: Record<string, unknown>) => Effect.Effect<string, any, any>> = {
    ...readToolHandlers,
    ...(!readOnly ? writeToolHandlers : {}),
  };
  const activeToolDefinitions = [
    ...readToolDefinitions,
    ...(!readOnly ? writeToolDefinitions : []),
  ];

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: activeToolDefinitions };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!args) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Missing required arguments",
          },
        ],
        isError: true,
      };
    }

    // Block write operations if readOnly is enabled
    if (readOnly && (name === "slab__update_post" || name === "slab__delete_post")) {
      return {
        content: [
          {
            type: "text",
            text: "Error: This server is running in READ-ONLY mode (SLAB_READONLY=true). Update and delete operations are disabled.",
          },
        ],
        isError: true,
      };
    }

    // Get the handler for this tool
    const handler = activeHandlers[name];
    if (!handler) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
    }

    // Run the Effect with the app layer and handle errors
    const result = await Effect.runPromise(
      handler(args).pipe(
        Effect.provide(AppLayer),
        Effect.catchAll((error: Error) =>
          Effect.succeed(`Error: ${error.message || String(error)}`)
        )
      )
    );

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  });

  return server;
}

/**
 * In-memory event store for SSE resumability
 */
class InMemoryEventStore {
  private events: Map<string, { streamId: string; message: unknown }[]> = new Map();

  async storeEvent(streamId: string, message: unknown): Promise<string> {
    const eventId = randomUUID();
    if (!this.events.has(streamId)) {
      this.events.set(streamId, []);
    }
    this.events.get(streamId)!.push({ streamId, message });
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _send: (eventId: string, message: unknown) => Promise<void>
  ): Promise<string | undefined> {
    // Simple implementation - in production you'd want proper event replay
    return lastEventId;
  }
}

// Store active transports by session ID
const transports: Record<string, StreamableHTTPServerTransport> = {};

/**
 * Start the HTTP server
 */
async function main(): Promise<void> {
  // Validate configuration first
  const configProgram = Effect.gen(function* () {
    const { config } = yield* ConfigService;
    return config;
  }).pipe(Effect.provide(HttpConfigServiceLive), Effect.either);

  const configResult = await Effect.runPromise(configProgram);

  if (configResult._tag === "Left") {
    const error = configResult.left as Error;
    console.error("Configuration error:", error.message || String(error));
    process.exit(1);
  }

  const config = configResult.right;
  // HTTP server defaults to read-only for safety; set SLAB_READONLY=false to enable writes
  const readOnly = config.readOnly;

  const PORT = parseInt(process.env.PORT || "8080", 10);

  const app = express();
  app.use(express.json());

  const mode = readOnly ? "readonly" : "read-write";

  // Health check endpoint for Cloud Run / load balancers
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "healthy", service: `slabby-http-${mode}` });
  });

  // MCP POST endpoint - handles initialization and tool calls
  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          onsessioninitialized: (newSessionId: string) => {
            console.log(`Session initialized: ${newSessionId}`);
            transports[newSessionId] = transport;
          },
        });

        // Clean up on close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            console.log(`Session closed: ${sid}`);
            delete transports[sid];
          }
        };

        // Connect to MCP server
        const server = createServer(readOnly);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  // MCP GET endpoint - handles SSE streams
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  });

  // MCP DELETE endpoint - handles session termination
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling session termination:", error);
      if (!res.headersSent) {
        res.status(500).send("Error processing session termination");
      }
    }
  });

  // Start the server
  app.listen(PORT, () => {
    const modeLabel = readOnly ? "READ-ONLY" : "READ-WRITE";
    console.log(`🧱 Slabby HTTP Server listening on port ${PORT} (${modeLabel} mode)`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log("");
    console.log("Available tools:");
    console.log("  📖 slab__get_post   - Fetch post content by ID or URL");
    console.log("  🔍 slab__search     - Search posts across workspace");
    console.log("  📋 slab__list_posts  - List posts by topic");
    if (!readOnly) {
      console.log("  ✏️  slab__update_post - Update post content");
    }
    console.log("");
    if (readOnly) {
      console.log("⛔ Write operations are DISABLED (SLAB_READONLY=true, default for HTTP server)");
      console.log("   Set SLAB_READONLY=false to enable write operations");
    } else {
      console.log("⚠️  Write operations are ENABLED (SLAB_READONLY=false)");
    }
  });

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down server...");
    for (const sessionId in transports) {
      try {
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing session ${sessionId}:`, error);
      }
    }
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\nReceived SIGTERM, shutting down...");
    for (const sessionId in transports) {
      try {
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing session ${sessionId}:`, error);
      }
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
