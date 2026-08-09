Status: done. Commit `1f3c1fc6d885730401b0471a7ecd4ffe7bd3ffe6`, pushed to `origin/main`.

Coolify env vars to set:

- `TURN_STATIC_AUTH_SECRET` — long random string (shared by `coturn` + `backend`)
- `TURN_URLS` — e.g. `turn:yourdomain.tld:3478`

Firewall (host, `network_mode: host`):

- `3478` UDP + TCP (TURN listener)
- `49160-49200` UDP (relay ports)

Deploy steps:

1. Set the two env vars above in Coolify (stack-wide).
2. Open the firewall ports above on the host.
3. Redeploy the stack (Coolify picks up the new `coturn` service + backend route automatically).

Test results: client `tests/PhoneTransport.test.ts` 45/45 pass (7 new); backend `turnCredentials.test.ts` + `turn.test.ts` 17/17 pass; full backend suite 341/341 pass; `npx tsc --noEmit` and `eslint`/`oxlint` clean on all changed files. Full client suite has 118 pre-existing unrelated failures (`ClanModalProfileHandoff.test.ts` etc.) reproduced identically on unmodified `main` via `git stash` — not caused by this change.

Verify TURN is live: start a phone call, check browser console for `[phone] ICE config: 3 server(s), TURN=present`. To confirm the relay itself (not just the credential) works, temporarily set `PHONE_TURN_FORCE_RELAY=true` and redeploy — calls should still connect.

---

## Follow-up: relay candidates never appear (2026-08-09)

Root cause found from a real production call: `coturn` had no `--external-ip`, so it advertised its locally-seen address as the relay candidate instead of the server's public IP — unreachable behind any NAT/cloud firewall. Every ICE candidate was host/srflx, never `relay`; `connectionState` went `connecting -> failed` despite `TURN=present` and healthy signaling.

Fix: added `--external-ip=${TURN_EXTERNAL_IP:?...}` to the `coturn` command in `docker-compose.coolify.yml` (fails to start if unset — no silent fallback). Used the plain single-IP form, not `PUBLIC/PRIVATE`, because `network_mode: host` means coturn binds the host's real interface directly (no separate private-facing address to split out). Left `--listening-ip` unset (bind-all is correct under host networking). Updated `docs/PhoneTurn.md` and `docs/DEPLOY.md` accordingly.

**Status:** done. Commit `5966880c3`.
