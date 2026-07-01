# rizz

The local Project Intelligence Engine CLI by Valoir.

## Install

```sh
npm install -g @valoir/rizz
```

## Start

```sh
rizz
```

`rizz` scans the current repository and writes `.rizz/brain`, `.rizz/research`, and Mission Control
at `.rizz/reports/index.html`.

Useful local commands:

```sh
rizz brain
rizz explain packages/cli
rizz review
```

Model chat is opt-in:

```sh
rizz setup
rizz chat
```

Use OpenRouter BYOK for the recommended model route. Paste provider keys only into the hidden
`rizz setup` prompt; never paste keys into chat, issues, screenshots, or logs.

## Scope

The default path is local-first repo understanding. Workspace Mode, OS connectors, custom skills,
cloud sync, browser/mobile/IDE integrations, and enterprise providers are not in the default install.
