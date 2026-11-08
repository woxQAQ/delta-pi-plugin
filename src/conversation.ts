import { createHash } from "node:crypto";
import type { Json } from "./cli.js";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function messageKey(message: Json): string {
  return fingerprint(message);
}

function content(value: unknown): Json[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap<Json>((block: Json) => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "image") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    return [];
  });
}

/** Translate finalized Pi messages; system prompts and extension context remain local. */
export function messageUpdates(message: Json, id = messageKey(message)): Json[] {
  if (message.role === "user") {
    return [{ sessionUpdate: "user_message", messageId: id, content: content(message.content) }];
  }
  if (message.role === "toolResult") {
    return [{
      sessionUpdate: "tool_call_update", toolCallId: message.toolCallId,
      status: message.isError ? "failed" : "completed", rawOutput: message.content,
      content: content(message.content).map((block) => ({ type: "content", content: block })),
    }];
  }
  if (message.role !== "assistant") return [];
  return message.content.flatMap((block: Json, index: number) => {
    if (block.type === "text" && block.text) {
      return [{ sessionUpdate: "agent_message", messageId: `${id}:${index}`, content: content(block.text) }];
    }
    if (block.type === "thinking" && block.thinking) {
      return [{ sessionUpdate: "agent_thought", messageId: `${id}:${index}`, content: content(block.thinking) }];
    }
    if (block.type === "toolCall") {
      const kind = ({ read: "read", bash: "execute", edit: "edit", write: "edit", grep: "search", find: "search", ls: "search" } as Json)[block.name] ?? "other";
      return [{
        sessionUpdate: "tool_call_update", toolCallId: block.id, name: block.name,
        title: block.name, kind, status: "in_progress", rawInput: block.arguments,
      }];
    }
    return [];
  });
}

/** A watch reconnect replaces its entire snapshot; IDs and hashes deduplicate deliveries. */
export class RemoteView {
  readonly items = new Map<string, Json>();
  readonly comments = new Map<string, Json>();
  live = false;

  apply(frame: Json): void {
    switch (frame.type) {
      case "item": this.items.set(frame.item.id, frame.item); break;
      case "item.append": {
        const item = this.items.get(frame.id);
        if (item) this.items.set(frame.id, { ...item, content: { ...item.content, text: (item.content.text ?? "") + frame.text } });
        break;
      }
      case "remove": this.items.delete(frame.id); break;
      case "comment": this.comments.set(frame.comment.id, frame.comment); break;
      case "comment.remove": this.comments.delete(frame.id); break;
      case "live": this.live = true; break;
    }
  }

  deliveries(): { key: string; hash: string; text: string }[] {
    if (!this.live) return [];
    const result: { key: string; hash: string; text: string }[] = [];
    const remaining = new Map(this.items);
    const visited = new Set<string>();
    // Resolve predecessor links before delivering any successor, including out-of-order arrivals.
    while (remaining.size) {
      let progressed = false;
      for (const [id, item] of remaining) {
        if (item.after_id && !visited.has(item.after_id)) continue;
        remaining.delete(id);
        visited.add(id);
        progressed = true;
        if (item.open || item.kind === "agent_thought") continue;
        const text = item.content?.text ?? JSON.stringify(item.content);
        if (text) result.push({
          key: `item:${id}`, hash: fingerprint(item.content),
          text: `[${item.author?.name ?? "Collaborator"} · ${item.kind}]\n${text}`,
        });
      }
      if (!progressed) break;
    }
    for (const [id, comment] of this.comments) {
      if (!this.items.has(comment.delivered_with)) continue;
      result.push({
        key: `comment:${id}`, hash: fingerprint(comment),
        text: `[Comment from ${comment.author?.name ?? "collaborator"}]\n${comment.text}\n${JSON.stringify(comment.target ?? {})}`,
      });
    }
    return result;
  }
}
