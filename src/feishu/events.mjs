import { findDeepKey } from "../utils/json.mjs";

export function eventTypeOf(event) {
  return String(
    event?.event_type
      || event?.type
      || event?.header?.event_type
      || event?.event?.event_type
      || findDeepKey(event, "event_type")
      || "",
  ).trim();
}

export function eventIdOf(event) {
  return String(
    event?.event_id
      || event?.header?.event_id
      || event?.event?.event_id
      || findDeepKey(event, "event_id")
      || "",
  ).trim();
}

export function messageIdOf(event) {
  return String(
    event?.message_id
      || event?.event?.message_id
      || event?.message?.message_id
      || findDeepKey(event, "message_id")
      || findDeepKey(event, "messageId")
      || event?.id
      || "",
  ).trim();
}

export function chatIdOf(event) {
  return String(
    event?.chat_id
      || event?.event?.chat_id
      || event?.message?.chat_id
      || findDeepKey(event, "chat_id")
      || findDeepKey(event, "chatId")
      || "",
  ).trim();
}

export function isRecallEvent(event) {
  const type = eventTypeOf(event);
  return type === "im.message.recalled_v1" || Boolean(event?.recall_time || event?.event?.recall_time);
}
