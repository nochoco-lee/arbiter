# Contributing to Arbiter

Arbiter is maintained by one developer on a **best-effort basis** alongside a full-time job. The source code is public primarily for **transparency and auditability** — running a daemon that intercepts commands deserves open scrutiny.

**Expectations if you open a PR:**
- Review may be slow. There is no SLA.
- Not every PR will be merged, even good ones, if the scope or timing is not right.
- Filing an issue before writing code is strongly encouraged — it avoids wasted effort.

Issues, bug reports, and adapter additions are the most useful contributions at this stage.

---

## Prerequisites

- **Node.js 18+** — required for native test runner support
- **npm** — comes with Node.js
- A working internet connection for the initial `npm install`

---

## Getting Started

```bash
git clone https://github.com/nochoco-lee/arbiter.git
cd arbiter
npm install
npm run build
```

> [!TIP]
> After pulling new changes, always re-run `npm install && npm run build` to ensure your compiled output is in sync with the source.

---

## Project Structure

```
src/
  adapters/       Platform-specific device adapters (adb, sdb, ios, serial, ...)
  api/            Shared TypeScript types and interfaces
  broker/         HTTP broker server (the central coordination daemon)
  cli/            Terminal UI (tui.ts) and doctor diagnostics
  config/         arbiter.yaml loader with graceful fallback
  context/        Session artifact persistence
  queue/          Smart scheduling queue engine
  shim/           CLI entry point and shim interceptor logic
  state/          LeaseManager — core lease lifecycle state machine
  tests/
    scenarios/    JSON-based integration test definitions
    unit/         Node native unit tests (LeaseManager, QueueEngine, Shim)
    stress/       Thundering herd and zombie storm stress tests
    helpers/      Shared test harness, broker launcher, assertions
    tdb.ts        Test Debug Bridge — mock ADB binary for hardware-free testing
```

---

## Running Tests

Tests require the TypeScript source and must be run from the repository root.

### Unit Tests
Fast, isolated, no broker needed:
```bash
npm run test:unit
```

### Integration Tests (JSON Scenario Suite)
Spins up real broker instances per scenario. Tests all core features end-to-end:
```bash
npm test
```

### Stress / Robustness Tests
Thundering herd, zombie storm, concurrent lease contention:
```bash
npm run test:robustness
```

### Run Everything
```bash
npm run test:all
```

---

## Testing Without Hardware (tdb Mock)

The `src/tests/tdb.ts` script is a lightweight ADB mock that reads canned responses from a JSON config file. The test harness uses it internally to drive all integration scenarios without a real device.

To use it manually during development:

```bash
# Build the mock
npm run build

# Point Arbiter at the mock binary
export ARBITER_REAL_ADB_PATH="node $(pwd)/dist/tests/tdb.js"

# Set a config file for canned responses
export TDB_CONFIG_PATH="$(pwd)/src/tests/fixtures/tdb_scenarios.json"

# Now start the broker and test against it
node dist/broker/server.js &
arbiter request adb --wait
adb shell getprop ro.product.model
```

The `TDB_CONFIG_PATH` JSON format:
```json
[
  {
    "argsMatch": ["shell", "getprop", "ro.product.model"],
    "output": "Pixel 7",
    "exitCode": 0,
    "delayMs": 100
  }
]
```

---

## Adding a New Adapter

Adapters define how Arbiter captures artifacts (logs, screenshots) when a lease ends.

1. Create `src/adapters/myadapter.ts` implementing the `Adapter` interface from `src/adapters/types.ts`.
2. Register it in `src/adapters/index.ts`:
   ```typescript
   case 'mytool':
       return new (require('./myadapter').MyAdapter)();
   ```
3. Users can then declare it in `arbiter.yaml`:
   ```yaml
   resources:
     mytool:
       type: mytool
       max_lease_seconds: 300
   ```

---

## Environment Variables (Development)

| Variable | Purpose |
|---|---|
| `ARBITER_TEST_MODE=true` | Suppresses certain side-effects during tests |
| `ARBITER_SKIP_ARTIFACTS=true` | Disables adapter artifact capture (screenshots, logs) |
| `ARBITER_PORT` | Override broker port (useful to run multiple brokers) |
| `ARBITER_REAL_ADB_PATH` | Override the real ADB binary path |
| `TDB_CONFIG_PATH` | JSON file for `tdb` mock canned responses |

---

## Code Style

- TypeScript throughout; no `any` in public APIs
- All public state mutation goes through named methods (no `(obj as any).privateField`)
- New features must include at least one JSON scenario test in `src/tests/scenarios/`
