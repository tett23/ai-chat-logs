// docs/adr/0034: pure conversion of one fixed Codex JSONL snapshot to the existing transcript shape.
type ObjectValue = Record<string, unknown>;
type Block = { type: "text" | "thinking" | "tool_use" | "tool_result"; [key: string]: unknown };
export type Conversion = { messages: string; sessionId: string | null; messageCount: number; warnings: string[]; status: 0 | 1 };

const object = (value: unknown): ObjectValue | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as ObjectValue : null;
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const sha256 = (value: string): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value as ObjectValue).sort().map((key) => [key, stable((value as ObjectValue)[key])])) : value;
const hashObject = (value: unknown): string => sha256(JSON.stringify(stable(value)));
const textBlock = (text: string): Block => ({ type: "text", text });
const encryptedBlock = (): Block => textBlock("暗号化された内容は表示できない");

const contentBlocks = (values: unknown[], kinds: readonly string[], warnings: string[], line: number): Block[] => values.flatMap((value) => {
  const entry = object(value);
  if (entry === null) { warnings.push(`line ${line}: unknown content block`); return []; }
  if (entry.type === "encrypted_content") { warnings.push(`line ${line}: encrypted content`); return [encryptedBlock()]; }
  if (typeof entry.type === "string" && kinds.includes(entry.type) && typeof entry.text === "string") return [textBlock(entry.text)];
  warnings.push(`line ${line}: unknown content block ${String(entry.type)}`);
  return [];
});

const projected = (item: ObjectValue, warnings: string[], line: number): { type: "user" | "assistant"; blocks: Block[]; originalRole: string | null } | null => {
  const kind = string(item.type);
  if (kind === "message") {
    const role = string(item.role);
    if (role === "system" || role === "developer") return null;
    if (role !== "user" && role !== "assistant") { warnings.push(`line ${line}: unknown message role ${role}`); return null; }
    return { type: role, blocks: contentBlocks(array(item.content), ["input_text", "output_text"], warnings, line), originalRole: role };
  }
  if (kind === "reasoning") {
    const blocks = array(item.summary).flatMap((value): Block[] => {
      const part = object(value);
      if (part?.type === "summary_text" && typeof part.text === "string") return [{ type: "thinking", thinking: part.text }];
      warnings.push(`line ${line}: unknown reasoning summary`);
      return [];
    });
    if (item.encrypted_content != null) { blocks.push(encryptedBlock()); warnings.push(`line ${line}: encrypted reasoning`); }
    return { type: "assistant", blocks, originalRole: null };
  }
  if (kind === "function_call" || kind === "custom_tool_call") {
    const name = string(item.name);
    if (name === null) warnings.push(`line ${line}: tool name missing`);
    const input = kind === "function_call" ? item.arguments : item.input;
    const raw = typeof input === "string" ? input : JSON.stringify(input ?? null);
    return { type: "assistant", blocks: [{ type: "tool_use", name: name ?? "unknown", id: string(item.call_id), input: { raw } }], originalRole: null };
  }
  if (kind === "function_call_output" || kind === "custom_tool_call_output") {
    const output = item.output;
    return { type: "user", blocks: [{ type: "tool_result", tool_use_id: string(item.call_id), content: typeof output === "string" ? output : JSON.stringify(output ?? null) }], originalRole: null };
  }
  if (kind === "agent_message") {
    const blocks = contentBlocks(array(item.content), ["input_text", "output_text"], warnings, line);
    const author = string(item.author) ?? "agent", recipient = string(item.recipient) ?? "unknown";
    return { type: "assistant", blocks: blocks.map((b) => b.type === "text" ? textBlock(`[${author} → ${recipient}] ${b.text}`) : b), originalRole: null };
  }
  if (kind !== "additional_tools") warnings.push(`line ${line}: unknown response item ${kind}`);
  return null;
};

export const convertCodexLines = (rawLines: readonly string[]): Conversion => {
  if (rawLines.length === 0) return { messages: "", sessionId: null, messageCount: 0, warnings: [], status: 0 };
  const warnings: string[] = [];
  let status: 0 | 1 = 0;
  let first: ObjectValue | null = null;
  try { first = object(JSON.parse(rawLines[0] as string)); } catch { /* reported below */ }
  const payload = first?.type === "session_meta" ? object(first.payload) : null;
  const sessionId = string(payload?.id);
  if (sessionId === null || sessionId === "") return {
    messages: "", sessionId: null, messageCount: 0, warnings: ["line 1: first session_meta.payload.id missing"], status: 1,
  };
  const cwd = string(payload?.cwd);
  const rows: ObjectValue[] = [];
  let firstUserText: string | null = null;
  rawLines.forEach((raw, index) => {
    let record: ObjectValue | null;
    try { record = object(JSON.parse(raw)); } catch { warnings.push(`line ${index + 1}: invalid JSON`); status = 1; return; }
    if (record?.type !== "response_item") {
      if (record && typeof record.type === "string" && !["session_meta", "event_msg", "world_state", "turn_context", "token_count", "token_usage_record", "inter_agent_communication_metadata", "compacted", "turn_started", "turn_complete"].includes(record.type))
        warnings.push(`line ${index + 1}: unknown record ${record.type}`);
      return;
    }
    const item = object(record.payload);
    if (item === null) { warnings.push(`line ${index + 1}: missing response_item payload`); return; }
    const p = projected(item, warnings, index + 1);
    if (p === null || p.blocks.length === 0) return;
    if (firstUserText === null && p.type === "user" && item.type === "message") {
      const text = array(item.content).map(object).filter((b) => b && (b.type === "input_text" || b.type === "output_text"))
        .map((b) => string(b?.text) ?? "").join(" ").trim();
      if (text !== "") firstUserText = Array.from(text).slice(0, 80).join("");
    }
    const itemId = string(item.id) || String(index + 1);
    const parentId = string(item.parent_id) ?? string(item.parentUuid);
    const uuid = hashObject({ provider: "codex", sessionId, itemId, blocks: p.blocks, originalRole: p.originalRole, parentId, blockKinds: p.blocks.map((b) => b.type) });
    rows.push({ type: p.type, uuid, sessionId, timestamp: string(record.timestamp), cwd, sourceOrder: index + 1,
      message: { role: p.type, content: p.blocks },
      openai: { sourceLine: index + 1, itemId: string(item.id), parentId, originalRole: p.originalRole, channel: string(item.channel) ?? string(item.phase), version: uuid.slice(0, 12) },
    });
  });
  const title = rows.length > 0 ? [{ type: "custom-title", sessionId, customTitle: firstUserText ?? sessionId }] : [];
  return { messages: [...title, ...rows].map((r) => `${JSON.stringify(r)}\n`).join(""), sessionId, messageCount: rows.length, warnings, status };
};
