<div align="center">
  <h1>Arbiter (Alpha)</h1>
  <p><b>Agentic Resource Broker & Interceptor for Test Engineering Run-times</b></p>
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

## ⚡ Quick Start

As autonomous coding agents automate development and testing tasks, they may encounter issues when trying to access the same localized system resource simultaneously. **Arbiter** provides a central authority to coordinate these requests.

### 1. Installation 
```bash
npm install -g @nochoco-lee/arbiter

# Start the Broker Daemon in the background
arbiter start
```

### 2. Install the Shim Interceptor
Arbiter can install a small CLI replacement (Shim) for common commands that pauses execution until a valid lease is held. 

#### Recommended for Android: The `android` CLI
The cleanest way to support Android agents is to shim the `android` CLI. Because the `android` binary is located consistently in your `$PATH` and handles SDK paths internally, it avoids bypassing issues caused by hardcoded absolute paths.

**Windows Installation:**
1. Open PowerShell as Administrator.
2. Run the install command (Arbiter will automatically create the folder if it doesn't exist):
   ```powershell
   # Example: Installing into C:\Arbiter\bin
   arbiter shim install C:\Arbiter\bin android
   ```
3. Follow the **Agent Execution Environments** section below to use it.

**macOS/Linux Installation:**
```bash
arbiter shim install ~/.arbiter/bin android
```

#### ADB Integration
If your agents invoke `adb` directly (e.g. in legacy workflows or Gradle builds), you can also shim `adb`.

```bash
# Example: Install the ADB interceptor
arbiter shim install ~/.arbiter/bin adb
```

> [!IMPORTANT]
> **ADB Absolute Path Bypass:** In many Android projects, coding agents attempt to resolve the absolute SDK path to `adb` (e.g. via `local.properties`), which bypasses standard `$PATH` shims completely.
> 
> **To mitigate this:**
> 1. **Install the Agent Skill:** Run `arbiter skills install adb` on the project root directory. This installs a context file (`.agents/skills/arbiter-adb/SKILL.md`) that explicitly teaches coding agents to use Arbiter leases and to never use absolute paths. This is a project-level skill (not a global setting) and should be initialized in each workspace. This is especially useful on Windows where binary hijacking is not supported.
> 2. **Android SDK Hijacking (macOS/Linux):** When you run the shim install command on macOS/Linux, Arbiter will offer to proactively **hijack** your real SDK binary (renaming it to `adb.real` and replacing it with a smart router). This guarantees interception even if agents use the absolute path.

> [!NOTE]
> **`adb` and `android` share a device lease.** Acquiring a lease with `arbiter request adb` and acquiring one with `arbiter request android` compete for the **same underlying slot**. A token obtained for either tool is valid for both. This prevents two agents from colliding via different CLI front-ends on the same physical device.

> [!TIP]
> If Arbiter cannot auto-discover the target binary in your PATH during installation, it will interactively prompt you to provide its absolute path. For `adb`, a platform-specific example path is shown to help (e.g. `C:\Users\<user>\AppData\Local\Android\Sdk\platform-tools\adb.exe` on Windows).

#### Uninstallation
To remove a shim and automatically revert any hijacked binaries, use the uninstall command:

```bash
arbiter shim uninstall ~/.arbiter/bin android
arbiter shim uninstall ~/.arbiter/bin adb
```

### 3. Agent Execution Environments (PATH Separation)

To allow agents to use the shims while humans use tools natively, we recommend using **PATH separation**. Prepend the shim directory inside a launcher script tailored for agents.

> [!WARNING]
> We recommend NOT adding these Arbiter shim directories to your global system or user PATH to avoid unexpected interception in your manual terminal sessions.

**Linux/macOS `agent_start.sh`:**
```bash
# Prepend the shim directory to restrict the agent
export PATH=~/.arbiter/bin:$PATH
# Enable hijacking interception for this session
export ARBITER_AGENT_SESSION=1
# The agent will now use the Arbiter shim instead of the real binary
claude # Start the agent
```

**Windows PowerShell:**
```powershell
# Prepend the shim directory for this session
$env:Path = "C:\Arbiter\bin;" + $env:Path
$env:ARBITER_AGENT_SESSION = "1"
claude
```

**Windows Command Prompt:**
```cmd
@REM Prepend the shim directory for this session
set PATH=C:\Arbiter\bin;%PATH%
set ARBITER_AGENT_SESSION=1
claude
```

---

## 🤖 Agent Workflow

This is what a coding agent will typically see and do. Arbiter is designed to be "hint-driven"—if an agent tries to use a resource without a lease, Arbiter will provide instructions on how to get one.

### Automatic Interception (The "Oops" Path)
If an agent runs `android run` without a lease, the Shim will intercept it:
```text
[14:30:01.123] [ARBITER SHIM] State: no ARBITER_LEASE_TOKEN is set for this session.
[14:30:01.124] [ARBITER SHIM] Next: request a lease before running 'android'.
[14:30:01.125] [ARBITER SHIM] Command: arbiter request android --wait
[14:30:01.126] [ARBITER SHIM] Note: a token for 'adb' also covers 'android' — they share a device lease.
```

### Standard Lease Cycle
Agents should follow this pattern for reliable execution:

**1. Request a Lease**

```bash
# Linux/macOS
arbiter request android --wait
# Output: [ARBITER] Granted Access to: android
export ARBITER_LEASE_TOKEN=token-uuid-1234
```

```powershell
# Windows PowerShell
arbiter request android --wait
# Arbiter outputs both formats — copy the one matching your shell:
$env:ARBITER_LEASE_TOKEN='token-uuid-1234'
```

```cmd
:: Windows Command Prompt
arbiter request android --wait
SET ARBITER_LEASE_TOKEN=token-uuid-1234
```

> [!NOTE]
> `arbiter request adb --wait` works identically — `adb` and `android` share the same device lease slot. The token returned is valid for both `adb` and `android` shims.

**2. Execute Commands**
```bash
android run --apks=my-app.apk
android emulator list
# adb commands also work under the same token:
adb shell dumpsys battery
```

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
2. **Install the Shim**: `arbiter shim install /tmp/arbiter_shims android`
3. **Agent A (Terminal 2)**: 
   ```bash
   export PATH=/tmp/arbiter_shims:$PATH
   arbiter request android --wait --duration 30
   export ARBITER_LEASE_TOKEN=<token-from-output>
   android run --apks=app1.apk
   # Do NOT release yet.
   ```
4. **Agent B (Terminal 3)**:
   ```bash
   export PATH=/tmp/arbiter_shims:$PATH
   # This is intercepted because Agent B has no lease token yet
   android run --apks=app2.apk
   # Output: [ARBITER SHIM] State: no ARBITER_LEASE_TOKEN...
   # Output: [ARBITER SHIM] Command: arbiter request android --wait
   # Output: [ARBITER SHIM] Note: a token for 'adb' also covers 'android' — they share a device lease.

   # This command blocks because Agent A still holds the lease!
   arbiter request android --wait
   # (Blocks and waits...)
   ```
5. **Release Lease (Terminal 2)**: `arbiter release`
6. **Agent B Unblocks**: Terminal 3 will now automatically proceed with its lease grant once the resource is freed. Agent B can then run its command.

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
