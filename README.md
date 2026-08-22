# livetree

`livetree` is a parallel-worktree development toolkit. It gives every dev server in every Git worktree a stable HTTPS URL, shares selected services securely over Tailscale, and serves a dashboard for the whole repository.

```text
https://<project>-<worktree>-<script>.localhost
```

For example, the `api` server on branch `fix/login` in project `ecos` becomes `https://ecos-fix-login-api.localhost`. Detached worktrees use a stable hash of their real path, so worktrees created under tools such as Codex do not collide.

## Install

Livetree requires Node.js 20 or newer. Portless is bundled; do not install it separately. Tailnet sharing requires the Tailscale CLI to be installed, connected, and approved for Tailscale Serve.

```sh
npm install --global livetree
```

For local development of this repository:

```sh
npm install
npm link
```

The CLI is named `livetree` rather than `lt`, because `lt` is used by localtunnel.

## Commands

```sh
livetree init
livetree ls
livetree dev <script> [args...]
livetree tunnel <script>
livetree tunnel stop [<script>|all]
livetree serve [--tailscale] [--port <number>]
```

A bare configured script name is shorthand for `dev`, so `livetree web` and `livetree dev web` are equivalent.

Run commands from any worktree. Livetree always reads `.ltconf` from the main worktree, so linked worktrees do not need their own copy.

## Configuration

Create `.ltconf` at the main worktree root:

```yaml
name: ecos

init:
  copy:
    - modules/api/.env
    - modules/web/.env.development.local
    - modules/mobile/.env.local
    - AGENTS.md
  script: pnpm install

dev:
  api:
    cmd: pnpm --dir modules/api start
  web:
    cmd: pnpm --dir modules/web start
    env:
      ECOS_API_BASE: ${url:api}
    tunnelEnv:
      ECOS_API_BASE: ${tunnelUrl:api}
  metro:
    cmd: pnpm --dir modules/mobile start
    portArg: --port
    tunnelPort: app
    env:
      EXPO_PUBLIC_BASE_URL_LOCAL: ${url:api}

links:
  graphiql: ${url:api}/graphiql
  device: ecosconnect-development://expo-development-client/?url=${enc:tunnelUrl:metro}&apiBaseUrl=${enc:tunnelUrl:api}
```

The v2 schema is intentionally strict; old `run:` and shorthand `init:` forms are not supported.

### Interpolation

- `${url:api}` resolves to that worktree's stable local URL.
- `${tunnelUrl:api}` resolves to its live, tailnet-only Tailscale Serve URL and produces a clear error if no share exists.
- `${enc:tunnelUrl:api}` and `${enc:url:api}` URL-encode the resolved value.

Values are resolved when a server starts or dashboard links render. `tunnelEnv` overrides matching `env` keys while a script is operating with tunnel dependencies.

### Initialization

`livetree init` initializes every worktree that lacks `.livetree/initialized`. It copies configured files from the main worktree when the destination is missing, runs the init script in each worktree, and then writes the marker. Missing source files are reported and skipped; existing destination files are preserved.

## Dev servers

```sh
livetree dev api
livetree web
```

The process stays in the foreground. Livetree starts the bundled portless proxy on unprivileged port 1355 when necessary, interpolates the configured environment, and registers the process under `<main-worktree>/.livetree/state/` while it is alive. On the first run, portless may request permission to trust its local certificate authority.

Portless recognizes common frameworks, including Vite and Expo, and injects their port arguments when invoked directly. When a framework is hidden behind a package-manager script, or another tool does not honor `PORT`, configure its flag explicitly. Livetree will append the flag and a dynamically allocated unprivileged port:

```yaml
dev:
  custom:
    cmd: my-server
    portArg: --port
```

If a wrapped framework also ignores `HOST`, include its host option in `cmd`;
for example, `pnpm start --host 127.0.0.1` for Vite.

## Tailnet sharing

Start the local server first, then share it with devices and users authenticated to your Tailscale network:

```sh
livetree dev api
livetree tunnel api
```

Livetree allocates a Tailscale HTTPS port, starts `tailscale serve`, and waits for the tailnet URL to respond before reporting it ready. The URL uses this Mac's stable MagicDNS name. It is not exposed to the public internet.

Some development servers include their listening port in URLs they generate. Expo Metro does this for the bundle URL in a development manifest. Set `tunnelPort: app` for those scripts so the Tailscale HTTPS port matches the dynamically allocated application port. The application port remains unprivileged; Livetree reports a conflict instead of silently choosing a different tunnel port.

If a script's `tunnelEnv` references another script, Livetree ensures that dependency tunnel first. Dashboard-managed servers are restarted automatically with the resolved tunnel environment. A foreground server cannot be restarted behind its terminal, so Livetree stops and tells you which `livetree dev` command to rerun.

```sh
livetree tunnel stop api
livetree tunnel stop
livetree tunnel stop all
```

With no target, `stop` affects tunnels for the current worktree. `all` affects this repository.

## Dashboard

```sh
livetree serve
```

The responsive SolidJS dashboard binds to `127.0.0.1` and organizes projects into worktrees, then servers and configured links. It shows server health, Tailscale URLs, and QR codes, and its buttons start and stop managed dev servers and tailnet shares. Choose **Logs** on a running server to open the xterm-powered live output pane. Server logs live below each project's `.livetree/state/logs/`, including foreground servers started with `livetree dev`.

Every configured repository where you run a livetree command is added to `~/.livetree/projects.json`. The project rail shows all valid registered repositories, most recently used first after the repository that launched the dashboard. Missing repositories and repositories without a valid `.ltconf` are ignored. Set `LIVETREE_HOME` to use a different catalog directory, which is also useful for isolated testing.

To open the dashboard on another device:

```sh
livetree serve --tailscale
```

This exposes the dashboard through Tailscale Serve and prints its tailnet-only URL and a terminal QR code. Open it from a phone running Tailscale and signed into an authorized tailnet account; Tailscale provides the authentication and access policy.

Use `--port <number>` to change the local dashboard port; `--port 0` asks the operating system for a free port.

## Listing worktrees

```sh
livetree ls
```

The list includes one entry per active Git worktree: age, branch or primary-chat label, linked-worktree path, registered local servers, uptime, and tailnet URLs. The main checkout omits its path and chat history. The dashboard uses the same filtering. Stale process records are removed automatically.
