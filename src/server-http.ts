#!/usr/bin/env node

/**
 * Slabby HTTP Server - MCP Server for Slab Knowledge Base Integration
 * 
 * This is a READ-ONLY version of the Slabby MCP server that supports HTTP transport
 * for deployment on Cloud Run or similar platforms.
 * 
 * Features:
 * - READ ONLY: No update/delete capabilities (safe for LLM access)
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

import { ConfigService, ConfigServiceLive } from "./config.ts";
import { SlabClientService, SlabClientServiceLive } from "./client.ts";
import { formatPostResponse, formatSearchResults, formatListResults } from "./formatters.ts";
import { extractPostId } from "./utils.ts";

/**
 * The main application layer combining all services
 */
const AppLayer = Layer.mergeAll(
  ConfigServiceLive,
  SlabClientServiceLive.pipe(Layer.provide(ConfigServiceLive))
);

/**
 * READ-ONLY tool handlers using Effect
 * 
 * NOTE: Update/delete operations have been intentionally removed
 * to prevent LLMs from modifying Slab content.
 */
const toolHandlers = {
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
 * Create and configure the READ-ONLY MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: "slabby-readonly",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register READ-ONLY tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        // 📖 READ: Fetch post content by ID or URL
        {
          name: "slab__get_post",
          description:
            "Fetch a Slab post by ID or URL. Returns the post content in markdown format. This is a READ-ONLY operation.",
          inputSchema: {
            type: "object",
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
        // 🔍 SEARCH: Find posts across your workspace
        {
          name: "slab__search",
          description:
            "Search for posts across your Slab workspace. This is a READ-ONLY operation.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query string",
              },
            },
            required: ["query"],
          },
        },
        // 📋 LIST: Browse posts by topic
        {
          name: "slab__list_posts",
          description:
            "List posts in your Slab workspace, optionally filtered by topic. This is a READ-ONLY operation.",
          inputSchema: {
            type: "object",
            properties: {
              topicId: {
                type: "string",
                description: "Optional topic ID to filter posts",
              },
            },
          },
        },
        // NOTE: slab__update_post has been REMOVED for security
        // LLMs should not be able to modify Slab content
      ],
    };
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

    // Security: Block any update/delete operations
    if (name === "slab__update_post" || name === "slab__delete_post") {
      return {
        content: [
          {
            type: "text",
            text: "Error: This server is READ-ONLY. Update and delete operations are disabled for security.",
          },
        ],
        isError: true,
      };
    }

    // Get the handler for this tool
    const handler = toolHandlers[name as keyof typeof toolHandlers];
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
  }).pipe(Effect.provide(ConfigServiceLive), Effect.either);

  const configResult = await Effect.runPromise(configProgram);

  if (configResult._tag === "Left") {
    const error = configResult.left as Error;
    console.error("Configuration error:", error.message || String(error));
    process.exit(1);
  }

  const PORT = parseInt(process.env.PORT || "8080", 10);

  const app = express();
  app.use(express.json());

  // Health check endpoint for Cloud Run / load balancers
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "healthy", service: "slabby-readonly" });
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
        const server = createServer();
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
    console.log(`🧱 Slabby READ-ONLY HTTP Server listening on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    console.log(`   MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log("");
    console.log("Available tools (READ-ONLY):");
    console.log("  📖 slab__get_post  - Fetch post content by ID or URL");
    console.log("  🔍 slab__search    - Search posts across workspace");
    console.log("  📋 slab__list_posts - List posts by topic");
    console.log("");
    console.log("⛔ Update/delete operations are DISABLED for security");
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
