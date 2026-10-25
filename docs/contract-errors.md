# Contract Error Codes

Soroban contracts return a numeric error from `contracts/shared/src/errors.rs`.
The table below is the single mapping between those codes and the backend's
`ErrorCode` / HTTP status (`src/utils/contractErrors.ts`).

**The discriminants are part of the on-chain ABI.** New variants must be
appended with a new number and never renumbered or reused — old clients and
already-deployed contracts depend on the current values. `tests/utils/contractErrors.test.ts`
parses the Rust enum and fails if a variant is unmapped, if the backend table has
an extra code, or if a pre-existing value changes.

| Code | Contract variant | Backend `code` | HTTP | Meaning |
| ---- | ---------------- | -------------- | ---- | ------- |
| 1 | `AlreadyInitialized` | `CONFLICT` | 409 | Contract is already initialized |
| 2 | `NotInitialized` | `INTERNAL_SERVER_ERROR` | 500 | Contract is not initialized |
| 3 | `PlayerNotFound` | `PLAYER_NOT_FOUND` | 404 | Player not found on-chain |
| 4 | `NotFound` | `NOT_FOUND` | 404 | Generic contract resource not found |
| 5 | `InvalidInput` | `VALIDATION_ERROR` | 400 | Contract rejected the input |
| 6 | `AlreadyVerified` | `CONFLICT` | 409 | Resource is already verified |
| 7 | `InsufficientFee` | `INSUFFICIENT_FUNDS` | 402 | Insufficient funds |
| 8 | `NotSubscribed` | `NOT_SUBSCRIBED` | 402 | Scout has never subscribed |
| 9 | `Unauthorized` | `UNAUTHORIZED` | 403 | Caller is not authorized |
| 10 | `ContractPaused` | `CONTRACT_PAUSED` | 503 | Contract is paused |
| 11 | `Overflow` | `INTERNAL_SERVER_ERROR` | 500 | Arithmetic overflow |
| 12 | `InsufficientSupply` | `INSUFFICIENT_SUPPLY` | 409 | Not enough unsold tokens |
| 13 | `ValidatorNotRegistered` | `VALIDATOR_NOT_REGISTERED` | 403 | Caller is not a registered validator |
| 14 | `ValidatorRevoked` | `VALIDATOR_REVOKED` | 403 | Validator was revoked |
| 15 | `MilestoneNotFound` | `MILESTONE_NOT_FOUND` | 404 | No such milestone |
| 16 | `MilestoneAlreadyApproved` | `MILESTONE_ALREADY_APPROVED` | 409 | Milestone already approved |
| 17 | `SelfApprovalForbidden` | `SELF_APPROVAL_FORBIDDEN` | 403 | Validator approving their own milestone |
| 18 | `SubscriptionExpired` | `SUBSCRIPTION_EXPIRED` | 402 | Subscription expired or was cancelled |
| 19 | `ContactAlreadyPaid` | `CONTACT_ALREADY_PAID` | 409 | Contact with the player already paid |
| 20 | `FeeBpsOutOfRange` | `FEE_BPS_OUT_OF_RANGE` | 400 | Fee is outside 0–10 000 bps |
| 21 | `ConnectionNotFound` | `CONNECTION_NOT_FOUND` | 404 | No such scout–player connection |
| 22 | `ConnectionAlreadyClosed` | `CONNECTION_ALREADY_CLOSED` | 409 | Connection already closed |

## How failures reach clients

`invokeContract()` throws `ContractExecutionError` for simulation, submission
and on-chain failures. The class extracts the numeric code from the RPC error
string (`HostError: Error(Contract, #15)`, `Error(Contract, 15)`, or
`contract error 15`). `src/middleware/errorHandler.ts` then responds with the
mapped `code`, HTTP status and message from the table, so clients see e.g.:

```json
{
  "success": false,
  "error": "Milestone is already approved",
  "code": "MILESTONE_ALREADY_APPROVED",
  "correlationId": "…"
}
```

Service-specific error types (`PaymentError`, `SubscriptionError`,
`ValidatorActionError`, `ContractActionError`) still classify the codes they
care about, but the numeric parsing now goes through
`extractContractErrorCode()` rather than ad-hoc `/#N/` regexes.

## Adding a variant

1. Append `NewVariant = <next number>,` to the Rust enum with a doc comment.
2. Use it in the contract instead of the closest coarse variant.
3. Add its row to `CONTRACT_ERRORS` (and an `ErrorCode` entry if it is new).
4. If the API needs a dedicated client-visible code, add it to `ErrorCode`.
5. Update this table and run `npm test -- contractErrors`.
