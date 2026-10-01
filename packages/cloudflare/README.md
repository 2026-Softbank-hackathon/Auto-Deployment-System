# Cloudflare API client

`@camellia/cloudflare` owns the platform-side Cloudflare operations used by the deployment flow:

- find or create the platform DNS Zone;
- find or create one remotely managed Named Tunnel per service;
- retrieve its connector token for an authenticated Agent job;
- set the tunnel ingress origin after the Agent has a local service URL;
- create/update CNAME records for verification hosts and the stable service hostname.

The client receives `accountId` and `apiToken` through its constructor. The caller is responsible for loading them from runtime configuration; neither is read from source-controlled files. The token value is returned only by `getTunnelToken` and must be sent to the authenticated Agent through the existing secret-safe control-plane path. Do not log it or put it in public deployment events.

`ensureZone` may return a `pending` Zone and its assigned nameservers. A full Zone becomes active only after the domain's registrar delegates to those nameservers. DNS writes should be attempted only when the Zone/account is ready for them.

The stable hostname and a candidate verification hostname are both managed with `ensureCname`. Deploy orchestration should verify the candidate hostname first, then call `switchServiceOrigin`; this method changes only the stable CNAME, so a failed candidate check leaves the previous origin untouched.

The Agent's Tunnel provider and control-plane job payload are integrated separately. This package does not start `cloudflared` and does not persist credentials or deployment state.
