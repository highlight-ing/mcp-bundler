import * as path from "path";
import * as fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import * as Sentry from "@sentry/node";
import {
  execAsync,
  startTimer,
  endTimer,
  withTimeout,
  parseMonorepoUrl,
  createTarGzArchive,
  uploadToGCPBucket,
  perfMarkers,
} from "../utils";

export async function buildMCPServer(
  githubUrl: string,
  commit?: string,
  mcpId?: string
): Promise<string | { data: string; actualCommit: string }> {
  console.log("Building MCP server for", githubUrl, "with commit", commit);
  startTimer("buildMCPServer:total");

  const { baseRepoUrl, branch, subDir } = parseMonorepoUrl(githubUrl);

  const tempDir = path.join(
    os.tmpdir(),
    "mcp-" + crypto.randomBytes(8).toString("hex")
  );

  // Store the actual commit hash we end up using
  let actualCommit: string | null = null;

  try {
    await fs.mkdir(tempDir);
    console.log("Temp dir:", tempDir);

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
      // Add Sentry error reporting with context
      Sentry.captureException(error, {
        extra: {
          githubUrl,
          commit,
          mcpId,
          stage: "git:clone",
        },
      });
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

    // Get the actual commit hash for storage
    if (!actualCommit) {
      try {
        const { stdout } = await execAsync("git rev-parse HEAD", {
          cwd: tempDir,
          shell: "/bin/bash",
        });
        actualCommit = stdout.trim();
        console.log(`Using actual commit hash: ${actualCommit}`);

        // Log if this is different from the requested commit
        if (commit && commit !== actualCommit && commit !== "latest") {
          console.log(
            `Note: Requested commit "${commit}" resolved to actual commit "${actualCommit}"`
          );
        }
      } catch (error) {
        console.warn("Failed to get actual commit hash:", error);
        // Generate a random hash if we can't get the actual commit
        actualCommit = crypto.randomBytes(20).toString("hex");
      }
    }

    // 2. NPM/bun install in either the cloned root or the subDir
    startTimer("npm:install");
    const installDir = subDir ? path.join(tempDir, subDir) : tempDir;
    try {
      // Install for all major platforms first
      const platforms = [
        { os: "darwin", cpu: "arm64" },
        { os: "darwin", cpu: "x64" },
        { os: "linux", cpu: "x64" },
        { os: "win32", cpu: "x64" },
        { os: "win32", cpu: "ia32" },
      ];

      for (const { os, cpu } of platforms) {
        try {
          await withTimeout(
            execAsync(
              `npm install --no-save --force --ignore-scripts --os=${os} --cpu=${cpu}`,
              {
                cwd: installDir,
                shell: "/bin/bash",
                env: {
                  ...process.env,
                  npm_config_platform: os,
                  npm_config_arch: cpu,
                  INIT_CWD: installDir,
                },
              }
            ),
            120000,
            `install ${os}-${cpu}`
          );
        } catch (err) {
          console.warn(`Failed to install for ${os}-${cpu}:`, err);
        }
      }

      // Then do regular install
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
        execAsync("bun run tsc --noEmitOnError false", {
          cwd: installDir,
          shell: "/bin/bash",
        }),
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

      // Try again with --noEmitOnError flag if the first attempt failed
      try {
        console.log(
          "Retrying TypeScript compilation with --noEmitOnError=false..."
        );
        await withTimeout(
          execAsync("npx tsc --noEmitOnError false", {
            cwd: installDir,
            shell: "/bin/bash",
          }),
          60000,
          "tsc compile with noEmitOnError=false"
        );
        console.log(
          "TypeScript compilation succeeded with noEmitOnError=false"
        );
      } catch (retryError) {
        console.warn(
          "TypeScript compilation still failed with noEmitOnError=false, continuing anyway"
        );
      }

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
          // Add Sentry error reporting with context
          Sentry.captureException(configError, {
            extra: {
              githubUrl,
              commit,
              mcpId,
              stage: "typescript:fix",
              installDir,
            },
          });
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
      "src/bin.ts",
      "src/server.ts",
    ];

    // Check if we need to run the build script first
    let ranBuild = false;
    try {
      const packageJsonPath = path.join(installDir, "package.json");
      const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(packageJsonContent);

      // If package has a build script and the entrypoint is in dist/, run the build script
      if (
        packageJson.scripts &&
        packageJson.scripts.build &&
        ((packageJson.bin &&
          typeof packageJson.bin === "object" &&
          Object.values(packageJson.bin).some((bin) =>
            String(bin).includes("dist/")
          )) ||
          (packageJson.bin &&
            typeof packageJson.bin === "string" &&
            packageJson.bin.includes("dist/")) ||
          (packageJson.main && packageJson.main.includes("dist/")))
      ) {
        console.log(
          "Found build script and dist/ entrypoint, running build script first..."
        );
        try {
          await withTimeout(
            execAsync("npm run build", { cwd: installDir, shell: "/bin/bash" }),
            300000, // 5 minute timeout for build
            "npm build"
          );
          console.log("Build script completed successfully");
          ranBuild = true;
        } catch (buildError) {
          console.warn("Build script failed:", buildError);
          // Try with bun as fallback
          try {
            await withTimeout(
              execAsync("bun run build", {
                cwd: installDir,
                shell: "/bin/bash",
              }),
              300000, // 5 minute timeout
              "bun build"
            );
            console.log("Build script completed successfully with bun");
            ranBuild = true;
          } catch (bunBuildError) {
            console.warn("Bun build script also failed:", bunBuildError);
          }
        }
      }
    } catch (error) {
      console.warn("Failed to check or run build script:", error);
      // Add Sentry error reporting with context
      Sentry.captureException(error, {
        extra: {
          githubUrl,
          commit,
          mcpId,
          stage: "build:script",
          installDir,
        },
      });
    }

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

        // First check bin field in package.json
        if (packageJson.bin) {
          let binPath = null;

          // bin can be a string or an object
          if (typeof packageJson.bin === "string") {
            binPath = packageJson.bin;
          } else if (typeof packageJson.bin === "object") {
            // If it's an object, take the first entry
            const firstBinKey = Object.keys(packageJson.bin)[0];
            if (firstBinKey) {
              binPath = packageJson.bin[firstBinKey];
            }
          }

          if (binPath) {
            // Convert the bin path to a relative path if needed
            const normalizedPath = binPath.startsWith("./")
              ? binPath.slice(2)
              : binPath;

            // Check if the file exists
            try {
              await fs.access(path.join(installDir, normalizedPath));
              entrypoint = normalizedPath;
              console.log(
                `Using entrypoint from package.json bin field: ${entrypoint}`
              );
            } catch (accessError) {
              console.warn(
                `Bin file ${normalizedPath} not found, continuing search`
              );
            }
          }
        }

        // If no bin or bin file not found, fall back to main field
        if (!entrypoint && packageJson.main) {
          // Convert the main field to a relative path if needed
          const mainPath = packageJson.main;
          const normalizedPath = mainPath.startsWith("./")
            ? mainPath.slice(2)
            : mainPath;

          // Check if the file exists
          try {
            await fs.access(path.join(installDir, normalizedPath));
            entrypoint = normalizedPath;
            console.log(
              `Using entrypoint from package.json main field: ${entrypoint}`
            );
          } catch (accessError) {
            console.warn(
              `Main file ${normalizedPath} not found, continuing search`
            );
          }
        }
      } catch (error) {
        console.warn("Failed to read or parse package.json:", error);
        // Add Sentry error reporting with context
        Sentry.captureException(error, {
          extra: {
            githubUrl,
            commit,
            mcpId,
            stage: "find:entrypoint:package.json",
            installDir,
          },
        });
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
              `--outfile bundle.mjs --target node --format esm --packages external`,
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
                `--bundle --platform=node --outfile=bundle.mjs --format=esm`,
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
                  `--bundle --platform=node --outfile=bundle.mjs --format=esm`,
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
          githubUrl,
          commit,
          mcpId,
          stage: "bundle:build",
          entrypoint,
          installDir,
        },
      });

      throw error;
    }

    // 5. Read the bundle file
    startTimer("read:bundle");
    const buildJsPath = path.join(installDir, `bundle.mjs`);
    let buildContent = await fs.readFile(buildJsPath, "utf-8");
    endTimer("read:bundle");

    const totalTime = endTimer("buildMCPServer:total");
    console.log(`Total build time: ${totalTime}ms`);

    // Log the raw bundle size
    const bundleSize = Buffer.byteLength(buildContent, "utf8");
    console.log(
      `Raw bundle size: ${bundleSize} bytes (${(
        bundleSize /
        (1024 * 1024)
      ).toFixed(2)} MB)`
    );

    // If we're using GCP upload, prepend the commit hash to the bundle content
    // so we can extract it reliably from the API response
    if (mcpId) {
      buildContent = `// COMMIT_HASH:${
        actualCommit || "unknown"
      }\n${buildContent}`;
    }

    // Create the archive regardless of whether we're uploading to GCP
    startTimer("archive:create");
    try {
      const nodeModulesDir = path.join(tempDir, "node_modules");
      const destModulesDir = path.join(installDir, "node_modules");

      // Skip if tempDir and installDir are the same (or if nodeModulesDir === destModulesDir)
      if (nodeModulesDir !== destModulesDir) {
        await fs.cp(nodeModulesDir, destModulesDir, {
          recursive: true,
        });
      } else {
        console.log(
          "Skipping node_modules copy: source and destination are the same"
        );
      }

      // Create tar.gz archive
      const archiveName = `bundle-${actualCommit}.tar.gz`;
      const archivePath = path.join(os.tmpdir(), archiveName);

      await createTarGzArchive(installDir, `bundle.mjs`, archivePath);

      // Get and log the archive size
      const archiveStats = await fs.stat(archivePath);
      const archiveSize = archiveStats.size;
      console.log(
        `Archive size: ${archiveSize} bytes (${(
          archiveSize /
          (1024 * 1024)
        ).toFixed(2)} MB)`
      );

      // If mcpId is provided, try to upload to GCP
      if (mcpId) {
        startTimer("gcp:upload");
        try {
          // Always use the actual commit hash, never fallback to "latest"
          if (!actualCommit) {
            // One last attempt to get the actual commit hash before uploading
            try {
              const { stdout } = await execAsync("git rev-parse HEAD", {
                cwd: tempDir,
                shell: "/bin/bash",
              });
              actualCommit = stdout.trim();
              console.log(
                `Using actual commit hash for upload: ${actualCommit}`
              );
            } catch (error) {
              console.warn(
                "Still failed to get actual commit hash before upload:",
                error
              );
              // Generate a random hash if we can't get the actual commit
              actualCommit = crypto.randomBytes(20).toString("hex");
              console.log(`Generated random hash for upload: ${actualCommit}`);
            }
          }

          const archiveUrl = await uploadToGCPBucket(
            archivePath,
            mcpId,
            actualCommit
          );
          console.log(`Uploaded archive to: ${archiveUrl}`);

          const uploadDuration = endTimer("gcp:upload");
          console.log(`GCP upload completed in ${uploadDuration}ms`);
        } catch (uploadError) {
          console.error("Failed to upload to GCP bucket:", uploadError);
          // Don't fail the build if upload fails, just log the error
          Sentry.captureException(uploadError, {
            extra: {
              githubUrl,
              commit: actualCommit,
              mcpId,
              stage: "gcp:upload",
            },
          });
        }
      } else {
        // If mcpId is not provided, save a copy to the bundled directory
        startTimer("local:copy");
        try {
          // Ensure bundled directory exists
          const bundledDir = path.join(process.cwd(), "bundled");
          try {
            await fs.mkdir(bundledDir, { recursive: true });
          } catch (mkdirError) {
            console.log("bundled directory already exists");
          }

          // Copy the archive file to the bundled directory
          const bundledFilePath = path.join(bundledDir, archiveName);
          await fs.copyFile(archivePath, bundledFilePath);
          console.log(`Saved archive to: ${bundledFilePath}`);
        } catch (copyError) {
          console.error(
            "Failed to save archive to bundled directory:",
            copyError
          );
          Sentry.captureException(copyError, {
            extra: {
              githubUrl,
              commit: actualCommit,
              stage: "local:copy",
            },
          });
        }
        endTimer("local:copy");
      }

      // Clean up the archive file from temp directory
      await fs.unlink(archivePath);
    } catch (archiveError) {
      console.error("Failed to create or handle archive:", archiveError);
      // Don't fail the build if archiving fails, just log the error
      Sentry.captureException(archiveError, {
        extra: {
          githubUrl,
          commit: actualCommit,
          mcpId,
          stage: "archive:create",
        },
      });
    }
    endTimer("archive:create");

    // Print a marker right before returning to ensure it's captured in the output
    if (actualCommit) {
      console.log(`COMMIT_HASH_FOR_RESPONSE:${actualCommit}`);
    }

    // Return both the bundled code and the actual commit hash
    if (!mcpId) {
      return {
        data: buildContent,
        actualCommit: actualCommit || "latest",
      };
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
        mcpId,
        stage: "buildMCPServer",
        timers: Array.from(perfMarkers.entries()),
      },
    });

    throw new Error("Failed to build the server code.");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
