import { expect, test, vi } from "vitest";
import { buildMCPServer } from "../src/v2/bundler";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock the Google Cloud Storage
vi.mock("@google-cloud/storage", () => {
  return {
    Storage: vi.fn().mockImplementation(() => {
      return {
        bucket: vi.fn().mockImplementation(() => {
          return {
            upload: vi.fn().mockResolvedValue([{ name: "test-file" }]),
          };
        }),
      };
    }),
  };
});

// Mock fs.readdir for the recursive directory upload
vi.mock("fs/promises", async () => {
  const actual = await vi.importActual("fs/promises");
  return {
    ...actual,
    readdir: vi.fn().mockResolvedValue([
      { name: "file1.js", isDirectory: () => false },
      { name: "subdir", isDirectory: () => true },
    ]),
  };
});

test(
  "v2 bundler with GCP upload",
  async () => {
    const result = await buildMCPServer(
      "https://github.com/superseoworld/mcp-spotify",
      "mjs",
      "af9c8d6",
      "test-mcp-id"
    );

    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  },
  { timeout: 60000 }
);

test(
  "v2 bundler with monorepo URL",
  async () => {
    const result = await buildMCPServer(
      "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
      "mjs",
      "latest",
      "test-mcp-id"
    );

    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  },
  { timeout: 60000 }
);

test(
  "v2 bundler without mcpId skips GCP upload",
  async () => {
    const consoleSpy = vi.spyOn(console, "log");

    const result = await buildMCPServer(
      "https://github.com/superseoworld/mcp-spotify",
      "mjs",
      "af9c8d6"
    );

    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(consoleSpy).toHaveBeenCalledWith(
      "No MCP ID provided, skipping GCP upload"
    );

    consoleSpy.mockRestore();
  },
  { timeout: 60000 }
);
