import { renderLaunchAgentPlist } from "./launchd.js";

const [executablePath, workingDirectory, stdoutPath, stderrPath] =
  process.argv.slice(2);

if (!executablePath || !workingDirectory || !stdoutPath || !stderrPath) {
  process.stderr.write(
    "사용법: launchd-cli <executable> <working-directory> <stdout> <stderr>\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    renderLaunchAgentPlist({
      executablePath,
      workingDirectory,
      stdoutPath,
      stderrPath,
    }),
  );
}
