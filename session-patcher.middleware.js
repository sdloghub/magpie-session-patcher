// Phase-one Magpie gateway middleware. Standard JS only; no filesystem, I/O,
// response hooks, persistent state, or model calls. Refusal phrases adapted
// from codex_session_patcher/core/detector.py in this repository (see NOTICE).
const STRONG = [
  "我无法协助", "我无法帮助", "我不能协助", "我不能帮助", "我不能做", "我无法做",
  "我不会帮", "我无法提供", "不能继续做这件事", "无法继续做这件事", "不会继续做这件事",
  "不能继续处理这件事", "无法继续处理这件事", "违反了我的", "违反我的", "这违反",
  "我拒绝", "我必须拒绝", "i cannot assist", "i can't assist", "i'm unable to assist",
  "i cannot help", "i can't help", "i'm unable to help", "i must decline", "i must refuse",
  "against my guidelines", "against my policy", "violates my", "i won't help", "i won't assist",
  "as an ai", "as a language model", "i apologize, but i", "i'm sorry, but i can't",
  "not able to provide", "not able to assist"
];
const WEAK = [
  "抱歉", "很抱歉", "对不起", "不好意思", "我无法", "我不能", "不允许", "禁止",
  "不能帮你", "不能协助", "无法帮你", "无法协助你", "不会帮你", "不会帮助", "不能为你",
  "无法为你", "不能继续做这", "无法继续做这", "不能继续处理这", "无法继续处理这",
  "sorry", "apologize", "i cannot", "i can't", "i'm unable", "unable to", "not permitted",
  "not allowed", "refuse to"
];
const DIRECT = [
  "我无法协助", "我无法帮助", "我不能协助", "我不能帮助", "我不能帮你", "我无法帮你",
  "我不会帮", "我无法提供", "不能帮你", "不能协助", "无法帮你", "无法协助你",
  "不会帮你", "不会帮助", "不能为你", "无法为你", "我拒绝", "我必须拒绝",
  "不能继续做这件事", "无法继续做这件事", "不会继续做这件事",
  "不能继续处理这件事", "无法继续处理这件事",
  "i cannot assist", "i can't assist", "i'm unable to assist", "i cannot help", "i can't help",
  "i'm unable to help", "i must decline", "i must refuse", "i won't help", "i won't assist"
];
const DEFAULT_REPLACEMENT = "[History filter: the previous assistant text was replaced. This is not evidence of any action or result.]";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function detects(text, options, replacement) {
  if (!text || text.includes(replacement)) return false;
  const lower = text.trimStart().toLowerCase().replace(/[’‘]/g, "'");
  if (Array.isArray(options.customKeywords) && options.customKeywords.some(
    word => typeof word === "string" && word.trim() && lower.includes(word.toLowerCase())
  )) return true;
  if (options.detection === "legacy") {
    return STRONG.some(word => lower.includes(word))
      || WEAK.some(word => lower.slice(0, 150).includes(word));
  }
  // Unlike legacy matching, quoted phrases, apologies alone and code examples
  // do not qualify. This is a heuristic, not a semantic classifier.
  const head = lower.replace(/^(?:(?:很抱歉|抱歉|对不起|不好意思)[，,。!！:：\s]*|(?:i'm sorry|i am sorry|sorry|i apologize)[,.:!\s]*(?:but\s+)?)/, "");
  // "I cannot help but notice" is an idiom, not a refusal. English prefixes
  // must end at a word boundary ("assistive" is not "assist").
  if (/^i (?:cannot|can't|won't) help but\b/.test(head)) return false;
  return DIRECT.some(word => head.startsWith(word)
    && (!/^[a-z]/.test(word) || !/[a-z]/.test(head.charAt(word.length))));
}

function textPart(part, protocol) {
  if (!object(part) || typeof part.text !== "string") return false;
  if (part.signature !== undefined || part.thoughtSignature !== undefined || part.thought_signature !== undefined) return false;
  if (protocol === "gemini") {
    return !part.thought && !part.thoughtSignature && !part.thought_signature
      && !part.functionCall && !part.functionResponse;
  }
  return part.type === "text" || (protocol === "responses" && part.type === "output_text");
}

function content(value, protocol, options, replacement, allowReasoning) {
  if (typeof value === "string") {
    return options.replaceRefusals !== false && detects(value, options, replacement) ? replacement : value;
  }
  if (!Array.isArray(value)) return value;
  let parts = value;
  if (options.cleanReasoning === true && allowReasoning) {
    parts = parts.filter(part => !object(part) || (protocol === "anthropic"
      ? part.type !== "thinking" && part.type !== "redacted_thinking"
      : protocol !== "gemini" || part.thought !== true
        || part.functionCall !== undefined || part.functionResponse !== undefined));
  }
  if (options.replaceRefusals !== false) {
    // Join text fragments for matching, but preserve all non-text blocks and
    // their ordering. An annotation/signature belongs to the old text; do not
    // reuse it on the replacement.
    const text = parts.filter(part => textPart(part, protocol)).map(part => part.text).join("");
    if (detects(text, options, replacement)) {
      let replaced = false;
      parts = parts.filter(part => {
        if (!textPart(part, protocol)) return true;
        if (replaced) return false;
        replaced = true;
        return true;
      }).map(part => textPart(part, protocol)
        ? { ...part, text: replacement, ...(part.annotations !== undefined ? { annotations: [] } : {}) }
        : part);
    }
  }
  // Removing a thinking-only message entirely could violate alternating-role
  // APIs. Retain its original blocks rather than inventing a message.
  return parts.length ? parts : value;
}

function hasOpaqueResponsesHistory(body, ctx) {
  return /\/compact\/?(?:\?|$)/.test(ctx.path || "")
    || body.previous_response_id != null || body.conversation != null
    || (Array.isArray(body.context_management) && body.context_management.some(item => item?.type === "compaction"))
    || (Array.isArray(body.input) && body.input.some(item => object(item)
      && (["compaction", "item_reference"].includes(item.type)
        || (item.encrypted_content !== undefined && item.type !== "reasoning"))));
}

function appendText(existing, prompt) {
  if (!existing) return prompt;
  return existing.includes(prompt) ? existing : existing + "\n\n" + prompt;
}

function addPrompt(body, protocol, prompt) {
  if (!prompt.trim()) return;
  if (protocol === "responses") {
    if (body.instructions == null || typeof body.instructions === "string") {
      body.instructions = appendText(body.instructions, prompt);
    }
  } else if (protocol === "anthropic") {
    if (body.system == null || typeof body.system === "string") body.system = appendText(body.system, prompt);
    else if (Array.isArray(body.system) && !body.system.some(part => typeof part?.text === "string" && part.text.includes(prompt))) {
      body.system.push({ type: "text", text: prompt });
    }
  } else if (protocol === "chat" && Array.isArray(body.messages)) {
    // Keep system/developer instructions in front of all conversation turns.
    let index = 0;
    while (index < body.messages.length && ["system", "developer"].includes(body.messages[index]?.role)) index++;
    if (!body.messages.some(message => ["system", "developer"].includes(message?.role)
      && (typeof message.content === "string" ? message.content.includes(prompt)
        : Array.isArray(message.content) && message.content.some(part => typeof part?.text === "string" && part.text.includes(prompt))))) {
      body.messages.splice(index, 0, { role: "system", content: prompt });
    }
  } else if (protocol === "gemini") {
    const key = body.system_instruction && !body.systemInstruction ? "system_instruction" : "systemInstruction";
    if (body[key] == null) body[key] = { parts: [{ text: prompt }] };
    else if (object(body[key]) && Array.isArray(body[key].parts)
      && !body[key].parts.some(part => typeof part?.text === "string" && part.text.includes(prompt))) {
      body[key].parts.push({ text: prompt });
    }
  }
}

function validOptions(options) {
  if (!object(options)) return false;
  for (const key of ["enabled", "replaceRefusals", "cleanReasoning"]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") return false;
  }
  for (const key of ["agents", "models"]) {
    if (options[key] !== undefined && (!Array.isArray(options[key])
      || !options[key].every(value => typeof value === "string" && value.trim().length))) return false;
  }
  for (const key of ["replacement", "appendPrompt"]) {
    if (options[key] !== undefined && typeof options[key] !== "string") return false;
  }
  if (options.customKeywords !== undefined && !Array.isArray(options.customKeywords)) return false;
  return options.detection === undefined || ["conservative", "legacy"].includes(options.detection);
}

export function onRequest(body, ctx) {
  const options = ctx.options || {};
  if (!validOptions(options) || options.enabled !== true || !object(body)) return;
  const protocol = ctx.protocol;
  if (!["responses", "chat", "anthropic", "gemini"].includes(protocol)) return;
  if (Array.isArray(options.agents) && options.agents.length && !options.agents.includes(ctx.agent)) return;
  if (Array.isArray(options.models) && options.models.length && !options.models.some(
    prefix => typeof prefix === "string" && prefix.length && String(body.model || ctx.model || "").startsWith(prefix)
  )) return;
  // No partial rewrite of an opaque/server-managed history. It may include
  // unseen messages, and altering the visible tail cannot clean that history.
  if (protocol === "responses" && hasOpaqueResponsesHistory(body, ctx)) return;
  const before = JSON.stringify(body);
  const copy = JSON.parse(before);
  const replacement = typeof options.replacement === "string" && options.replacement.trim()
    ? options.replacement : DEFAULT_REPLACEMENT;
  if (protocol === "responses" && Array.isArray(copy.input)) {
    // Native tool items may require their preceding reasoning item. Leave
    // reasoning intact whenever anything except plain messages is present.
    const portable = copy.input.every(item => object(item)
      && (item.type === "reasoning" || item.type === "message" || (!item.type && typeof item.role === "string")));
    if (options.cleanReasoning === true && portable) {
      const remaining = copy.input.filter(item => item.type !== "reasoning");
      if (remaining.length) copy.input = remaining;
    }
    for (const item of copy.input) {
      if (object(item) && item.role === "assistant" && (!item.type || item.type === "message")) {
        item.content = content(item.content, protocol, options, replacement, false);
      }
    }
  } else if (["chat", "anthropic"].includes(protocol) && Array.isArray(copy.messages)) {
    for (const message of copy.messages) {
      if (!object(message) || message.role !== "assistant") continue;
      const hasTools = Array.isArray(message.content) && message.content.some(part => part?.type === "tool_use" || part?.type === "server_tool_use");
      const hasChatTools = (Array.isArray(message.tool_calls) && message.tool_calls.length) || message.function_call;
      message.content = content(message.content, protocol, options, replacement, !hasTools && !hasChatTools);
      if (protocol === "chat" && options.cleanReasoning === true && !hasChatTools) {
        // Preserve reasoning-only messages: null content without a tool call
        // is not a useful portable assistant message.
        if ((typeof message.content === "string" && message.content.length)
          || (Array.isArray(message.content) && message.content.length)) {
          delete message.reasoning_content;
          delete message.reasoning;
        }
      }
    }
  } else if (protocol === "gemini" && Array.isArray(copy.contents)) {
    for (const message of copy.contents) {
      if (!object(message) || message.role !== "model") continue;
      const hasTools = Array.isArray(message.parts) && message.parts.some(part => part?.functionCall || part?.functionResponse);
      message.parts = content(message.parts, protocol, options, replacement, !hasTools);
    }
  }
  if (typeof options.appendPrompt === "string") addPrompt(copy, protocol, options.appendPrompt);
  return JSON.stringify(copy) === before ? undefined : copy;
}
