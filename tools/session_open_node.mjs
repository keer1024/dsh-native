// Measure Node-side session-open cost: JSON parse per record, projection build, render-surface counts.
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const now = () => Number(process.hrtime.bigint()) / 1e6;

for (const f of files) {
  const t0 = now();
  const text = readFileSync(f, 'utf8');
  const t1 = now();
  const lines = text.split('\n');
  const parsed = [];
  for (const l of lines) {
    if (!l) continue;
    try { parsed.push(JSON.parse(l)); } catch {}
  }
  const t2 = now();
  parsed.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  // projection: pair tool calls, group into turns, count content blocks to render
  const byCall = new Map();
  let blocks = 0, codeFences = 0, chars = 0, reasoningBlocks = 0;
  let toolResults = 0, toolCalls = 0, messages = 0;
  for (const r of parsed) {
    const d = r.data ?? {};
    if (r.type === 'assistant/message') {
      messages++;
      const m = d.message ?? {};
      for (const b of m.content ?? []) {
        if (!b || typeof b !== 'object') continue;
        blocks++;
        if (b.type === 'text') { const t = b.text ?? ''; chars += t.length; codeFences += (t.match(/```/g) || []).length >> 1; }
        else if (b.type === 'reasoning') { reasoningBlocks++; chars += (b.text ?? '').length; }
        else if (b.type === 'tool-call') { byCall.set(b.callId ?? d.callId, b); }
      }
    } else if (r.type === 'tool/result') {
      toolResults++;
      const m = d.message ?? {};
      for (const b of m.content ?? []) {
        if (b && typeof b === 'object') { blocks++; chars += (b.text ?? '').length; codeFences += ((b.text ?? '').match(/```/g) || []).length >> 1; }
      }
    } else if (r.type === 'tool/call') {
      toolCalls++;
    }
  }
  const t3 = now();
  const kb = (n) => (n / 1024).toFixed(0);
  console.log(
    `${f.split(/[\\/]/).pop().padEnd(34)} raw=${kb(text.length)}KB ` +
    `read=${(t1 - t0).toFixed(1)}ms parse=${(t2 - t1).toFixed(1)}ms proj=${(t3 - t2).toFixed(1)}ms | ` +
    `records=${parsed.length} msgs=${messages} blocks=${blocks} toolCalls=${toolCalls} toolResults=${toolResults} reasoning=${reasoningBlocks} ` +
    `chars=${(chars / 1024).toFixed(0)}KB codeFences=${codeFences}`
  );
}
