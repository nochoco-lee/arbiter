<div align="center">
  <h1>Arbiter (Alpha)</h1>
  <p><b>Agentic Resource Broker &amp; Interceptor for Test Engineering Run-times</b></p>
  <p>A lightweight lease broker and shim system designed to help coordinate access for coding agents. It aims to reduce collisions when autonomous agents (like Claude Code, Codex, or OpenCode) target limited external hardware bridges like Android Emulators, bare-metal IoT boards, and native displays.</p>
</div>

<br>

---

## 💻 System Requirements

Arbiter requires **Node.js 18.0.0 or higher**.

If you are using an older version of Ubuntu (e.g., 20.04 or 22.04), the default `apt` version of Node.js is likely too old. We recommend installing a modern version via [NodeSource](https://github.com/nodesource/distributions):

```bash
# Example for Ubuntu/Debian to install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## ⚡ Setup

As autonomous coding agents automate development and testing tasks, they may encounter issues when trying to access the same localized system resource simultaneously. **Arbiter** provides a central authority to coordinate these requests.

### Step 1 — Install & Start the Broker

```bash
npm install -g @nochoco-lee/arbiter

# Start the Broker Daemon in the background
arbiter start
```

### Step 2 — Install the Shims (`android` + `adb`)

Arbiter replaces device CLI commands with shims that enforce lease ownership before executing. For Android, install **both** shims — they are complementary, not alternatives:

- **`android`** — high-level commands: `android run`, `android emulator`, build tooling.
- **`adb`** — low-level device access: `adb shell`, `adb logcat`, file push/pull, etc.

Both shims share the **same device lease slot** — one token covers both tools.

**macOS/Linux:**
```bash
arbiter shim install ~/.arbiter/bin android
arbiter shim install ~/.arbiter/bin adb
```

**Windows (PowerShell as Administrator):**
```powershell
# Arbiter will create the folder automatically if it doesn't exist
arbiter shim install C:\Arbiter\bin android
arbiter shim install C:\Arbiter\bin adb
```

> [!IMPORTANT]
> **ADB Absolute Path Bypass:** Many Android projects and Gradle builds resolve `adb` to its absolute SDK path (e.g. via `local.properties`), which bypasses `$PATH` shims completely.
>
> **Mitigations:**
> 1. **Agent Skill (Step 3 below):** Explicitly instructs agents never to use absolute paths. Essential on Windows.
> 2. **SDK Hijacking (macOS/Linux only):** When installing the `adb` shim on macOS/Linux, Arbiter will offer to rename the real binary to `adb.real` and replace it with a smart router — guaranteeing interception even when agents use the absolute path.

> [!TIP]
> If Arbiter cannot auto-discover the target binary in your `PATH` during installation, it will prompt you for the absolute path. For `adb`, a platform-specific example is shown (e.g. `C:\Users\<user>\AppData\Local\Android\Sdk\platform-tools\adb.exe` on Windows).

### Step 3 — Install the Agent Skill

Arbiter provides a built-in skill file that teaches coding agents how to interact with device resources cooperatively: when to request a lease, how to pass the token, and why absolute paths must be avoided.

Run this command in your **project's root directory**:

```bash
arbiter skills install arbiter
```

This generates `.agents/skills/arbiter/SKILL.md` — a project-level context file that most coding agent frameworks pick up automatically. Repeat this in each workspace where agents operate.

### Step 4 — Launch Your Agent with PATH Separation

To allow agents to use the shims while humans continue using the real tools, prepend the shim directory inside a launcher script and set `ARBITER_AGENT_SESSION=1` to enable smart routing.

> [!WARNING]
> Do **not** add the Arbiter shim directory to your global system or user `PATH`. This would intercept your own manual terminal commands.

**Linux/macOS — `agent_start.sh`:**
```bash
export PATH=~/.arbiter/bin:$PATH
export ARBITER_AGENT_SESSION=1
claude  # or: codex, opencode, etc.
```

**Windows PowerShell:**
```powershell
$env:Path = "C:\Arbiter\bin;" + $env:Path
$env:ARBITER_AGENT_SESSION = "1"
claude
```

**Windows Command Prompt:**
```cmd
set PATH=C:\Arbiter\bin;%PATH%
set ARBITER_AGENT_SESSION=1
claude
```

### Uninstallation

To remove a shim and automatically revert any hijacked binaries:

```bash
# macOS/Linux
arbiter shim uninstall ~/.arbiter/bin android
arbiter shim uninstall ~/.arbiter/bin adb

# Windows (PowerShell as Administrator)
arbiter shim uninstall C:\Arbiter\bin android
arbiter shim uninstall C:\Arbiter\bin adb
```

---

## 🤖 How Agents Use Arbiter

Arbiter is **hint-driven** — if an agent runs a device command without a lease, the shim intercepts it and prints exactly what to do next.

### Automatic Interception (The "Oops" Path)

If an agent runs `android run` without a lease, the shim outputs:
```text
[14:30:01.123] [ARBITER SHIM] State: no ARBITER_LEASE_TOKEN is set for this session.
[14:30:01.124] [ARBITER SHIM] Next: request a lease before running 'android'.
[14:30:01.125] [ARBITER SHIM] Command: arbiter request android --wait
[14:30:01.126] [ARBITER SHIM] Note: a token for 'adb' also covers 'android' — they share a device lease.
```

### Lease Cycle

**1. Request a Lease**

```bash
arbiter request android --wait
# Output includes the lease token, e.g.:
# export ARBITER_LEASE_TOKEN=token-uuid-1234   <-- note this value
```

> [!NOTE]
> `arbiter request adb --wait` is identical — `adb` and `android` share the same lease slot. The token is valid for both shims.

**2. Run Device Commands (pass the token inline)**

Coding agents frequently spawn a **new, isolated shell session** for each command they run, so a one-time `export` may not carry over. The safest pattern is to provide the token on the **same line** as each device command:

```bash
# Linux/macOS — inline prefix
ARBITER_LEASE_TOKEN=token-uuid-1234 android run --apks=my-app.apk
ARBITER_LEASE_TOKEN=token-uuid-1234 adb shell dumpsys battery
ARBITER_LEASE_TOKEN=token-uuid-1234 adb logcat -d
```

```powershell
# Windows PowerShell — set and run in one statement
$env:ARBITER_LEASE_TOKEN='token-uuid-1234'; android run --apks=my-app.apk
$env:ARBITER_LEASE_TOKEN='token-uuid-1234'; adb logcat -d
```

```cmd
:: Windows Command Prompt — chain with &&
set ARBITER_LEASE_TOKEN=token-uuid-1234 && android run --apks=my-app.apk
```

> [!TIP]
> **Human / interactive testing:** If you are running commands manually in a single terminal session, a one-time `export ARBITER_LEASE_TOKEN=...` (or `$env:` / `SET`) is perfectly fine — your shell retains the variable for the full session. The inline pattern is specifically needed for coding agents.

**3. Release the Lease**
```bash
arbiter release
```

---

## 🕵️ Human Monitoring & Diagnostics

These tools are designed for human operators to monitor the health of the hardware pool and the status of the broker.

### Terminal Dashboard (TUI)
Launch the interactive dashboard to see all resources, queue depths, and current owners in real-time.
```bash
arbiter tui
```

### System Health (Doctor)
Check if native binaries (adb, xcrun, etc.) are correctly mapped and if the broker is reachable.
```bash
arbiter doctor
```

### Broker Logs
```bash
# Stream live logs in real-time (Watchdog events, Queue promotions, etc.)
arbiter logs --follow

# Print the last 50 log lines
arbiter logs --limit 50
```

### Resource Status
```bash
# Check if a specific resource is currently held or free
arbiter lease status --resource android
```

---

## 🎭 Scenario: 1 Emulator, 2 Agents

1. **Start the Broker**: `arbiter start` (Keep this running in terminal 1)
2. **Install the Shims**: `arbiter shim install /tmp/arbiter_shims android && arbiter shim install /tmp/arbiter_shims adb`
3. **Agent A (Terminal 2)**:
   ```bash
   export PATH=/tmp/arbiter_shims:$PATH
   arbiter request android --wait --duration 30
   # Note the printed token, e.g.: ARBITER_LEASE_TOKEN=<token-from-output>
   # Pass it inline with every device command (agents spawn isolated sessions):
   ARBITER_LEASE_TOKEN=<token-from-output> android run --apks=app1.apk
   ARBITER_LEASE_TOKEN=<token-from-output> adb logcat -d
   # Do NOT release yet.
   ```
4. **Agent B (Terminal 3)**:
   ```bash
   export PATH=/tmp/arbiter_shims:$PATH
   # Intercepted — Agent B has no lease token
   android run --apks=app2.apk
   # [ARBITER SHIM] State: no ARBITER_LEASE_TOKEN...
   # [ARBITER SHIM] Command: arbiter request android --wait

   # Blocks until Agent A releases:
   arbiter request android --wait
   # Once granted, run inline:
   ARBITER_LEASE_TOKEN=<agent-b-token> android run --apks=app2.apk
   ```
5. **Release Lease (Terminal 2)**: `arbiter release`
6. **Agent B Unblocks**: Receives the lease and proceeds automatically.

---

## 🛠️ Core Features

- **Basic Locking:** Mutex-based access to physical/virtual resources.
- **Warm Leases (`AVAILABLE` State):** Preemptible leases for improved efficiency.
- **Async Shift:** Automatically converts long-waiting requests into ASYNC reservation tickets.
- **Handoff Management (`DRAINING` State):** Ensures one-time commands finish before resource reallocation.
- **Audit Trails:** Rolling history of the last 100 commands per resource.
- **Cooperative Permits:** Allows agents to request shared, one-time access for read-only tasks.

---

## 📊 Testing & Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for instructions on building from source, running the test suite, and adding new adapters.

## License
MIT License
