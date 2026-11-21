# Security and data handling

This plugin can launch and control local applications. Install it only on a machine where you authorize that capability. It does not request elevation or change OS security policies. Windows helper processes run at the existing Harness host's privilege level. There is no claim of enterprise isolation or independent security audit.

Desktop input uses the upstream Harness CUA provider and its application-control permission flow. The added launch and OCR tools are registered in the Harness tools pipeline. Launching does not grant control consent. App launching accepts an exact ID from a freshly enumerated OS application catalog, with no arbitrary command arguments; it can still trigger application startup side effects.

OCR runs locally via Windows.Media.Ocr or Apple Vision. The OCR tool accepts only image attachment IDs structurally recorded in the active session, never arbitrary image file paths. It writes a temporary image, removes it after processing, and bounds image dimensions and bytes. OCR output becomes part of the agent context and may therefore be sent to the model provider configured by the user. Native processing itself does not upload the image.

Browser automation starts a separate Chromium context per Harness session using the host's Playwright MCP. It does not attach to personal profiles. Web navigation and actions can transmit data to websites requested by the agent/user; page text and OCR are untrusted input. Browser capabilities inherit upstream restrictions. File sandbox enforcement on the tested host was partial.

No custom HTTP listener, telemetry collector, background update downloader, secret storage service, or extra remote API is added. Mutations are not automatically retried after timeout: effects may already have occurred. Observe before retrying. SHA-256 checks detect corruption; they are not code signing.

For security reports, use GitHub private vulnerability reporting if enabled for this repository. Otherwise contact the maintainer through their GitHub profile; do not put secrets, personal screenshots or exploit credentials in a public issue.
