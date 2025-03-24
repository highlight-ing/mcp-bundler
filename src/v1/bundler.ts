import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import * as Sentry from "@sentry/node";

const execAsync = promisify(exec);

// Add performance tracking
const perfMarkers = new Map<string, number>();

function startTimer(label: string) {
  perfMarkers.set(label, Date.now());
  console.log(`[PERF] Starting ${label}`);
}

function endTimer(label: string) {
  const start = perfMarkers.get(label);
  if (start) {
    const duration = Date.now() - start;
    console.log(`[PERF] ${label} completed in ${duration}ms`);
    perfMarkers.delete(label);
    return duration;
  }
  return 0;
}

// Add a timeout wrapper for any promise
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(`Operation '${operationName}' timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

function parseMonorepoUrl(githubUrl: string): {
  baseRepoUrl: string;
  branch?: string;
  subDir?: string;
} {
  // This regex will capture:
  //   group 1: the base URL (without /tree/...),
  //   group 3: the branch (e.g. 'main'),
  //   group 5: the subDir
  const re =
    /^(https?:\/\/github\.com\/[^/]+\/[^/]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?$/;
  const match = githubUrl.match(re);
  if (!match) {
    // If it doesn't match, assume it's just a normal repo URL
    return { baseRepoUrl: githubUrl };
  }

  const baseRepoUrl = match[1];
  const branch = match[2] || undefined;
  const subDir = match[3] || undefined;
  return { baseRepoUrl, branch, subDir };
}

export async function buildMCPServer(
  githubUrl: string,
  format: string,
  commit?: string
): Promise<string> {
  console.log("Building MCP server for", githubUrl, "with commit", commit);
  startTimer("buildMCPServer:total");

  const { baseRepoUrl, branch, subDir } = parseMonorepoUrl(githubUrl);

  const tempDir = path.join(
    os.tmpdir(),
    "mcp-" + crypto.randomBytes(8).toString("hex")
  );
  try {
    await fs.mkdir(tempDir);

    // 1. Git clone
    startTimer("git:clone");
    const cloneUrl = baseRepoUrl.endsWith(".git")
      ? baseRepoUrl
      : baseRepoUrl + ".git";

    try {
      await withTimeout(
        execAsync(`git clone ${cloneUrl} ${tempDir}`, {
          cwd: tempDir,
          shell: "/bin/bash",
        }),
        60000, // 1 minute timeout for git clone
        "git clone"
      );
      endTimer("git:clone");
    } catch (error) {
      endTimer("git:clone");
      if (
        error instanceof Error &&
        error.message.includes("git: command not found")
      ) {
        throw new Error(
          "Git is not installed. Please install git in your environment."
        );
      }
      throw error;
    }

    // 1b. Checkout the specific commit
    if (commit) {
      startTimer("git:checkout");
      try {
        await withTimeout(
          execAsync(`git checkout ${commit}`, {
            cwd: tempDir,
            shell: "/bin/bash",
          }),
          30000, // 30 second timeout for git checkout
          "git checkout"
        );
        endTimer("git:checkout");
      } catch (error) {
        endTimer("git:checkout");
        console.warn(
          `Failed to checkout commit ${commit}, using default branch`
        );
        // Try to get the default branch
        const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
          cwd: tempDir,
          shell: "/bin/bash",
        });
        console.log(`Using default branch: ${stdout.trim()}`);
      }
    }

    // 2. NPM/bun install in either the cloned root or the subDir
    startTimer("npm:install");
    const installDir = subDir ? path.join(tempDir, subDir) : tempDir;
    try {
      await withTimeout(
        execAsync("bun install", { cwd: installDir, shell: "/bin/bash" }),
        120000, // 2 minute timeout for npm install
        "bun install"
      );
      endTimer("npm:install");
    } catch (error) {
      endTimer("npm:install");
      console.warn("Bun install failed, trying npm install:", error);
      try {
        await withTimeout(
          execAsync("npm install", { cwd: installDir, shell: "/bin/bash" }),
          120000, // 2 minute timeout for npm install
          "npm install"
        );
      } catch (npmError) {
        console.warn(
          "Both bun and npm install failed, continuing anyway:",
          npmError
        );
      }
    }

    // 3. TypeScript compilation
    startTimer("typescript:compile");
    try {
      await withTimeout(
        execAsync("bun run tsc", { cwd: installDir, shell: "/bin/bash" }),
        60000, // 1 minute timeout for TypeScript compilation
        "tsc compile"
      );
      endTimer("typescript:compile");
    } catch (error) {
      endTimer("typescript:compile");
      console.warn(
        "TypeScript compilation failed, continuing with build:",
        error
      );

      // Check if the error is related to Symbol.dispose
      if (
        error instanceof Error &&
        error.message &&
        error.message.includes("Symbol.dispose")
      ) {
        console.log("Detected Symbol.dispose error, applying fix...");

        // Create a temporary tsconfig.json that targets an older version
        const tsConfigPath = path.join(installDir, "tsconfig.json");
        let tsConfig;

        try {
          // Try to read existing tsconfig
          const tsConfigContent = await fs.readFile(tsConfigPath, "utf-8");
          tsConfig = JSON.parse(tsConfigContent);

          // Backup original config
          await fs.writeFile(`${tsConfigPath}.backup`, tsConfigContent);

          // Modify the config to use ES2022 instead of newer versions
          if (!tsConfig.compilerOptions) tsConfig.compilerOptions = {};
          tsConfig.compilerOptions.target = "ES2022";
          tsConfig.compilerOptions.lib = ["ES2022", "DOM"];

          // Write the modified config
          await fs.writeFile(tsConfigPath, JSON.stringify(tsConfig, null, 2));

          // Try compilation again
          try {
            await withTimeout(
              execAsync("bun run tsc", {
                cwd: installDir,
                shell: "/bin/bash",
              }),
              60000, // 1 minute timeout
              "tsc compile with modified config"
            );
            console.log("Compilation succeeded with modified tsconfig");
          } catch (compileError) {
            console.warn(
              "TypeScript compilation still failed after fix, continuing with build"
            );
          }

          // Restore original config
          await fs.writeFile(tsConfigPath, tsConfigContent);
        } catch (configError) {
          console.warn("Failed to apply tsconfig fix:", configError);
        }
      }
    }

    // Find entrypoint
    startTimer("find:entrypoint");
    const possibleEntrypoints = [
      "index.ts",
      "index.js",
      "src/index.ts",
      "src/index.js",
      "src/mcp-server.ts",
    ];
    let entrypoint = null;
    for (const file of possibleEntrypoints) {
      try {
        await fs.access(path.join(installDir, file));
        entrypoint = file;
        break;
      } catch {
        continue;
      }
    }

    if (!entrypoint) {
      // Check if there's a main field in package.json
      try {
        const packageJsonPath = path.join(installDir, "package.json");
        const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
        const packageJson = JSON.parse(packageJsonContent);

        if (packageJson.main) {
          // Convert the main field to a relative path if needed
          const mainPath = packageJson.main;
          const normalizedPath = mainPath.startsWith("./")
            ? mainPath.slice(2)
            : mainPath;

          // Check if the file exists
          await fs.access(path.join(installDir, normalizedPath));
          entrypoint = normalizedPath;
          console.log(`Using entrypoint from package.json: ${entrypoint}`);
        }
      } catch (error) {
        console.warn("Failed to read or parse package.json:", error);
      }
    }
    endTimer("find:entrypoint");

    if (!entrypoint) {
      throw new Error("No valid entrypoint file found");
    }

    // 4. Build the bundle
    startTimer("bundle:build");
    try {
      console.log(
        `Attempting to build with bun: ${path.join(installDir, entrypoint)}`
      );
      try {
        // First check if bun is available
        await execAsync("which bun", { shell: "/bin/bash" });

        // If we get here, bun is available, so try to use it
        await withTimeout(
          execAsync(
            `bun build ${path.join(installDir, entrypoint)} ` +
              `--outfile bundle.${format} --target node --format ${
                format === "mjs" ? "esm" : "cjs"
              }`,
            { cwd: installDir, shell: "/bin/bash" }
          ),
          60000, // 1 minute timeout for bundle build
          "bun build"
        );
      } catch (bunError) {
        // Bun failed or isn't available, try esbuild as fallback
        console.warn("Bun build failed or not available:", bunError);
        console.log("Falling back to esbuild...");

        try {
          // Check if esbuild is installed
          await execAsync("npx --no-install esbuild --version", {
            shell: "/bin/bash",
          });

          // Use esbuild as fallback
          await withTimeout(
            execAsync(
              `npx esbuild ${path.join(installDir, entrypoint)} ` +
                `--bundle --platform=node --outfile=bundle.${format} --format=${
                  format === "mjs" ? "esm" : "cjs"
                }`,
              { cwd: installDir, shell: "/bin/bash" }
            ),
            60000, // 1 minute timeout for esbuild
            "esbuild"
          );
        } catch (esbuildError) {
          console.warn("esbuild fallback failed:", esbuildError);

          // Try installing esbuild and then using it
          try {
            console.log("Installing esbuild...");
            await execAsync("npm install --no-save esbuild", {
              cwd: installDir,
              shell: "/bin/bash",
            });

            await withTimeout(
              execAsync(
                `npx esbuild ${path.join(installDir, entrypoint)} ` +
                  `--bundle --platform=node --outfile=bundle.${format} --format=${
                    format === "mjs" ? "esm" : "cjs"
                  }`,
                { cwd: installDir, shell: "/bin/bash" }
              ),
              60000, // 1 minute timeout for esbuild
              "esbuild after install"
            );
          } catch (finalError) {
            console.error("All bundling attempts failed:", finalError);
            throw new Error(
              `Failed to bundle: ${
                finalError instanceof Error
                  ? finalError.message
                  : String(finalError)
              }`
            );
          }
        }
      }
      endTimer("bundle:build");
    } catch (error) {
      endTimer("bundle:build");
      console.error("Bundle build failed with error:", error);

      // Send detailed error to Sentry
      Sentry.captureException(error, {
        extra: {
          stage: "bundle:build",
          entrypoint,
          installDir,
          format,
        },
      });

      throw error;
    }

    // 5. Return the bundled file's content
    startTimer("read:bundle");
    const buildJsPath = path.join(installDir, `bundle.${format}`);
    let buildContent = await fs.readFile(buildJsPath, "utf-8");
    endTimer("read:bundle");

    const totalTime = endTimer("buildMCPServer:total");
    console.log(`Total build time: ${totalTime}ms`);

    // Log the bundle size
    const bundleSize = Buffer.byteLength(buildContent, "utf8");
    console.log(
      `Bundle size: ${bundleSize} bytes (${(bundleSize / (1024 * 1024)).toFixed(
        2
      )} MB)`
    );

    // Send warning to Sentry if bundle size is too large
    const MAX_RECOMMENDED_BUNDLE_SIZE = 28 * 1024 * 1024; // 28MB
    if (bundleSize > MAX_RECOMMENDED_BUNDLE_SIZE) {
      Sentry.captureMessage(
        `Large bundle size detected: ${(bundleSize / (1024 * 1024)).toFixed(
          2
        )} MB`,
        {
          level: "warning",
          extra: {
            githubUrl,
            commit,
            format,
            bundleSize,
            totalBuildTime: totalTime,
          },
        }
      );
    }

    return buildContent;
  } catch (error) {
    endTimer("buildMCPServer:total");
    console.error("Error during buildMCPServer:", error);

    // Send detailed error to Sentry
    Sentry.captureException(error, {
      extra: {
        githubUrl,
        commit,
        format,
        stage: "buildMCPServer",
        timers: Array.from(perfMarkers.entries()),
      },
    });

    throw new Error("Failed to build the server code.");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
