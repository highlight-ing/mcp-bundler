# MCP Bundler Service

A microservice that bundles code from GitHub repositories and prepares it for deployment. It supports direct return of bundled code or uploading to Google Cloud Storage.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the development server
pnpm run dev

# Access the API documentation
open http://localhost:8080/docs
```

## API Documentation

Interactive API documentation is available at `/docs` when the server is running.

## Core Endpoints
### Index Route
```
GET /
```
Returns a static HTML page with information about the service.

### Health Check
```
GET /health
```
Returns a simple status check to verify the service is running.

### V1 Bundler (Legacy)
```
GET /bundler?url=<github_url>&commit=<commit_hash>&format=<mjs|cjs>
```

**Parameters:**
- `url` (required): GitHub repository URL
- `commit` (optional): Specific commit hash to use (defaults to latest)
- `format` (optional): Output format - `mjs` (default) or `cjs`

**Response:**
```json
{
  "data": "<bundled code as string>"
}
```

### V2 Bundler (with optional GCP Upload)
```
GET /v2/bundler?url=<github_url>&commit=<commit_hash>&mcpId=<your_mcp_id>
```

**Parameters:**
- `url` (required): GitHub repository URL
- `commit` (optional): Specific commit hash to use (defaults to latest)
- `mcpId` (optional): Unique identifier for your bundled server (auto-generated if not provided)

**GCP Upload Enabled Response:**
```json
{
  "success": true,
  "gcp_upload": {
    "bucket": "bundler-microservice-servers",
    "path": "your-mcp-id/commit-hash/",
    "files": [
      "bundle-commit-hash.tar.gz"
    ]
  }
}
```

**GCP Upload Disabled Response:**
```json
{
  "success": true,
  "data": "<bundled code as string>"
}
```

## GCP Integration (Optional)

The V2 bundler can upload bundled code to Google Cloud Storage for use with other services, or return it directly if GCP integration is disabled.

### Disabling GCP Upload

If you want to disable GCP uploads and get the bundled code directly in the response, set:

```
DISABLE_GCP_INTEGRATION=true
```

in your environment or `.env` file. When GCP integration is disabled:

1. The bundled code is returned directly in the API response
2. A copy of the bundled code archive is saved to the `bundled` directory in the project root
3. The archive filename follows the format `bundle-[commit-hash].tar.gz`

### Setting Up GCP Credentials

If you want to use GCP uploads, you need to provide your Google Cloud Platform credentials:

Add your service account key JSON directly to the `.env` file:

```
GCP_SERVICE_ACCOUNT_KEY={"type": "service_account", "project_id": "your-project-id", ...}
```

This is the recommended option for development and CI/CD environments.

### Required Permissions

Create a service account with `Storage Admin` permissions for the bucket `bundler-microservice-servers`.

## Deployment

The service includes a Dockerfile for containerized deployment:

```bash
# Build the Docker image
docker build -t mcp-bundler .

# Run the container
docker run -p 8080:8080 -e GCP_SERVICE_ACCOUNT_KEY='{"type":"service_account",...}' mcp-bundler
```

### Cloud Run Deployment

For Google Cloud Run deployment, set the `GCP_SERVICE_ACCOUNT_KEY` environment variable with your service account credentials JSON.

## Error Handling

All endpoints include comprehensive error responses with appropriate HTTP status codes:

- `400`: Invalid input parameters
- `500`: Server-side errors
- `504`: Timeout errors (typically for large repositories or complex dependencies)

## Features

- **GitHub Integration**: Bundle code directly from any public GitHub repository
- **Format Options**: Output in either ESM (mjs) or CommonJS (cjs) format
- **Commit Pinning**: Specify exact commit hashes for reproducible builds
- **GCP Storage**: Optional upload of bundled code to Google Cloud Storage for further deployment
- **Swagger Documentation**: Interactive API documentation with Swagger UI
- **Error Handling**: Comprehensive error reporting with appropriate status codes

## Limitations

- Repository bundling has a 5-minute timeout
- Large WASM files might exceed processing limits

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GCP_SERVICE_ACCOUNT_KEY` | GCP service account credentials JSON | - |
| `DISABLE_GCP_INTEGRATION` | Set to "true" to disable GCP uploads | - |
| `SENTRY_INGEST_URL` | Sentry ingest URL | - |

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
```