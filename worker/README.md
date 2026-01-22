# Numerai API Proxy - Cloudflare Worker

A Cloudflare Worker that proxies requests to the Numerai GraphQL API with authentication, CORS handling, and rate limiting.

## Features

- **GraphQL Proxy**: Proxies requests to `https://api-tournament.numer.ai/graphql`
- **Authentication**: Injects Numerai API credentials from Cloudflare secrets
- **CORS**: Configurable allowed origins for cross-origin requests
- **Rate Limiting**: Configurable rate limiting using Cloudflare KV (optional)
- **Health Check**: Simple health endpoint for monitoring

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/graphql` | Proxy GraphQL queries to Numerai API |
| GET | `/health` | Health check endpoint |

## Supported GraphQL Queries

The proxy supports all Numerai GraphQL queries. Common ones include:

### v2Leaderboard
Search users and view leaderboard:
```graphql
query {
  v2Leaderboard(limit: 10, offset: 0, orderBy: "rank", direction: "asc") {
    username
    rank
    nmrStaked
  }
}
```

### accountProfile
Get user's models:
```graphql
query {
  accountProfile(username: "example_user", tournament: 8) {
    username
    models {
      id
      name
      nmrStaked
    }
  }
}
```

### v2RoundModelPerformances
Get model performance history:
```graphql
query {
  v2RoundModelPerformances(modelId: "model_uuid", tournament: 8, lastNRounds: 20) {
    roundNumber
    corr
    corr20
    corr20Percentile
    mmc
    tc
  }
}
```

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)
- Numerai API credentials

### Installation

```bash
cd worker
npm install
```

### Configure Secrets

Set your Numerai API credentials as Cloudflare secrets:

```bash
# Set public key
wrangler secret put NUMERAI_PUBLIC_KEY
# Enter your public key when prompted

# Set secret key
wrangler secret put NUMERAI_SECRET_KEY
# Enter your secret key when prompted
```

### Configure KV for Rate Limiting (Optional)

Create a KV namespace for rate limiting:

```bash
# Create the namespace
wrangler kv:namespace create "RATE_LIMIT"

# Note the id from the output, then add to wrangler.toml:
# [[kv_namespaces]]
# binding = "RATE_LIMIT"
# id = "<your-kv-namespace-id>"
```

### Configure Custom Domain (Optional)

To use a custom domain like `numerdiff.imperialai.ai`:

1. Ensure your domain is added to Cloudflare
2. Uncomment and update the routes section in `wrangler.toml`:

```toml
routes = [
  { pattern = "numerdiff.imperialai.ai/*", zone_name = "imperialai.ai" }
]
```

3. Deploy the worker

## Development

### Local Development

```bash
npm run dev
```

This starts a local development server at `http://localhost:8787`.

### Testing the API

```bash
# Health check
curl http://localhost:8787/health

# GraphQL query
curl -X POST http://localhost:8787/graphql \
  -H "Content-Type: application/json" \
  -d '{"query": "{ v2Leaderboard(limit: 5) { username rank } }"}'
```

## Deployment

### Deploy to Cloudflare

```bash
npm run deploy
```

### View Logs

```bash
npm run tail
```

## Configuration

### Environment Variables

Set in `wrangler.toml` under `[vars]`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated list of allowed CORS origins |
| `RATE_LIMIT_REQUESTS` | `100` | Maximum requests per window |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit window in seconds |
| `NUMERAI_API_URL` | `https://api-tournament.numer.ai/graphql` | Numerai API endpoint |

### Secrets

Set via `wrangler secret put`:

| Secret | Description |
|--------|-------------|
| `NUMERAI_PUBLIC_KEY` | Your Numerai API public key |
| `NUMERAI_SECRET_KEY` | Your Numerai API secret key |

## Response Headers

The proxy adds rate limit headers to all responses:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed per window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

## Error Responses

| Status | Description |
|--------|-------------|
| 400 | Invalid request (malformed JSON or missing query) |
| 404 | Unknown endpoint |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

## Architecture

```
┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   SvelteKit     │────>│  Cloudflare Worker  │────>│   Numerai API   │
│   Frontend      │<────│  (numerai-api-proxy)│<────│   (GraphQL)     │
└─────────────────┘     └─────────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │  KV Store   │
                        │ (Rate Limit)│
                        └─────────────┘
```

## License

MIT
