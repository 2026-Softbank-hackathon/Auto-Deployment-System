# camellia CLI

Deploy apps and check their status from the terminal. The CLI fetches its command list from the server (`GET /api/v1/cli/manifest`) on every run, so new commands added to the console API show up without reinstalling the CLI. Commands are defined in `apps/api/src/cli/manifest.ts`.

Requires Node.js 20 or later. No other packages are needed.

## Install

```sh
npm install -g ./apps/cli      # from the repository root
camellia --version
```

You can also run it without installing: `node apps/cli/bin/camellia.mjs <command>`.

## Log in

```sh
camellia login
```

Log in with your console account. The CLI stores a 30-day token in `~/.camellia/config.json`, never the password. Use `--url <url>` for another server.

## Common commands

```sh
camellia apps list
camellia apps create shop --subdomain shop
camellia deploy shop ./my-app              # zips the folder, uploads it and watches until it finishes
camellia deploy shop ./my-app --to onprem-mymac
camellia switch shop --to aws-ap-northeast-2-team   # move the live version to another connection
camellia deployments shop
camellia logs 123 --step build --tail 50
camellia env set shop API_URL https://example.com
camellia help                              # every command the server provides
```

Global flags: `--json` (raw response), `--yes` (skip confirmation), `--help`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Request failed or invalid input |
| 2 | Login required or token expired |
| 3 | Deployment failed or was cancelled |
