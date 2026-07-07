export function createManagedCardClass({
  larkJson,
  larkJsonWithData,
  findDeepKey,
  idempotencyKey,
  useThreadReply = false,
  cardThrottleMs = 400,
  log = () => {},
} = {}) {
  return class ManagedCard {
    constructor(cardId, messageId) {
      this.cardId = cardId;
      this.messageId = messageId;
      this.sequence = 0;
      this.pendingCard = null;
      this.pendingTimer = null;
      this.inFlight = null;
      this.closed = false;
      this.lastFlushOk = true;
    }

    static async open(chatId, replyToMessageId, initialCard, idempotencyBase) {
      const created = await larkJsonWithData([
        "api",
        "POST",
        "/open-apis/cardkit/v1/cards",
        "--as",
        "bot",
      ], { type: "card_json", data: JSON.stringify(initialCard) }, { timeoutMs: 60_000, attempts: 2 });

      const cardId = findDeepKey(created, "card_id");
      if (!cardId) {
        throw new Error(`CardKit create returned no card_id: ${JSON.stringify(created).slice(0, 500)}`);
      }

      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      let sent;
      if (replyToMessageId) {
        const args = [
          "im",
          "+messages-reply",
          "--as",
          "bot",
          "--message-id",
          replyToMessageId,
          "--msg-type",
          "interactive",
          "--content",
          content,
          "--idempotency-key",
          idempotencyKey(idempotencyBase, "card-reply"),
        ];
        if (useThreadReply) args.push("--reply-in-thread");
        try {
          sent = await larkJson(args, { timeoutMs: 60_000, attempts: 2 });
        } catch (error) {
          log("WARN", "card reply failed; falling back to chat send", { error: String(error.message || error) });
        }
      }

      if (!sent) {
        sent = await larkJson([
          "im",
          "+messages-send",
          "--as",
          "bot",
          "--chat-id",
          chatId,
          "--msg-type",
          "interactive",
          "--content",
          content,
          "--idempotency-key",
          idempotencyKey(idempotencyBase, "card-send"),
        ], { timeoutMs: 60_000, attempts: 2 });
      }

      const messageId = findDeepKey(sent, "message_id") || "";
      return new ManagedCard(cardId, messageId);
    }

    update(card) {
      if (this.closed) return;
      this.pendingCard = card;
      if (this.pendingTimer || this.inFlight) return;
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        void this.flush();
      }, cardThrottleMs);
    }

    async flush(card) {
      if (this.closed) return;
      if (card) this.pendingCard = card;
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      if (this.inFlight) {
        await this.inFlight.catch(() => {});
      }
      if (!this.pendingCard) return true;

      const next = this.pendingCard;
      this.pendingCard = null;
      const sequence = ++this.sequence;
      this.inFlight = (async () => {
        try {
          await larkJsonWithData([
            "api",
            "PUT",
            `/open-apis/cardkit/v1/cards/${this.cardId}`,
            "--as",
            "bot",
          ], {
            card: { type: "card_json", data: JSON.stringify(next) },
            sequence,
          }, { timeoutMs: 60_000, attempts: 2 });
          this.lastFlushOk = true;
          return true;
        } catch (error) {
          this.lastFlushOk = false;
          log("WARN", "card update failed", {
            cardId: this.cardId,
            sequence,
            error: String(error.message || error).slice(0, 1000),
          });
          return false;
        }
      })();
      const ok = await this.inFlight;
      this.inFlight = null;
      if (this.pendingCard && !this.closed) this.update(this.pendingCard);
      return ok;
    }

    close() {
      this.closed = true;
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  };
}
