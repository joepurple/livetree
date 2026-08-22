---
name: livetree
description: Configure LiveTree for a project and run isolated dev servers for testing in Git worktrees.
---

# LiveTree

Create `.ltconf` in the main worktree; from a linked worktree, find it with `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`. LiveTree reads that config from every worktree.

```yaml
name: project-name
init:
  copy:
    - .env
  script: npm install
dev:
  web:
    cmd: npm run dev
```

Match `init`, copied local files, and `dev` commands to the project. If a server does not honor `PORT`, set its `portArg` to the flag needed to pass a dynamic port.

From the worktree being tested, run `livetree init` once, then start each server with `livetree <script>`. Keep the foreground process running and use the HTTPS URL it prints; do not choose or hard-code a port.
