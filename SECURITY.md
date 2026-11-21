# Security and data handling

This plugin can launch and control local applications. Install it only on a machine where you authorize that capability. It does not request elevation or change OS security policies. Windows helper processes run at the existing Harness host's privilege level. There is no claim of enterprise isolation or independent security audit.

Windows desktop input uses a pinned, vendored Harness CUA provider with a documented fullAccessControlsDesktop option (default true). It maps the live session danger-full-access mode to transient application access without prompting or persisting grants. Each operation rechecks mode and explicit denials. Delegated sessions do not receive this shortcut. Disable the option to retain upstream per-application approval. The added launch and OCR tools are registered in the Harness tools pipeline. Launching does not grant control consent. App launching accepts an exact ID from a freshly enumerated OS application catalog, with no arbitrary command arguments; it can still trigger application startup side effects.

OCR runs locally via Windows.Media.Ocr or Apple Vision. The OCR tool accepts only image attachment IDs structurally recorded in the active session, never arbitrary image file paths. It writes a temporary image, removes it after processing, and bounds image dimensions and bytes. OCR output becomes part of the agent context and may therefore be sent to the model provider configured by the user. Native processing itself does not upload the image.

Browser automation starts a separate Chromium context per Harness session using the host's Playwright MCP. It does not attach to personal profiles. Web navigation and actions can transmit data to websites requested by the agent/user; page text and OCR are untrusted input. Browser capabilities inherit upstream restrictions. File sandbox enforcement on the tested host was partial.

No custom HTTP listener, telemetry collector, background update downloader, secret storage service, or extra remote API is added. Mutations are not automatically retried after timeout: effects may already have occurred. Observe before retrying. SHA-256 checks detect corruption; they are not code signing.

For security reports, use GitHub private vulnerability reporting if enabled for this repository. Otherwise contact the maintainer through their GitHub profile; do not put secrets, personal screenshots or exploit credentials in a public issue.

Windows file adapters require full access, operate on saved files only, stage edits and refuse to overwrite outputs. They do not read unsaved application content or recalculate spreadsheet formulas. Desktop capture/pointer tools require full access and reject use while any app is explicitly blocked. Screenshot tokens are agent-scoped, single-use and expire after 30 seconds. Normal exception paths release a pressed pointer button; forced process termination can still leave input held. No claim of crash-proof input release is made.
