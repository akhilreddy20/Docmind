import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { config } from '../config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamResult {
  promptTokens: number;
  completionTokens: number;
}

/** Rough token estimate (~4 chars/token for English) used for budgeting before a call. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Thin wrapper around OpenAI. With MOCK_LLM=true it switches to a deterministic
 * offline implementation (hashed bag-of-words embeddings + extractive answers)
 * so the whole system can be developed and tested without an API key.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client = config.llm.mock ? null : new OpenAI({ apiKey: config.llm.openaiApiKey });

  constructor() {
    if (config.llm.mock) this.logger.warn('MOCK_LLM=true: using offline mock embeddings and answers');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.client) return texts.map((t) => mockEmbedding(t, config.llm.embeddingDim));
    const res = await this.client.embeddings.create({
      model: config.llm.embeddingModel,
      input: texts.map((t) => t.replace(/\s+/g, ' ').slice(0, 30000)),
      dimensions: config.llm.embeddingDim,
    });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async embedOne(text: string): Promise<number[]> {
    return (await this.embed([text]))[0];
  }

  /** Streams completion tokens to onToken. Returns actual usage for rate-limit reconciliation. */
  async streamChat(
    messages: ChatMessage[],
    onToken: (t: string) => void,
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    if (!this.client) return mockStream(messages, onToken, signal);

    const stream = await this.client.chat.completions.create(
      {
        model: config.llm.chatModel,
        messages,
        stream: true,
        temperature: config.llm.temperature,
        max_tokens: config.llm.maxAnswerTokens,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    let completion = '';
    let usage: StreamResult | null = null;
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content;
      if (delta) {
        completion += delta;
        onToken(delta);
      }
      if (part.usage) {
        usage = { promptTokens: part.usage.prompt_tokens, completionTokens: part.usage.completion_tokens };
      }
    }
    return (
      usage ?? {
        promptTokens: estimateTokens(messages.map((m) => m.content).join('\n')),
        completionTokens: estimateTokens(completion),
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Offline mock implementation
// ---------------------------------------------------------------------------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STOP = new Set('a an the of to in on for and or is are was were be by with what which who how does do it this that as at from'.split(' '));

export function mockEmbedding(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w));
  for (const w of words) {
    const h = fnv1a(w);
    v[h % dim] += h & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function mockStream(
  messages: ChatMessage[],
  onToken: (t: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const user = messages[messages.length - 1]?.content ?? '';
  const firstSource = /\[1\][^\n]*\n([\s\S]*?)(?:\n\[2\]|\n\nQuestion:|$)/.exec(user)?.[1]?.trim();
  const answer = firstSource
    ? `(mock answer) According to the documents: ${firstSource.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')} [1]`
    : "(mock answer) I couldn't find anything relevant in your documents.";
  const parts = answer.split(/(\s+)/);
  for (const p of parts) {
    if (signal?.aborted) break;
    onToken(p);
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    promptTokens: estimateTokens(messages.map((m) => m.content).join('\n')),
    completionTokens: estimateTokens(answer),
  };
}
