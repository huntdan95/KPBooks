import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  result: string;
}

interface ChatResponse {
  reply: string;
  toolCalls: ChatToolCall[];
  stopReason: string | null;
  iterationLimitReached: boolean;
}

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ChatToolCall[];
}

const SUGGESTIONS = [
  "What's my net income this month?",
  'Who owes me the most money right now?',
  'Show me bills due this week',
  'What did I spend on office expenses last quarter?',
  'Which customers are 60+ days overdue?',
  'List my 1099 vendors',
];

export function Chat() {
  const { companyId } = useCurrentCompany();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(1);

  const aiStatus = useQuery({
    queryKey: ['chat-ai-status'],
    queryFn: () => api<{ available: boolean }>('/chat/status'),
    staleTime: 60_000,
  });

  const askMutation = useMutation({
    mutationFn: async (text: string) => {
      // Conversation context = previous turns + the new user message.
      const messages: ChatMessage[] = [
        ...turns.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user' as const, content: text },
      ];
      return api<ChatResponse>('/chat', {
        method: 'POST',
        companyId,
        body: { messages },
      });
    },
    onSuccess: (data) => {
      setTurns((prev) => [
        ...prev,
        {
          id: nextIdRef.current++,
          role: 'assistant',
          content: data.reply,
          toolCalls: data.toolCalls,
        },
      ]);
    },
  });

  function send(text: string) {
    const t = text.trim();
    if (!t || askMutation.isPending) return;
    setInput('');
    setTurns((prev) => [
      ...prev,
      { id: nextIdRef.current++, role: 'user', content: t },
    ]);
    askMutation.mutate(t);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns, askMutation.isPending]);

  function reset() {
    setTurns([]);
    setInput('');
    askMutation.reset();
  }

  if (aiStatus.data && !aiStatus.data.available) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
          Chat with your books
        </h2>
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ANTHROPIC_API_KEY is not configured on the API. Set the secret value and redeploy to
          enable AI chat.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            Chat with your books
          </h2>
          <p className="text-sm text-slate-500">
            Ask questions in plain English. Claude looks up real data via tools and answers
            from your books — read-only, scoped to this client.
          </p>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100"
          >
            New conversation
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-4"
      >
        {turns.length === 0 && !askMutation.isPending && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          {turns.map((t) => (
            <Bubble key={t.id} turn={t} />
          ))}
          {askMutation.isPending && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">
                <span className="inline-flex items-center gap-1">
                  Thinking
                  <span className="animate-pulse">…</span>
                </span>
              </div>
            </div>
          )}
          {askMutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(askMutation.error)}
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            askMutation.isPending
              ? 'Waiting for Claude…'
              : 'Ask about revenue, expenses, customers, bills, anything in your books'
          }
          disabled={askMutation.isPending}
          className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
        />
        <button
          type="submit"
          disabled={!input.trim() || askMutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  const isUser = turn.role === 'user';
  return (
    <div className={isUser ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          'max-w-2xl rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ' +
          (isUser ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-900')
        }
      >
        {turn.content}
        {turn.toolCalls && turn.toolCalls.length > 0 && (
          <details className="mt-2 text-xs opacity-80">
            <summary className="cursor-pointer">
              Looked up {turn.toolCalls.length} thing{turn.toolCalls.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-1 space-y-1">
              {turn.toolCalls.map((c, i) => (
                <li key={i}>
                  <span className="font-mono">{c.name}</span>(
                  <span className="font-mono">{summariseInput(c.input)}</span>)
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

function summariseInput(input: Record<string, unknown>): string {
  const parts = Object.entries(input).map(
    ([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : String(v)}`,
  );
  const s = parts.join(', ');
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Request failed.';
}
