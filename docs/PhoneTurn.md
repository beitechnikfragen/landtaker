# Phone: TURN server configuration

The in-game phone (`src/client/phone/PhoneTransport.ts`) uses WebRTC for
peer-to-peer voice. By default it only configures STUN (Google's public
servers), which is enough to connect most players but fails ICE negotiation
for players behind strict/symmetric NATs — confirmed in production: signaling
completes fine (offer/answer, `ontrack` fires on both sides) but
`connectionState` goes `connecting -> failed` because no direct or
server-reflexive path exists. TURN relays media for exactly that case.

## What to configure

Three env vars, read at build time via `vite.config.ts`'s `define` (same
mechanism as `API_DOMAIN`) and exposed through `ClientEnv.phoneTurnUrls()` /
`phoneTurnUsername()` / `phoneTurnCredential()`:

| Variable                | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `PHONE_TURN_URLS`       | Comma-separated TURN/TURNS URL(s), e.g. `turn:a.relay.metered.ca:80,turns:a.relay.metered.ca:443` |
| `PHONE_TURN_USERNAME`   | TURN username                                                                                     |
| `PHONE_TURN_CREDENTIAL` | TURN credential/password                                                                          |

All three are optional. If any is absent or blank (including whitespace-only),
the ICE server list falls back to STUN-only, exactly as before — no crash, no
malformed entry.

## Setting it up (Metered example)

1. Sign up at https://www.metered.ca/tools/openrelay/ (or any hosted TURN
   provider — Cloudflare Calls TURN works the same way). The free tier is
   500MB/month of relayed traffic.
2. Create a TURN app/credential in their dashboard. You'll get a URL (or a
   few, e.g. UDP + TCP + TLS variants), a username, and a credential.
3. Paste them into your deploy environment (`.env`, CI secret, etc.) as
   `PHONE_TURN_URLS`, `PHONE_TURN_USERNAME`, `PHONE_TURN_CREDENTIAL`.
4. Rebuild the client (`npm run build-prod`, or restart `npm run dev` — these
   are build-time `define` values, so a running dev server won't pick up
   changes without a restart).
5. Open the browser console during a phone call and look for:
   ```
   [phone] ICE config: 3 server(s), TURN=present
   ```
   `3 server(s)` = 2 STUN + 1 TURN entry (more if you supplied multiple TURN
   URLs). This confirms the deploy picked up the config. If it still says
   `TURN=absent`, one of the three vars was blank at build time.

## These credentials are public — and that's normal

`PHONE_TURN_URLS`/`USERNAME`/`CREDENTIAL` ship inside the client JS bundle,
same as any other `define`-injected value — anyone can view-source them. This
is expected for browser WebRTC TURN and is why providers issue **rotating /
ephemeral** credentials (typically short-lived, HMAC-derived, valid for a
limited window) rather than a permanent static username/password pair.

A long-lived static credential, if scraped, can be abused as a free open
relay by anyone, not just this game's players. Prefer your provider's
ephemeral-credential flow (an endpoint that mints a short-lived
username/credential pair per request) if they offer one, instead of hardcoding
a permanent pair into `PHONE_TURN_USERNAME`/`PHONE_TURN_CREDENTIAL`. Metered
and Cloudflare Calls both support this; wiring it up is a bigger change (a
small backend endpoint the client calls before creating each `RTCPeerConnection`)
and is not implemented here — static credentials via the env vars above are
the v1 approach.

## Optional: force relay-only (hides player IPs, costs more)

Setting `PHONE_TURN_FORCE_RELAY=true` sets `iceTransportPolicy: "relay"` on
every `RTCPeerConnection`, meaning ICE will _only_ use the TURN relay path —
it skips host/STUN candidates entirely. Two effects:

- **Privacy**: peers never learn each other's real IP address (normal WebRTC,
  even with STUN, exposes both sides' public IP in ICE candidates).
- **Cost**: 100% of call audio is relayed through the paid TURN service
  instead of TURN being used only as a fallback for the players who need it.

This is a one-line env flip (`PHONE_TURN_FORCE_RELAY=true` + rebuild) and is
**off by default**. Only enable it if the privacy property is worth the extra
relay traffic for every call, not just the ones that would otherwise fail.
