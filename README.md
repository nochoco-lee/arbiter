<div align="center">
  <h1>Arbiter (Alpha)</h1>
  <p><b>Lease-Based Resource Coordination for Autonomous Coding Agents</b></p>
</div>

---

## Why Arbiter Exists

Parallel coding agents are fast — but Android emulators, IoT boards, and serial 
consoles can only be safely controlled by one process at a time. Without coordination, 
agents overwrite each other's builds, collide on log streams, and produce flaky 
false-negative failures.

Arbiter adds a lightweight lease layer on top of your existing CLI tooling so agents 
queue for device access, work exclusively, and hand off cleanly.

## Quick Start (2 Minutes)

### 1. Install and Start the Broker
```bash
npm install -g @nochoco-lee/arbiter
arbiter start
```

### 2. Install the adb Shim
```bash
arbiter shim install ~/.arbiter/bin adb
```

### 3. Simulate an Agent Session

The steps below simulate how a coding agent interacts with Arbiter internally.

In a real setup, the agent skill handles lease acquisition and token propagation automatically. Here, we run the commands manually to demonstrate how the coordination flow works.

Configure the shell the way an autonomous coding agent session would be launched:
```bash
export PATH=~/.arbiter/bin:$PATH
export ARBITER_AGENT_SESSION=1
```

Now try running a device command without a lease:
```bash
adb shell
```
The shim intercepts the command:
```text
[ARBITER SHIM] State: no ARBITER_LEASE_TOKEN is set.
[ARBITER SHIM] Next: request a lease before running 'adb'.
[ARBITER SHIM] Command: arbiter request adb --wait
```

Request a lease:
```bash
arbiter request adb --wait
```
Example output:
```text
export ARBITER_LEASE_TOKEN=token-uuid-1234
```

Run commands with the token:
```bash
ARBITER_LEASE_TOKEN=token-uuid-1234 adb shell
```

Release the lease:
```bash
arbiter release
```

In normal agent workflows, lease acquisition and token handling are typically automated through the installed Arbiter skill.

---

## System Requirements
Arbiter requires:
* Node.js 18+

Older Ubuntu releases may ship outdated Node.js packages through apt. Example installation using NodeSource:
```bash
curl -fsSL [https://deb.nodesource.com/setup_20.x](https://deb.nodesource.com/setup_20.x) | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Full Setup Guide

### Step 1 — Install and Start the Broker
```bash
npm install -g @nochoco-lee/arbiter
arbiter start
```

### Step 2 — Install Device Shims
Arbiter replaces device CLI commands with lightweight shims that enforce lease ownership before execution.

Available shims:
* `adb` — required for Android workflows
* `android` — optional companion shim for higher-level tooling

Both tools share the same lease slot.

#### macOS / Linux
```bash
arbiter shim install ~/.arbiter/bin adb
arbiter shim install ~/.arbiter/bin android
```

#### Windows (PowerShell)
```powershell
arbiter shim install C:\Arbiter\bin adb
arbiter shim install C:\Arbiter\bin android
```

> [!IMPORTANT]
> Many Android projects bypass $PATH completely and invoke adb using an absolute SDK path (for example through Gradle or local.properties).
> Arbiter supports two mitigation strategies:
> 1. Agent instructions that explicitly forbid absolute-path adb
> 2. Optional SDK binary replacement on macOS/Linux (adb → adb.real)

> [!TIP]
> If Arbiter cannot automatically discover the real binary location, it will prompt for the absolute path during installation.

### Step 3 — Install the Agent Skill
Arbiter provides a built-in skill file that teaches coding agents:
* how to request leases
* how to pass tokens
* why absolute paths must be avoided

Run this inside your project root:
```bash
arbiter skills install arbiter
```
This generates: `.agents/skills/arbiter/SKILL.md`. Repeat this for each workspace where agents operate.

### Step 4 — Launch Agents with PATH Separation
Agents should use shimmed binaries while humans continue using the real system tools. Do not add the Arbiter shim directory to your global system PATH. Instead, prepend it only inside the agent launcher environment.

#### Linux / macOS
```bash
export PATH=~/.arbiter/bin:$PATH
export ARBITER_AGENT_SESSION=1

