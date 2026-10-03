#!/usr/bin/env node
import { CliError } from "../src/http.mjs";
import { main } from "../src/run.mjs";

// process.exit() 대신 exitCode — Windows 에서 fetch 핸들이 남은 채 강제 종료하면 비정상 종료 코드가 나올 수 있다
try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  } else {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
