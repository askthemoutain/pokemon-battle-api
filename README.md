# Pokemon Covenant battle API

The service owns authoritative `@pkmn/sim` PvE battles. Wild encounters keep
their lightweight random policy; authenticated trainer encounters delegate every
lead, move, and forced switch to the separate Foul Play HTTP service.

## Environment

- `TRAINER_AI_ENABLED=1` enables trainer routing. Leave it unset for rollout.
- `TRAINER_TICKET_SECRET` verifies short-lived tickets issued by GDRCD PHP.
- `FOUL_PLAY_URL` is the Foul Play service origin, without a trailing slash.
- `FOUL_PLAY_SHARED_SECRET` signs Node-to-Foul-Play request bodies.
- `FOUL_PLAY_TIMEOUT_MS=15000` bounds one HTTP attempt on the free service.
- `FOUL_PLAY_SEARCH_BUDGET_MS=2000` is clamped to 100-2000 ms.
- `TRAINER_AI_ABORT_AFTER_MS=120000` controls signed safe recovery.
- `ALLOWED_ORIGINS` is the comma-separated browser origin allowlist.

Trainer starts require a stable `requestId`; actions require a stable `actionId`.
Clients retry the same ID after a retryable `TRAINER_AI_UNAVAILABLE` response.
No trainer path falls back to random decisions.

Run `npm test` for routing, privacy, idempotency, failure, ticket, and forced
switch coverage.
