import { serve } from "@hono/node-server";
import { Hono } from "hono";
import * as Sentry from "@sentry/node";
import dotenv from "dotenv";

// Import both bundler versions
import { buildMCPServer as buildMCPServerV1 } from "./v1/bundler.js";
import { buildMCPServer as buildMCPServerV2 } from "./v2/bundler";
import { setupGCPCredentials } from "./utils/index.js";
import { swaggerUI } from "@hono/swagger-ui";

// ADDED IMPORTS FOR BUILD PROCESS
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import crypto from "crypto";

// Load environment variables
dotenv.config();

// Call the setup function
setupGCPCredentials();

// Initialize Sentry
Sentry.init({
  dsn: process.env.SENTRY_INGEST_URL,
  tracesSampleRate: 1.0,
});

// Define OpenAPI spec
const openAPISpec = {
  openapi: "3.0.0",
  info: {
    title: "MCP Bundler API",
    version: "1.0.0",
    description: "API for bundling code from GitHub repositories",
  },
  paths: {
    "/health": {
      get: {
        summary: "Health check endpoint",
        description: "Returns the health status of the API",
        responses: {
          "200": {
            description: "API is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: {
                      type: "string",
                      example: "ok",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/bundler": {
      get: {
        summary: "V1 Bundler (Legacy)",
        description:
          "Bundles code from a GitHub repository and returns it directly in the response",
        parameters: [
          {
            name: "url",
            in: "query",
            required: true,
            schema: {
              type: "string",
            },
            description: "GitHub repository URL",
          },
          {
            name: "commit",
            in: "query",
            required: false,
            schema: {
              type: "string",
            },
            description: "Commit hash (defaults to latest)",
          },
          {
            name: "format",
            in: "query",
            required: false,
            schema: {
              type: "string",
              enum: ["mjs", "cjs"],
              default: "mjs",
            },
            description: "Output format (mjs or cjs)",
          },
        ],
        responses: {
          "200": {
            description: "Successful operation",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "string",
                      description: "Bundled code",
                    },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid input",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
          "500": {
            description: "Server error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
          "504": {
            description: "Gateway timeout",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v2/bundler": {
      get: {
        summary: "V2 Bundler (with GCP Upload)",
        description:
          "Bundles code from a GitHub repository and uploads it to a GCP bucket. Set DISABLE_GCP_INTEGRATION=true in environment to skip upload, return data directly, and save a copy to the bundled directory.",
        parameters: [
          {
            name: "url",
            in: "query",
            required: true,
            schema: {
              type: "string",
            },
            description: "GitHub repository URL",
          },
          {
            name: "commit",
            in: "query",
            required: false,
            schema: {
              type: "string",
              default: "latest",
            },
            description: "Commit hash (defaults to latest)",
          },
          {
            name: "mcpId",
            in: "query",
            required: false,
            schema: {
              type: "string",
            },
            description:
              "MCP ID for the bundled server (will be generated if not provided)",
          },
        ],
        responses: {
          "200": {
            description: "Successful operation",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      description: "Response when GCP upload is enabled",
                      properties: {
                        success: {
                          type: "boolean",
                        },
                        gcp_upload: {
                          type: "object",
                          properties: {
                            bucket: {
                              type: "string",
                            },
                            path: {
                              type: "string",
                            },
                            files: {
                              type: "array",
                              items: {
                                type: "string",
                              },
                            },
                          },
                        },
                      },
                    },
                    {
                      type: "object",
                      description: "Response when GCP upload is disabled",
                      properties: {
                        success: {
                          type: "boolean",
                        },
                        data: {
                          type: "string",
                          description: "Bundled code",
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          "400": {
            description: "Invalid input",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
          "500": {
            description: "Server error",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                    },
                    details: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
          "504": {
            description: "Gateway timeout",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const app = new Hono();

app.get("/", async (c) => {
  try {
    const indexHtml = await fs.readFile(
      path.join(process.cwd(), "src/static/index.html"),
      "utf-8"
    );
    return c.html(indexHtml);
  } catch (error) {
    console.error("Error reading index.html:", error);
    return c.text("Error loading homepage", 500);
  }
});

// Mount Swagger UI
app.get("/docs", swaggerUI({ url: "/docs/openapi.json" }));
app.get("/docs/openapi.json", (c) => c.json(openAPISpec));

app.get("/health", (c) => {
  return c.json({
    status: "ok",
  });
});

// Keep the original bundler route for backward compatibility
app.get("/bundler", async (c) => {
  const url = c.req.query("url");
  const commit = c.req.query("commit");
  let format = c.req.query("format");

  if (!format) {
    // default to mjs if no format is provided
    format = "mjs";
  }

  if (!url) {
    return c.json({ error: "Github url is required" }, 400);
  }

  // Set a timeout for the bundler operation (5 minutes)
  const BUNDLER_TIMEOUT = 300000;

  try {
    // Create a promise that rejects after the timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`Bundler operation timed out after ${BUNDLER_TIMEOUT}ms`)
        );
      }, BUNDLER_TIMEOUT);
    });

    // Race the bundler operation against the timeout
    const result = await Promise.race([
      buildMCPServerV1(url, format, commit),
      timeoutPromise,
    ]);

    // Log the total response size
    const responseSize = Buffer.byteLength(result as string, "utf8");
    console.log(
      `Total response size: ${responseSize} bytes (${(
        responseSize /
        (1024 * 1024)
      ).toFixed(2)} MB)`
    );

    return c.json({
      data: result,
    });
  } catch (error) {
    // Capture the error in Sentry
    Sentry.captureException(error, {
      extra: {
        url,
        commit,
        format,
      },
    });

    // Check if it's a timeout error
    if (error instanceof Error && error.message.includes("timed out")) {
      return c.json(
        {
          error:
            "Bundler operation timed out. The repository may contain large WASM files or complex dependencies that exceed the processing limits.",
        },
        504
      ); // Gateway Timeout status
    }

    return c.json({ error: "Failed to build MCP server" }, 500);
  }
});

// Add new v2 bundler route with GCP upload support
app.get("/v2/bundler", async (c) => {
  const url = c.req.query("url");
  const commit = c.req.query("commit") || "latest";
  const mcpId = c.req.query("mcpId") || crypto.randomBytes(16).toString("hex");
  const skipGcpUpload = process.env.DISABLE_GCP_INTEGRATION === "true";

  if (!url) {
    return c.json({ error: "Github url is required" }, 400);
  }

  // Set a timeout for the bundler operation (5 minutes)
  const BUNDLER_TIMEOUT = 300000;

  try {
    // Create a promise that rejects after the timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`Bundler operation timed out after ${BUNDLER_TIMEOUT}ms`)
        );
      }, BUNDLER_TIMEOUT);
    });

    // Check if mcpId is provided when GCP upload is required
    if (!mcpId && !skipGcpUpload) {
      return c.json(
        { error: "mcpId is required for v2/bundler endpoint with GCP upload" },
        400
      );
    }

    if (!skipGcpUpload) {
      console.log(
        `Will upload bundled server to GCP bucket for MCP ID: ${mcpId}`
      );
    } else {
      console.log("GCP upload is disabled by environment variable");
    }

    // Race the bundler operation against the timeout
    const result = (await Promise.race([
      buildMCPServerV2(url, commit, skipGcpUpload ? undefined : mcpId),
      timeoutPromise,
    ])) as string | { data: string; actualCommit: string } | null;

    // Handle the case where result is null (shouldn't happen in practice)
    if (result === null) {
      throw new Error("Unexpected null result from bundler");
    }

    // Handle the result based on its type
    if (
      typeof result === "object" &&
      "data" in result &&
      "actualCommit" in result
    ) {
      // This is the case when GCP upload is disabled
      return c.json({
        success: true,
        data: result.data,
      });
    }

    // This is the case when GCP upload is enabled
    // For GCP upload path, prepare the archive filename and return GCP info
    // We need to extract the actual commit hash that was used for upload
    const resultStr = result as string;

    // First try to extract from the bundled content (most reliable)
    const contentMatch = resultStr.match(
      /\/\/ COMMIT_HASH:([a-f0-9]+|unknown)/
    );

    let actualCommit = commit;
    if (
      contentMatch &&
      contentMatch.length >= 2 &&
      contentMatch[1] !== "unknown"
    ) {
      actualCommit = contentMatch[1];
      console.log(`Found commit hash in bundled content: ${actualCommit}`);
    } else {
      // Look for our specific marker in the logs
      const markerMatch = resultStr.match(
        /COMMIT_HASH_FOR_RESPONSE:([a-f0-9]+)/
      );

      if (markerMatch && markerMatch.length >= 2) {
        actualCommit = markerMatch[1];
        console.log(`Found commit marker in result: ${actualCommit}`);
      } else {
        // Extract the actual path from the upload log as fallback
        const pathMatch = resultStr.match(
          /gs:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)\/[^\/]+\.tar\.gz/
        );

        if (pathMatch && pathMatch.length >= 3) {
          // Second capture group is the commit hash used in the upload
          actualCommit = pathMatch[2];
          console.log(
            `Extracted actual commit from upload path: ${actualCommit}`
          );
        } else {
          // Try one more method
          const commitMatch = resultStr.includes("Using actual commit hash:")
            ? resultStr.match(/Using actual commit hash: ([a-f0-9]+)/)
            : null;

          if (commitMatch && commitMatch.length >= 2) {
            actualCommit = commitMatch[1];
            console.log(`Extracted actual commit from log: ${actualCommit}`);
          }
        }
      }
    }

    const archiveFilename = `bundle-${actualCommit}.tar.gz`;

    return c.json({
      success: true,
      gcp_upload: {
        bucket: process.env.GCP_BUCKET_NAME,
        path: `${mcpId}/${actualCommit}/`,
        files: [archiveFilename],
      },
    });
  } catch (error) {
    // Capture the error in Sentry
    Sentry.captureException(error, {
      extra: {
        url,
        commit,
        mcpId,
        skipGcpUpload,
      },
    });

    // Check if it's a timeout error
    if (error instanceof Error && error.message.includes("timed out")) {
      return c.json(
        {
          error:
            "Bundler operation timed out. The repository may contain large WASM files or complex dependencies that exceed the processing limits.",
        },
        504
      ); // Gateway Timeout status
    }

    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to build MCP server",
        details: error instanceof Error ? error.stack : undefined,
      },
      500
    );
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
console.log(`Server is running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0",
});
