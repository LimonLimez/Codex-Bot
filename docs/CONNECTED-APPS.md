# Connected apps

Open Bot keeps the genuine Grok Bot desktop shell. The stock **Plugins** row in its sidebar is restored as **Connected apps** and opens a local Open Bot dialog backed by [Composio Tool Router](https://docs.composio.dev/docs/tool-router/overview).

## Connect Composio

1. Create or choose a project in the [Composio dashboard](https://platform.composio.dev/).
2. Open **Connected apps** in the Open Bot sidebar.
3. Enter the project's API key. Open Bot protects it with Windows DPAPI for the current user.
4. Choose **Connect** beside an app and finish OAuth in the Composio page that opens.

Open Bot accepts connection links only on HTTPS `composio.dev` hosts. Provider OAuth tokens stay with Composio. Local configuration contains a DPAPI ciphertext, a random Open Bot user identifier, and a Composio session identifier—never the provider OAuth token.

## How coworkers use apps

Configured coworkers receive two tools:

- `SearchConnectedApps` asks Tool Router for a small relevant action set, optionally narrowed to particular apps.
- `RunConnectedAppAction` runs one exact action returned by that search.

The session disables Composio sandbox and proxy execution, automatic file upload/download, and sensitive-file upload. Searches, arguments, and results have local size limits. Open Bot does not load every app action into the prompt.

Read-like actions (`GET`, `LIST`, `SEARCH`, `READ`, and similar names) may run normally. Other non-destructive writes require the coworker to mark that the current user message directly requested that exact outcome. Destructive actions containing `DELETE`, `REMOVE`, `REVOKE`, `CANCEL`, `ARCHIVE`, `DISABLE`, or `DEACTIVATE` are rejected. The write check is model-enforced rather than a trusted approval dialog; connect only the accounts and scopes you are comfortable exposing.

## Remove or revoke access

**Remove project** deletes Open Bot's local protected Composio configuration and removes connected-app tools from later turns. It does not delete or revoke remote connected accounts. Revoke those in the Composio dashboard or the service provider's security settings.

## Troubleshooting

- If the list is empty, confirm the project key and check that the Composio project can create Tool Router sessions.
- If an app remains disconnected, finish its OAuth page, return to Open Bot, and leave the dialog open while it refreshes.
- If a coworker says connected apps are unavailable, start a new turn after configuration; tools are selected when a turn begins.
- If an action is blocked as destructive, perform it yourself in the provider's interface.

References: [Tool Router](https://docs.composio.dev/docs/tool-router/overview), [TypeScript SDK](https://docs.composio.dev/reference/sdk-reference/typescript), and [connected accounts](https://docs.composio.dev/docs/auth-configuration/connected-accounts).