codex (or claude)
```

#### Windows PowerShell
```powershell
$env:Path = "C:\Arbiter\bin;" + $env:Path
$env:ARBITER_AGENT_SESSION = "1"

codex (or claude)
```

#### Windows Command Prompt
```cmd
set PATH=C:\Arbiter\bin;%PATH%
set ARBITER_AGENT_SESSION=1

codex (or claude)
```

---

## How Agents Use Arbiter
Arbiter is intentionally hint-driven. If an agent attempts to access a protected resource without a lease, the shim explains exactly how to recover.

Example output:
```text
[ARBITER SHIM] State: no ARBITER_LEASE_TOKEN is set.
[ARBITER SHIM] Next: request a lease before running 'adb'.
[ARBITER SHIM] Command: arbiter request adb --wait
[ARBITER SHIM] Note: adb and android share the same lease.
```

### Lease Lifecycle

#### 1. Request a Lease
```bash
arbiter request adb --wait
```
Example output:
```text
export ARBITER_LEASE_TOKEN=token-uuid-1234
```

#### 2. Run Device Commands
Coding agents frequently spawn isolated shell sessions for each command they execute. Because environment variables may not persist between invocations, the safest pattern is to pass the lease token inline with every device command.

##### Linux/macOS
```bash
ARBITER_LEASE_TOKEN=token-uuid-1234 adb install app.apk
ARBITER_LEASE_TOKEN=token-uuid-1234 adb logcat -d
ARBITER_LEASE_TOKEN=token-uuid-1234 adb shell dumpsys battery
```

##### Windows PowerShell
```powershell
$env:ARBITER_LEASE_TOKEN='token-uuid-1234'; adb logcat -d
```

##### Windows Command Prompt
```cmd
set ARBITER_LEASE_TOKEN=token-uuid-1234 && adb logcat -d
```

> [!TIP]
> Human-operated interactive terminals can safely use a normal one-time export. The inline pattern mainly exists for autonomous agents that spawn isolated command sessions.

#### 3. Release the Lease
```bash
arbiter release
```

---

## Monitoring and Diagnostics

### Interactive Dashboard
```bash
arbiter tui
```
Displays:
* active leases
* queue depth
* current owners
* resource states

### Health Check
```bash
arbiter doctor
```
Verifies:
* broker connectivity
* binary mappings
* shim configuration

### Broker Logs
```bash
arbiter logs --follow
arbiter logs --limit 50
```

### Resource Status
```bash
arbiter lease status --resource adb
```

---

## Example Scenario: One Emulator, Two Agents

### Agent A
```bash
export PATH=/tmp/arbiter_shims:$PATH

arbiter request adb --wait

ARBITER_LEASE_TOKEN=<token> adb install app1.apk
ARBITER_LEASE_TOKEN=<token> adb logcat -d
```
Agent A now owns the device lease.

### Agent B
```bash
export PATH=/tmp/arbiter_shims:$PATH

adb install app2.apk
```
The shim blocks execution:
```text
[ARBITER SHIM] State: no ARBITER_LEASE_TOKEN is set.
[ARBITER SHIM] Command: arbiter request adb --wait
```
Request the lease:
```bash
arbiter request adb --wait
```
Agent B waits until Agent A releases ownership. Once released, Agent B automatically acquires the lease and continues.

---

## Architecture
Arbiter works by intercepting device CLI commands through lightweight shims.
The shim checks lease ownership with a local broker daemon before forwarding execution to the real underlying binary.

```text
Coding Agent
     │
     ▼
 Arbiter Shim  ◄────►  Arbiter Broker
     │                  (leases, queues, ownership)
     ▼
Real Device / Emulator
```

This allows multiple autonomous agents to share hardware safely without modifying the underlying tools themselves.

---

## Core Features
* Lease-based resource locking
* Queueing and ownership tracking
* Shared lease groups (adb + android)
* Graceful handoff during active commands
* Cooperative read-only permits
* Interactive terminal dashboard
* Audit history per resource
* Async reservation support for long waits

---

## What Arbiter Does Not Do
Arbiter does not:
* virtualize hardware
* sandbox processes
* isolate environments
* proxy device traffic

It only coordinates ownership and execution sequencing.

---

## Contributing
See [CONTRIBUTING.md](./CONTRIBUTING.md) for:
* local development setup
* testing
* adapter implementation
* broker internals

## License
MIT
