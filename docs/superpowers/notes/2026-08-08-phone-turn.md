# Phone TURN server support

Status: implemented, tests green, tsc/eslint/oxlint clean. Not yet committed
(pending final report handoff).

Env vars added (all optional; blank/absent = STUN-only, unchanged behavior):

- `PHONE_TURN_URLS` — comma-separated TURN/TURNS URL(s)
- `PHONE_TURN_USERNAME`
- `PHONE_TURN_CREDENTIAL`
- `PHONE_TURN_FORCE_RELAY` — optional, off by default, forces
  `iceTransportPolicy: "relay"`

User steps: sign up at a hosted TURN provider (e.g.
https://www.metered.ca/tools/openrelay/, 500MB/month free), create a TURN
credential, paste the URL(s)/username/credential into
`PHONE_TURN_URLS`/`PHONE_TURN_USERNAME`/`PHONE_TURN_CREDENTIAL` in the deploy
env, then rebuild (`npm run build-prod`) — these are Vite build-time `define`
values, a running dev server needs a restart, not just a reload.

Once active, the browser console will print (once per page load):

```
[phone] ICE config: 3 server(s), TURN=present
```

(3 = 2 STUN + 1 TURN entry; more if multiple TURN URLs supplied). Credential
is never logged.

Full details: `docs/PhoneTurn.md`.

Test results: `npx vitest tests/PhoneTransport.test.ts --run` — all tests
pass (added 3 new cases: STUN-only default, TURN present with correct
username/credential, blank/whitespace credential treated as absent). All
pre-existing tests still pass.
