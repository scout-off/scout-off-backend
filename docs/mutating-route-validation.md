# Mutating route body validation (#1145)

Every `POST` / `PUT` / `PATCH` route must run `validateBody` (or
`validateJsonBodyOrPassThrough` for CSV/JSON dual imports) with a Zod schema
that rejects unknown keys (`.strict()`).

Meta-test: `tests/routes/mutatingRouteValidation.test.ts`.

| Method | Path | Schema |
|--------|------|--------|
| POST | /auth/token | tokenSchema |
| POST | /auth/refresh | refreshSchema |
| POST | /auth/logout | logoutSchema |
| POST | /players/register | registerSchema |
| PUT | /players/:playerId | updatePlayerSchema |
| POST | /players/:playerId/deactivate | emptyBodySchema |
| POST | /players/:playerId/reactivate | emptyBodySchema |
| POST | /players/:playerId/anonymize | emptyBodySchema |
| POST | /players/:playerId/trial-offers/:offerId/accept | emptyBodySchema |
| POST | /players/:playerId/trial-offers/:offerId/reject | rejectOfferSchema |
| POST | /players/:playerId/tokens/buy | buyTokenSchema |
| POST/PUT | /scouts/:wallet/subscribe | subscribeSchema |
| POST | /scouts/:wallet/contacts/:playerId/unlock | unlockContactSchema |
| POST | /scouts/:wallet/trial-offer(s) | trialOfferSchema |
| PUT | /scouts/:wallet/notes/:playerId | upsertNoteSchema |
| POST/PUT | /scouts/:wallet/players/:playerId/notes… | noteContentSchema |
| POST | /scouts/:wallet/api-keys | issueKeySchema |
| POST | /scouts/:wallet/api-keys/:id/rotate | rotateKeySchema |
| POST | /scouts/:wallet/bookmarks | addBookmarkSchema |
| POST | /scouts/:wallet/bookmark-folders | createBookmarkFolderSchema |
| POST | /scouts/:wallet/saved-searches | createSavedSearchSchema |
| PUT | /scouts/:wallet/saved-searches/:id | updateSavedSearchSchema |
| POST | /scouts/:wallet/webhooks | registerWebhookSchema |
| POST | /scouts/:wallet/webhooks/:id/test | emptyBodySchema |
| POST | /validators/milestone | milestoneSchema |
| POST | /validators/milestones/approve-bulk | bulkApproveSchema |
| POST | /admin/fees | withdrawFeesSchema |
| POST | /admin/fees/withdraw | withdrawFeesV2Schema |
| POST | /admin/validators/register\|revoke | validatorWalletSchema |
| POST | /admin/validators/import | importValidatorsBodySchema (JSON) / pass-through CSV |
| POST | /admin/players/import | importPlayersBodySchema (JSON) / pass-through CSV |
| POST | /admin/players/:playerId/deactivate | deactivateBodySchema |
| POST | /admin/players/:playerId/reactivate | emptyBodySchema |
| POST | /admin/contract/pause\|unpause | emptyBodySchema |
| POST | /admin/introspect | emptyBodySchema |
| POST | /admin/tokens/revoke | revokeTokenSchema |
| POST | /admin/indexer/reindex | reindexSchema |
| PUT | /admin/feature-flags | updateFeatureFlagBodySchema |
| PUT | /admin/feature-flags/:name | toggleFlagBodySchema |
| POST | /admin/actions/:id/approve | emptyBodySchema |
| POST | /admin/reindex | reindexBodySchema |
| POST | /admin/webhooks/…/requeue\|replay | emptyBodySchema |
| POST | /admin/ip-allowlist | setIpReputationSchema |

Paths above are relative to `/api` (and mirrored under `/api/v1` / `/api/v2`). Auth routes mount at `/auth`.
