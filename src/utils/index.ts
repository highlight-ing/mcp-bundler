import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import os from "os";
import crypto from "crypto";
import { Storage } from "@google-cloud/storage";

export const execAsync = promisify(exec);

// Performance tracking
export const perfMarkers = new Map<string, number>();

export function startTimer(label: string) {
  perfMarkers.set(label, Date.now());
  console.log(`[PERF] Starting ${label}`);
}

export function endTimer(label: string) {
  const start = perfMarkers.get(label);
  if (start) {
    const duration = Date.now() - start;
    console.log(`[PERF] ${label} completed in ${duration}ms`);
    perfMarkers.delete(label);
    return duration;
  }
  return 0;
}

// Timeout wrapper for any promise
export async function withTimeout<T>(
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

// Parse GitHub monorepo URL
export function parseMonorepoUrl(githubUrl: string): {
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

// Create a tar.gz archive of the bundled server
export async function createTarGzArchive(
  sourceDir: string,
  bundleFile: string,
  outputPath: string
): Promise<string> {
  startTimer("tar:compress");

  try {
    // Create a temporary directory for the files to be included in the archive
    const archiveDir = path.join(
      os.tmpdir(),
      `archive-${crypto.randomBytes(8).toString("hex")}`
    );
    await fs.mkdir(archiveDir, { recursive: true });

    // Copy the bundle file to the archive directory
    const bundleFilePath = path.join(sourceDir, bundleFile);
    const bundleDestPath = path.join(archiveDir, bundleFile);
    await fs.copyFile(bundleFilePath, bundleDestPath);

    // Copy node_modules if it exists
    const nodeModulesPath = path.join(sourceDir, "node_modules");
    try {
      await fs.access(nodeModulesPath);

      // Create node_modules directory in the archive directory
      const nodeModulesDestPath = path.join(archiveDir, "node_modules");
      await fs.mkdir(nodeModulesDestPath, { recursive: true });

      // Use tar directly to copy node_modules (faster than recursive copy)
      await execAsync(
        `tar -cf - -C "${sourceDir}" node_modules | tar -xf - -C "${archiveDir}"`,
        {
          shell: "/bin/bash",
        }
      );

      console.log("Copied node_modules to archive directory");
    } catch (error) {
      console.warn("node_modules directory not found, skipping");
    }

    // Create the tar.gz archive
    await execAsync(`tar -czf "${outputPath}" -C "${archiveDir}" .`, {
      shell: "/bin/bash",
    });

    console.log(`Created tar.gz archive at ${outputPath}`);

    // Clean up the temporary directory
    await fs.rm(archiveDir, { recursive: true, force: true });

    const duration = endTimer("tar:compress");
    console.log(`Tar.gz compression completed in ${duration}ms`);

    return outputPath;
  } catch (error) {
    endTimer("tar:compress");
    console.error("Error creating tar.gz archive:", error);
    throw new Error(
      `Failed to create tar.gz archive: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

// Upload files to GCP bucket
export async function uploadToGCPBucket(
  sourcePath: string,
  mcpId: string,
  commitId: string
): Promise<string> {
  let storage;

  try {
    // Check if GOOGLE_APPLICATION_CREDENTIALS contains JSON content (from GCP_SERVICE_ACCOUNT_KEY)
    if (
      process.env.GOOGLE_APPLICATION_CREDENTIALS &&
      process.env.GOOGLE_APPLICATION_CREDENTIALS.includes(
        '"type": "service_account"'
      )
    ) {
      try {
        // Parse the JSON content directly from the environment variable
        const credentials = JSON.parse(
          process.env.GOOGLE_APPLICATION_CREDENTIALS
        );
        storage = new Storage({
          projectId: credentials.project_id,
          credentials: credentials,
        });
      } catch (jsonError) {
        console.error(
          "Failed to parse credentials from environment variable:",
          jsonError
        );
        throw new Error("Could not initialize GCP Storage client");
      }
    } else {
      // Fall back to default credentials if GCP_SERVICE_ACCOUNT_KEY was not provided
      // This will work if Application Default Credentials are available
      storage = new Storage();
    }

    const bucketName = "bundler-microservice-servers";
    const bucket = storage.bucket(bucketName);

    // Create base destination path in the format: $MCP_ID/$GITHUB_COMMIT/
    const baseDestPath = `${mcpId}/${commitId}`;

    // For tar.gz archives, upload as a single file
    const fileName = path.basename(sourcePath);
    const destPath = `${baseDestPath}/${fileName}`;

    await bucket.upload(sourcePath, {
      destination: destPath,
      gzip: false, // Already compressed
    });

    console.log(
      `Uploaded archive ${sourcePath} to gs://${bucketName}/${destPath}`
    );

    return `gs://${bucketName}/${destPath}`;
  } catch (error) {
    console.error("Error uploading to GCP:", error);
    throw error;
  }
}

// Set up GCP credentials
export async function setupGCPCredentials() {
  // Check if GCP integration is disabled
  if (process.env.DISABLE_GCP_INTEGRATION === "true") {
    console.log("GCP integration is disabled by environment variable");
    return;
  }

  try {
    // Check if we have GCP credentials directly in an environment variable
    if (process.env.GCP_SERVICE_ACCOUNT_KEY) {
      // Store the credentials directly in GOOGLE_APPLICATION_CREDENTIALS
      process.env.GOOGLE_APPLICATION_CREDENTIALS =
        process.env.GCP_SERVICE_ACCOUNT_KEY;
      console.log(
        "Using GCP credentials from GCP_SERVICE_ACCOUNT_KEY environment variable"
      );
      return;
    }

    console.warn("No GCP credentials found. GCP operations may fail.");
  } catch (error) {
    console.error("Error setting up GCP credentials:", error);
  }
}
