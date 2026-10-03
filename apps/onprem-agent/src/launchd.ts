export type LaunchAgentPlistInput = {
  executablePath: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchAgentPlist(input: LaunchAgentPlistInput): string {
  const executablePath = escapeXml(input.executablePath);
  const workingDirectory = escapeXml(input.workingDirectory);
  const stdoutPath = escapeXml(input.stdoutPath);
  const stderrPath = escapeXml(input.stderrPath);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.camellia.onprem-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executablePath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workingDirectory}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ONPREM_AGENT_HEARTBEAT_INTERVAL_MS</key>
    <string>2000</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${stdoutPath}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
</dict>
</plist>
`;
}
