import { expect, test } from "vitest";
import { buildMCPServer } from "../src/v1/bundler.js";
import { writeFile } from "fs/promises";
import { spawn } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

test("mcp-spotify", async () => {
  const result = await buildMCPServer(
    "https://github.com/superseoworld/mcp-spotify",
    "af9c8d6"
  );
  expect(result).toBeDefined();
  expect(typeof result).toBe("string");
});

test("deep-research-mcp", async () => {
  const result = await buildMCPServer(
    "https://github.com/highlight-ing/deep-research-mcp",
    "b75ad45"
  );
  expect(result).toBeDefined();
  expect(typeof result).toBe("string");
});

test("apple-mcp", async () => {
  const result = await buildMCPServer(
    "https://github.com/Dhravya/apple-mcp",
    "5cab1cb"
  );
  expect(result).toBeDefined();
  expect(typeof result).toBe("string");
});

test("mcp-image-downloader", async () => {
  const result = await buildMCPServer(
    "https://github.com/qpd-v/mcp-image-downloader",
    "a8fed2a"
  );
  expect(result).toBeDefined();
  expect(typeof result).toBe("string");
});

test("exa-mcp-server", async () => {
  const result = await buildMCPServer(
    "https://github.com/highlight-ing/exa-mcp-server",
    "0b3b729"
  );
  expect(result).toBeDefined();
  expect(typeof result).toBe("string");
});

test(
  "slack",
  async () => {
    const result = await buildMCPServer(
      "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
      "861a51c"
    );
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  },
  { timeout: 30000 }
);

test(
  "github",
  async () => {
    const result = await buildMCPServer(
      "https://github.com/highlight-ing/mcp-servers/tree/main/src/github",
      "bf5dc77"
    );
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  },
  { timeout: 30000 }
);

test(
  "obsidian",
  async () => {
    const result = await buildMCPServer(
      "https://github.com/cyanheads/obsidian-mcp-server",
      "8917483"
    );
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
  },
  { timeout: 30000 }
);
