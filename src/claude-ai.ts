// docs/adr/0006: convert a claude.ai data export into lines shaped like Claude Code transcript records.

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const exportId = (conversations: string | Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(conversations).digest("hex").slice(0, 16);

const role = (sender: string | null): string => (sender === "human" ? "user" : (sender ?? "user"));

const content = (message: JsonObject): unknown[] => {
  const blocks = arr(message.content);
  return blocks.length > 0 ? blocks : [{ type: "text", text: str(message.text) ?? "" }];
};

const conversationInfo = (c: JsonObject) => ({
  uuid: str(c.uuid),
  name: str(c.name),
  created_at: str(c.created_at),
  updated_at: str(c.updated_at),
});

const messageLine = (c: JsonObject, m: JsonObject): string => {
  const sender = str(m.sender);
  const r = role(sender);
  return JSON.stringify({
    type: r,
    uuid: str(m.uuid),
    parentUuid: str(m.parent_message_uuid),
    sessionId: str(c.uuid),
    timestamp: str(m.created_at),
    message: { role: r, content: content(m) },
    claudeAi: {
      conversation: conversationInfo(c),
      sender,
      attachments: arr(m.attachments),
      files: arr(m.files),
    },
  });
};

const conversationLines = (c: JsonObject): string[] => {
  const name = str(c.name);
  const title = name ? [JSON.stringify({ type: "custom-title", customTitle: name, sessionId: str(c.uuid) })] : [];
  return [...title, ...arr(c.chat_messages).filter(isObject).map((m) => messageLine(c, m))];
};

const byCreatedThenUuid = (a: JsonObject, b: JsonObject): number => {
  const key = (c: JsonObject) => [str(c.created_at) ?? "", str(c.uuid) ?? ""] as const;
  const [ka, kb] = [key(a), key(b)];
  return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
};

// Lines of messages.jsonl; throws when the export is not an array of conversations.
export const convertConversations = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("conversations.json is not an array");
  return value.filter(isObject).toSorted(byCreatedThenUuid).flatMap(conversationLines);
};
