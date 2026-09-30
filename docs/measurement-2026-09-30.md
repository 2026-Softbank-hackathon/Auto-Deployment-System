# 실제 IR 도출 측정 보고서 (2026-09-30)

## 환경
- Postgres: camellia-postgres:5433
- Model: claude-sonnet-4-6
- Anthropic API Key: sk-ant-a***
- 측정 시각: 2026-09-30T05:39:04.244Z

## 요약

| Fixture | zip 크기 | 총 시간 | AI 호출 | 입력 tokens | 출력 tokens | 비용 USD | IR valid |
|---|---|---|---|---|---|---|---|
| Express | 0.7 KB | 4.12s | Y | 1,306 | 64 | $0.024390 | ✓ |
| Python FastAPI | 0.4 KB | 3.60s | Y | 1,315 | 64 | $0.024525 | ✓ |
| Node + Postgres | 0.9 KB | 4.07s | Y | 1,376 | 64 | $0.025440 | ✓ |
| MSA | 1.3 KB | 4.58s | Y | 1,469 | 84 | $0.028335 | ✓ |
| **합계** | | | 4/4 | 5,466 | 276 | **$0.102690** | |

## 감지 결과 상세

### Fixture 1: Express

- 감지된 서비스: 1개
  - express-basic: language=node, framework=express, port=3000, env_names=0개 []
- 리소스: 0개
- Warnings: 0개
- Unresolved (규칙 후): 0개
- IR source: ai_filled
- IR valid: true

### Fixture 2: Python FastAPI

- 감지된 서비스: 1개
  - camellia-stage-a7850ddfb9ac: language=python, framework=fastapi, port=8000, env_names=0개 []
- 리소스: 0개
- Warnings: 0개
- Unresolved (규칙 후): 0개
- IR source: ai_filled
- IR valid: true

### Fixture 3: Node + Postgres

- 감지된 서비스: 1개
  - node-postgres: language=node, framework=express, port=8080, env_names=2개 [DATABASE_URL, NODE_ENV]
- 리소스: 1개 (postgres)
- Warnings: 0개
- Unresolved (규칙 후): 0개
- IR source: ai_filled
- IR valid: true

### Fixture 4: MSA

- 감지된 서비스: 2개
  - msa-api: language=node, framework=express, port=3000, env_names=0개 []
  - msa-worker: language=node, framework=-, port=-, env_names=0개 []
- 리소스: 0개
- Warnings: 0개
- Unresolved (규칙 후): 1개
  - {"path":"services.<name>.port","reason":"No .listen(<port>) 
- IR source: ai_filled
- IR valid: true

## AI 사용 상세

| 배포 ID | fixture | model | in tokens | out tokens | cache creation | cache read | cost USD |
|---|---|---|---|---|---|---|---|
| 1 | Express | claude-opus-4-5 | 1,306 | 64 | 0 | 0 | $0.024390 |
| 2 | Python FastAPI | claude-opus-4-5 | 1,315 | 64 | 0 | 0 | $0.024525 |
| 3 | Node + Postgres | claude-opus-4-5 | 1,376 | 64 | 0 | 0 | $0.025440 |
| 4 | MSA | claude-opus-4-5 | 1,469 | 84 | 0 | 0 | $0.028335 |

## 최종 IR JSON (부록)

### Express

```json
{
  "deploy": {
    "profile": "aws-ecs-basic"
  },
  "metadata": {
    "name": "express-basic",
    "version": "1.0.0"
  },
  "services": {
    "express-basic": {
      "port": 3000,
      "size": "small",
      "type": "http",
      "build": {
        "dockerfile": "Dockerfile"
      },
      "expose": "public",
      "health": {
        "path": "/health",
        "expected_status": 200,
        "timeout_seconds": 3
      },
      "command": [
        "node",
        "server.js"
      ]
    }
  },
  "$ir_version": "0.1.0"
}
```

### Python FastAPI

```json
{
  "deploy": {
    "profile": "aws-ecs-basic"
  },
  "metadata": {
    "name": "camellia-stage-a7850ddfb9ac",
    "version": "0.0.1"
  },
  "services": {
    "camellia-stage-a7850ddfb9ac": {
      "port": 8000,
      "size": "small",
      "type": "http",
      "expose": "public",
      "health": {
        "path": "/health",
        "expected_status": 200,
        "timeout_seconds": 3
      },
      "command": [
        "uvicorn",
        "main:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8000"
      ]
    }
  },
  "$ir_version": "0.1.0"
}
```

### Node + Postgres

```json
{
  "deploy": {
    "profile": "aws-ecs-basic"
  },
  "metadata": {
    "name": "node-postgres",
    "version": "0.1.0"
  },
  "services": {
    "node-postgres": {
      "env": [
        "DATABASE_URL",
        "NODE_ENV"
      ],
      "port": 8080,
      "size": "small",
      "type": "http",
      "build": {
        "dockerfile": "Dockerfile"
      },
      "expose": "public",
      "health": {
        "path": "/health",
        "expected_status": 200,
        "timeout_seconds": 3
      },
      "command": [
        "node",
        "server.js"
      ]
    }
  },
  "resources": {
    "db": {
      "type": "postgres"
    }
  },
  "$ir_version": "0.1.0"
}
```

### MSA

```json
{
  "deploy": {
    "profile": "aws-ecs-basic"
  },
  "metadata": {
    "name": "msa-api",
    "version": "0.0.1"
  },
  "services": {
    "msa-api": {
      "port": 3000,
      "size": "small",
      "type": "http",
      "build": {
        "dockerfile": "Dockerfile"
      },
      "expose": "public",
      "health": {
        "path": "/health",
        "expected_status": 200,
        "timeout_seconds": 3
      },
      "command": [
        "node",
        "server.js"
      ]
    },
    "msa-worker": {
      "size": "small",
      "type": "worker",
      "build": {
        "dockerfile": "Dockerfile"
      },
      "expose": "public",
      "health": {
        "path": "/health",
        "expected_status": 200,
        "timeout_seconds": 3
      },
      "command": [
        "node",
        "worker.js"
      ]
    }
  },
  "$ir_version": "0.1.0"
}
```

## 인사이트

- 분석 성공: 4/4 fixture
- IR valid: 4/4 fixture
- AI 호출: 4/4 fixture에서 AI가 unresolved 필드 채움
- 비용 효율: AI 호출 1회당 평균 $0.025673 (하루 100회면 $2.5673 예상)
- 평균 분석 시간: 4.09s
- 실패 시나리오: 없음
- 감지 정확도: 4/4 IR valid
