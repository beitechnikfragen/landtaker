# Phone: TURN server configuration

The in-game phone (`src/client/phone/PhoneTransport.ts`) uses WebRTC for
peer-to-peer voice. STUN alone (Google's public servers) connects most
players but fails ICE negotiation for players behind strict/symmetric NATs —
confirmed in production: signaling completes fine (offer/answer, `ontrack`
fires on both sides) but `connectionState` goes `connecting -> failed`
because no direct or server-reflexive path exists. TURN relays media for
exactly that case.

This deployment self-hosts TURN via [coturn](https://github.com/coturn/coturn)
as a fourth Coolify service (`docker-compose.coolify.yml`), rather than
paying a hosted provider. The free tier of most hosted TURN providers is
around 500MB/month — roughly 14 call-hours (see traffic estimate below) —
which is far too small for real use; self-hosting means you only pay your
existing server's bandwidth.

## How it fits together

1. **`coturn`** (docker-compose service) is the relay itself. It knows one
   secret (`TURN_STATIC_AUTH_SECRET`) and never talks to the browser directly
   for credentials — it only relays media for whoever presents a valid
   HMAC-signed username/credential pair.
2. **`backend`** mints those short-lived credentials on demand:
   `GET /phone/turn-credentials?clientId=<id>` returns a username/credential
   pair valid for a few hours, computed with coturn's REST API scheme
   (`username = "<unix-expiry>:<clientId>"`,
   `credential = base64(HMAC-SHA1(username, TURN_STATIC_AUTH_SECRET))`). The
   static secret itself never leaves the backend. See
   `backend/src/services/turnCredentials.ts` and `backend/src/routes/turn.ts`.
3. **`PhoneTransport`** fetches this endpoint once per browser tab (cached
   for the credential's lifetime) before the first `RTCPeerConnection` is
   created, and uses the result as the TURN entry in the ICE server list.

## Setting it up in Coolify

Add to the stack's environment variables (Coolify UI, applies to the whole
`docker-compose.coolify.yml` stack — same place as `DOMAIN`, `API_KEY`, etc.):

| Variable                  | Value                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `TURN_STATIC_AUTH_SECRET` | long random string. Shared between `coturn` and `backend` — set it once, both services read the same var. |
| `TURN_URLS`               | `turn:yourdomain.tld:3478` (comma-separated if you add more, e.g. a TLS variant on 5349)                  |

Both are optional. Leave them unset and the stack behaves exactly as before
self-hosted TURN existed: `coturn`'s command line still requires
`TURN_STATIC_AUTH_SECRET` to be non-empty to start meaningfully, and the
backend answers `/phone/turn-credentials` with an empty/STUN-only shaped body
whenever the secret or `TURN_URLS` is blank — no error, the client just falls
back to STUN-only.

## Firewall

`coturn` runs with `network_mode: host` (see the comment in
`docker-compose.coolify.yml` for why — Docker's per-port NAT mapping does not
forward the relay's large UDP port range reliably; host networking is the
standard coturn deployment shape). That means the ports are **not** proxied
by Coolify/Traefik — open them directly on the host firewall:

| Port          | Protocol | Purpose                                                        |
| ------------- | -------- | -------------------------------------------------------------- |
| `3478`        | UDP      | TURN listener (client <-> coturn signaling/allocate)           |
| `3478`        | TCP      | TURN listener, TCP fallback (rare, but coturn listens on both) |
| `49160-49200` | UDP      | Relay ports — actual media flows through these                 |

The relay range is deliberately narrow (41 ports = 41 concurrent
relayed call-legs) so the firewall rule stays a single small range instead of
the IANA default (49152-65535, ~16k ports). Widen `--min-port`/`--max-port`
in the `coturn` service command in `docker-compose.coolify.yml` (and the
matching firewall rule) only if you're routinely hitting that ceiling.

## Verifying it works

1. Deploy with `TURN_STATIC_AUTH_SECRET` and `TURN_URLS` set, and the
   firewall ports above open.
2. Start a phone call in-game (two browsers/tabs, or two players).
3. Open the browser console and look for:
   ```
   [phone] ICE config: 3 server(s), TURN=present
   ```
   `3 server(s)` = 2 STUN + 1 TURN entry. `TURN=present` confirms a credential
   was either fetched from the backend or supplied via the build-time
   override (see **Precedence** below) — it does not by itself prove the
   relay is reachable, only that a credential was found.
4. To confirm the relay is actually usable (not just configured), the
   reliable test is forcing every call through it —
   set `PHONE_TURN_FORCE_RELAY=true` (see below), redeploy, and confirm calls
   still connect. If ICE now fails where it previously succeeded, the relay
   itself (not just the credential) is unreachable — recheck the firewall
   ports.
5. If the log instead says `TURN=absent`: check that `TURN_STATIC_AUTH_SECRET`
   and `TURN_URLS` are both set in Coolify, and check the `backend` container
   logs — `GET /phone/turn-credentials` responding but with empty
   `urls`/`username`/`credential` means the backend itself sees one of those
   vars as blank at boot.

## Traffic expectations

TURN relays both legs of a call (each direction, per participant pair), so
relayed traffic runs noticeably above the raw audio bitrate. Rough estimate
for a single relayed 1:1 call, Opus at a typical WebRTC voice bitrate:
**~36MB per call-hour** relayed through `coturn`. A group call scales with
the number of relayed legs, not linearly with participants necessarily
(depends how many pairs actually need TURN vs. connect directly).

Since `coturn` only relays for players STUN can't connect directly (not
every call, unless `PHONE_TURN_FORCE_RELAY=true` — see below), actual usage
is well under "every call-hour × 36MB" for a typical player base. Self-hosted
means this traffic counts against your server's own bandwidth rather than a
separate quota — size accordingly if your host bills for egress.

## Manual override / hosted-provider escape hatch

Three build-time env vars still work exactly as before and take **precedence**
over the fetched self-hosted credentials:

| Variable                | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `PHONE_TURN_URLS`       | Comma-separated TURN/TURNS URL(s), e.g. `turn:a.relay.metered.ca:80,turns:a.relay.metered.ca:443` |
| `PHONE_TURN_USERNAME`   | TURN username                                                                                     |
| `PHONE_TURN_CREDENTIAL` | TURN credential/password                                                                          |

**Precedence:** if all three of `PHONE_TURN_URLS`/`PHONE_TURN_USERNAME`/
`PHONE_TURN_CREDENTIAL` are set (non-blank) at **build time**, the client uses
them directly and never calls `/phone/turn-credentials` — no request to the
backend is made at all for TURN config. This is the escape hatch for anyone
who wants to point at a hosted provider (Metered, Cloudflare Calls, etc.)
instead of, or as a fallback ahead of, the self-hosted `coturn` service. Leave
all three unset (the default on this stack) to use the self-hosted flow
described above.

These are read at build time via `vite.config.ts`'s `define` (same mechanism
as `API_DOMAIN`) and exposed through `ClientEnv.phoneTurnUrls()` /
`phoneTurnUsername()` / `phoneTurnCredential()`. Unlike the self-hosted flow,
values set this way ship inside the client JS bundle and are visible to
anyone who views source — fine for a hosted provider's own
rotating/ephemeral credentials, but never put a permanent static
username/password pair here if you can avoid it.

## Optional: force relay-only (hides player IPs, costs more)

Setting `PHONE_TURN_FORCE_RELAY=true` sets `iceTransportPolicy: "relay"` on
every `RTCPeerConnection`, meaning ICE will _only_ use the TURN relay path —
it skips host/STUN candidates entirely. Two effects:

- **Privacy**: peers never learn each other's real IP address (normal WebRTC,
  even with STUN, exposes both sides' public IP in ICE candidates).
- **Cost**: 100% of call audio is relayed through `coturn` instead of TURN
  being used only as a fallback for the players who need it — expect traffic
  close to the full "~36MB per call-hour" figure above for every call, not
  just the ones that would otherwise fail.

This is a one-line env flip (`PHONE_TURN_FORCE_RELAY=true` + rebuild) and is
**off by default**. Only enable it if the privacy property is worth the extra
relay traffic for every call, not just the ones that would otherwise fail.
It works the same way whether TURN comes from the self-hosted `coturn`
service or a build-time override.
