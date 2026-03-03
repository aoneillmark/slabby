#!/usr/bin/env bun

/**
 * Copyright 2025 Russ White
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Slabby - MCP Server for Slab Knowledge Base Integration
 *
 * Enables AI coding agents to read and update Slab documentation.
 * All edits are attributed to the user who owns the API token.
 */

import { Effect, Layer } from "effect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ConfigService, ConfigServiceLive } from "./config.ts";
import { SlabClientService, SlabClientServiceLive } from "./client.ts";
import { formatPostResponse, formatSearchResults, formatListResults } from "./formatters.ts";
import { extractPostId } from "./utils.ts";

/**
 * The main application layer combining all services
 */
const AppLayer = Layer.mergeAll(ConfigServiceLive, SlabClientServiceLive.pipe(Layer.provide(ConfigServiceLive)));

/**
 * Read-only tool handlers
 */
const readToolHandlers = {
  "slab__get_post": (args: any) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const postId = yield* extractPostId(args.postId as string);
      const post = yield* client.getPost(postId);
      return formatPostResponse(post);
    }),

  "slab__search": (args: any) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const query = args.query as string;
      const results = yield* client.searchPosts(query);
      return formatSearchResults(results, query);
    }),

  "slab__list_posts": (args: any) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const posts = yield* client.listPosts(args.topicId as string | undefined);
      return formatListResults(posts);
    }),
};

/**
 * Write tool handlers (only available when SLAB_READONLY is not "true")
 */
const writeToolHandlers = {
  "slab__update_post": (args: any) =>
    Effect.gen(function* () {
      const client = yield* SlabClientService;
      const postId = yield* extractPostId(args.postId as string);
      const result = yield* client.updatePost(postId, args.content as string);
      return `Post updated successfully: ${JSON.stringify(result, null, 2)}`;
    }),
};

/**
 * Read-only tool definitions (always available)
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
          description: "The Slab post ID or full post URL (e.g., 'abc123' or 'https://team.slab.com/posts/abc123')",
        },
      },
      required: ["postId"],
    },
  },
  {
    name: "slab__search",
    description: "Search for posts across your Slab workspace",
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
    description: "List posts in your Slab workspace, optionally filtered by topic",
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
function createServer(readOnly: boolean) {
  const serverName = readOnly ? "slabby-readonly" : "slabby";
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
  const activeHandlers: Record<string, (args: any) => Effect.Effect<string, any, any>> = {
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
        Effect.catchAll((error) =>
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
 * Start the MCP server
 */
async function main() {
  // Validate configuration first by loading it
  const configProgram = Effect.gen(function* () {
    const { config } = yield* ConfigService;
    return config;
  }).pipe(Effect.provide(ConfigServiceLive), Effect.either);

  const configResult = await Effect.runPromise(configProgram);

  if (configResult._tag === "Left") {
    const error = configResult.left as any;
    console.error("Configuration error:", error.message || String(error));
    process.exit(1);
  }

  const config = configResult.right;
  const readOnly = config.readOnly;

  // Create and start the server
  const server = createServer(readOnly);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const mode = readOnly ? "READ-ONLY" : "READ-WRITE";
  console.error(`Slabby MCP server running on stdio (${mode} mode)`);
  if (readOnly) {
    console.error("  ⛔ Write operations are DISABLED (SLAB_READONLY=true)");
  } else {
    console.error("  ✏️  Write operations are ENABLED (set SLAB_READONLY=true to disable)");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
