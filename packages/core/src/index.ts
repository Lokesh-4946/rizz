// @rizz/core — the orchestration layer (the "why/when": the agent loop, budget, compression,
// fallback, interrupt, failure classification). Owns state and user-facing errors; calls the
// service layer (@rizz/providers) for mechanics. See CLAUDE.md §Architecture.

import type { Result } from '@rizz/providers';

export const VERSION = '0.0.0';

export type { Result };

// The loop, budget, compression and fallback land here in M3. M0 establishes the package
// boundary and the one-way dependency on the service layer only.
