# Secret storage posture (D-034)

The BYOK API key (and any future provider secret) is kept **off the repo, logs, sessions, and the
vault** (brief §3.6). Storage is a zero-dependency service (`packages/providers/src/secrets/keychain.ts`)
that picks the best backend for the OS.

## Backends

| OS | Backend | Notes |
|---|---|---|
| macOS | Keychain via `security` | Secret fed over **stdin**, never argv (`ps`-safe). Only exit 44 (`errSecItemNotFound`) means "no key"; a locked/denied keychain surfaces `TOOL_IO` rather than silently dropping to demo. |
| Linux | libsecret via `secret-tool` | Secret over stdin. A non-empty stderr on lookup is treated as a real failure (daemon down / keyring locked), surfaced; an empty-stderr non-zero exit is a clean miss. |
| Windows / no helper | `0600` JSON file under `~/.rizz` | **Fallback.** See the Windows posture below. |

The store returns structured `Result` (never throws for expected failures); a failed file write is
`TOOL_IO`. Secrets are never logged; adapter error messages redact the key.

## Windows posture (confirm before any Windows publish)

The file fallback `chmod 0o600` is a **near-no-op on NTFS** (no POSIX permission bits). The mitigation
today is that the file lives under the **user-profile directory**, whose ACL is already user-restricted
on a standard Windows install — so it is not world-readable in practice. This is acceptable for
dogfooding but is **not** the same guarantee as a real credential store.

**Deferred upgrade (D-034):** a **DPAPI-backed Windows backend** (`ConvertTo/ConvertFrom-SecureString`
or Windows Credential Manager) — not built yet because it can't be verified in the CI sandbox. Build +
verify it on a real Windows host before promoting Windows to a first-class secret-storage tier or
publishing a Windows installer.

**Action for DevOps #7 / Architecture #4:** confirm the user-profile-ACL posture is acceptable for the
M3-finish dogfooding window, and schedule the DPAPI backend ahead of a Windows publish.
