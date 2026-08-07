# Quickstart — 5 Minutes to Running Agent

## Prerequisites

- **Node.js 24** (`nvm use` will pick up `.nvmrc`)
- **Docker Engine 24+** with Compose v2
- **git**

## 1. Clone and Install

```bash
git clone https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents.git
cd The-Kubernetes-of-AI-Agents
npm install
```

## 2. Configure Environment

```bash
cp .env.example .env
# Generate secrets (required):
openssl rand -hex 32    # paste into JWT_SECRET, EGAOP_MASTER_ENCRYPTION_KEY, INTERNAL_SERVICE_TOKEN
openssl rand -base64 32 # paste into POSTGRES_PASSWORD, GRAFANA_PASSWORD
# Set at least one LLM key:
#   OPENAI_API_KEY=sk-...
```

## 3. Start Everything

```bash
docker compose up -d
# Wait ~60s for migrations + Temporal to initialise
docker compose ps  # all services should be "healthy"
```

## 4. Register a User

```bash
curl -s -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"changeme123"}' | jq .
```

## 5. Get a JWT Token

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"dev@example.com","password":"changeme123"}' | jq -r '.token')
echo $TOKEN
```

## 6. Create an Agent

```bash
curl -s -X POST http://localhost:3001/api/v1/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hello-agent",
    "spec": {
      "runtime": { "isolationLevel": "enhanced", "resources": { "cpu": "500m" } },
      "llm": { "allowedModels": ["gpt-4o"], "defaultModel": "gpt-4o" },
      "tools": [],
      "policies": []
    }
  }' | jq .
```

## 7. Run the Agent

```bash
AGENT_ID=$(curl -s http://localhost:3001/api/v1/agents \
  -H "Authorization: Bearer $TOKEN" | jq -r '.agents[0].id')

curl -s -X POST http://localhost:3001/api/v1/agents/${AGENT_ID}/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Say hello in one sentence"}' | jq .
```

## 8. View Dashboards

| Service       | URL                                  | Credentials              |
|---------------|--------------------------------------|--------------------------|
| Grafana       | http://localhost:3003                 | admin / (GRAFANA_PASSWORD) |
| Swagger (API) | http://localhost:3001/api/docs        | Bearer token              |
| Temporal UI   | http://localhost:8080                 | —                        |

## 9. Stop Services

```bash
docker compose down -v   # -v removes volumes (clean slate)
```

## Troubleshooting

- **Port conflict**: `docker compose down` first, then check nothing else is on ports 3001/50051/3003.
- **Temporal not ready**: Give it 2 minutes; check `docker compose logs temporal`.
- **mTLS error**: Expected — mTLS is disabled by default. See `docs/troubleshooting.md`.
