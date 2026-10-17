# Codex Feishu Bridge Desktop 0.8.24

## Forwarded card references

- Accept incoming `interactive` messages, including a result card forwarded back to its original bot or forwarded to a different bot.
- Extract readable text from the lark-cli `<card>` envelope, received-card JSON, classic cards, schema 2.0 cards, links, and tables.
- Feed card content into the existing Codex conversation as reference material. Without an accompanying request, acknowledge the readable content and wait for the user's next instruction.
- Prevent slash commands inside cards from invoking Bridge controls. Do not download resources merely because quoted card text contains an image key.
- Explain unreadable cards instead of reporting the whole message type as unsupported. Bound extraction and mark locally truncated content as partial.

Forwarding a card does not transfer the original bot's session, local files, credentials, or button actions. Images embedded in structured cards are identified as unread rather than silently treated as inspected images.

## Validation and rollout

Focused parser and real-handler preflight tests cover readable and unreadable cards, raw receive-event fallback, table values, command isolation, and extraction limits. Root checks and Windows desktop build verification are required before publication. No live messages are sent by these tests.

Root checks pass 137/137; desktop checks pass 213 with 3 platform skips. The Windows installer passes packaged-engine verification. The tagged release workflow builds and verifies Windows, macOS, and Ubuntu before stable publication. Device installation waits for active tasks to finish and preserves persistent Bot data.
