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
 * Configuration service using Effect Context
 */

import { Context, Effect, Layer } from "effect";

/**
 * Error types for configuration
 */
export class ConfigError {
  readonly _tag = "ConfigError";
  constructor(readonly message: string) {}
}

/**
 * Slab configuration
 */
export interface SlabConfig {
  readonly apiToken: string;
  readonly team: string;
  readonly graphqlUrl: string;
  readonly readOnly: boolean;
}

/**
 * Configuration service interface
 */
export interface ConfigService {
  readonly config: SlabConfig;
}

/**
 * Configuration context tag
 */
export const ConfigService = Context.GenericTag<ConfigService>("@services/ConfigService");

/**
 * Load configuration from environment variables
 * @param defaultReadOnly - Default value for readOnly if SLAB_READONLY env var is not set.
 *                          Stdio server defaults to false (writes enabled),
 *                          HTTP server defaults to true (writes disabled).
 */
export const loadConfig = (defaultReadOnly = false): Effect.Effect<SlabConfig, ConfigError> =>
  Effect.gen(function* () {
    const apiToken = process.env.SLAB_API_TOKEN;
    const team = process.env.SLAB_TEAM;

    if (!apiToken) {
      return yield* Effect.fail(new ConfigError("SLAB_API_TOKEN environment variable is required"));
    }

    if (!team) {
      return yield* Effect.fail(new ConfigError("SLAB_TEAM environment variable is required"));
    }

    // SLAB_READONLY: set to "true" or "false" to explicitly control write access.
    // If not set, falls back to the defaultReadOnly parameter.
    const readOnlyEnv = process.env.SLAB_READONLY;
    const readOnly = readOnlyEnv !== undefined
      ? readOnlyEnv.toLowerCase() === "true"
      : defaultReadOnly;

    return {
      apiToken,
      team,
      graphqlUrl: "https://api.slab.com/v1/graphql",
      readOnly,
    };
  });

/**
 * Create a configuration layer with a specific defaultReadOnly value
 * @param defaultReadOnly - Default for readOnly if SLAB_READONLY is not set
 */
export const makeConfigServiceLive = (defaultReadOnly = false) =>
  Layer.effect(
    ConfigService,
    Effect.gen(function* () {
      const config = yield* loadConfig(defaultReadOnly);
      return { config };
    })
  );

/**
 * Live configuration layer - loads from environment
 * Defaults to readOnly=false (writes enabled) — suitable for stdio/local use
 */
export const ConfigServiceLive = makeConfigServiceLive(false);
