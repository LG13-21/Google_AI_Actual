# Security Specification for Juris App

## Data Invariants
1. A file (`FileEntry`) must belong to the authenticated user (`userId == request.auth.uid`).
2. A case (`CaseRecord`) must belong to the authenticated user.
3. An audit task (`AuditTask`) must belong to the authenticated user.
4. A version history item (`VersionRecord`) must belong to the authenticated user.
5. All IDs must be valid strings (alphanumeric, max 128 chars).
6. Timestamps must be server-generated or verified.

## The "Dirty Dozen" Payloads (Expected to be DENIED)
1. **Identity Spoofing**: Creating a file with `userId: "someone_else"`.
2. **Identity Poisoning**: Creating a file with a huge 1MB ID.
3. **State Shortcutting**: Updating an `AuditTask`'s status directly to `done` without being an admin or without valid processing.
4. **PII Leak**: Reading another user's profile or settings.
5. **Orphaned Writes**: Creating a file without a `userId`.
6. **Shadow Update**: Adding a field `isVerified: true` to a user document.
7. **Cross-User Query**: Listing files without a `where userId == auth.uid` filter (security rules should enforce this).
8. **Malicious Timestamp**: Setting `createdAt` to a future date.
9. **Role Escalation**: Setting `isAdmin: true` in user settings.
10. **Resource Exhaustion**: Writing a 10MB string into the `content` field (Firestore limited to 1MB total doc size anyway, but rules should restrict string sizes).
11. **Bypassing Master Gate**: Writing to a subcollection for a user that doesn't exist.
12. **Recursive Cost Attack**: Deeply nested `get()` calls (rules here are simple enough to avoid this).

## Test Runner (Logic)
The tests will verify that:
- `request.auth.uid` matches the document path and `userId` field.
- `isValid[Entity]` enforces types and sizes.
- `affectedKeys()` restricts what can be updated.
