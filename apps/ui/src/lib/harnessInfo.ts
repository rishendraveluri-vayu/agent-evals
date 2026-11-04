/**
 * Each harness in plain words, for the guided builder's "i" notes. Every line comes from
 * docs/harness-guide.md (v3, 4 Nov): the section is named beside each harness. What a harness
 * supports (memory, skills, compression, extra calls at the step limit) is read from its
 * capabilities at run time instead, so it can never drift from what the API says.
 */
import type { CapabilitySetting, Harness } from '../api/types';

export interface HarnessFacts {
  /** One line on the card. */
  tagline: string;
  /** What it is, in one line. */
  what: string;
  /** How it runs the tool loop. */
  loop: string;
  /** What it adds to our prompt. */
  prompt: string;
  /** When you would pick it in this experiment. */
  pick: string;
}

const FACTS: Record<string, HarnessFacts> = {
  // harness-guide.md sections 1, 3.1, 3.3, 3.4, 3.6 and 3.12.
  hermes: {
    tagline: 'A full agent product. Wraps your prompt in its own.',
    what: "Nous Research's general-purpose agent, unmodified, at a pinned version.",
    loop: 'A model call per step, tools in between. At the step limit, up to 2 more calls and a summary answer.',
    prompt: 'About 4,500 characters of its own around yours; tool results wrapped as untrusted data.',
    pick: 'To test a prompt or memory inside a full agent product, where its text can interact with yours.',
  },
  // Sections 4.1, 4.2 and 4.8.
  ownloop: {
    tagline: 'Our plain loop. Adds nothing: the vanilla baseline.',
    what: 'Our own plain loop on the OpenAI client.',
    loop: 'Model, then each tool call in order, until a reply has no tool calls. No retries.',
    prompt: 'Nothing: your prompt is the whole system prompt.',
    pick: 'As the baseline: a change here is that change alone.',
  },
  // Sections 5.1, 5.3 and 5.9.
  langgraph: {
    tagline: "LangChain's agent graph. Adds nothing to your prompt.",
    what: "LangChain's create_agent graph: a model node, a tools node, middleware.",
    loop: 'Model, then tools at the same time. A reply with only broken calls ends the run.',
    prompt: 'Nothing: your prompt is the system message, byte for byte.',
    pick: 'A widely used framework, and the closest to the own loop.',
  },
  // Sections 6.1, 6.3, 6.7 and 6.9.
  adk: {
    tagline: "Google's agent kit. Adds an identity line and fences tool text.",
    what: "Google's Agent Development Kit, through the LiteLLM library.",
    loop: 'Model, then tools at the same time. A broken call gets a retry hint; the 4th in a row ends the turn.',
    prompt: 'An identity line and a preamble after yours; every tool description fenced.',
    pick: 'To see whether extra framing around the same prompt changes results.',
  },
  // Sections 7.1, 7.3, 7.4 and 7.9.
  'openai-agents': {
    tagline: "OpenAI's agent framework. Adds nothing to your prompt.",
    what: "OpenAI's Agents SDK, on Chat Completions.",
    loop: 'Model, then tools at the same time, until an answer or the turn limit.',
    prompt: 'Nothing. A failed tool call comes back as one fixed "please try again".',
    pick: 'Close to the own loop, but the model is never told why a tool call failed.',
  },
};

/** The facts for a harness the guide covers, or null for one it does not (a newly added one). */
export function harnessFacts(name: string): HarnessFacts | null {
  return FACTS[name] ?? null;
}

const FEATURES = ['memory', 'skills', 'compression'] as const;

function list(words: string[]): string {
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "Memory, skills and compression, off unless turned on." or "None.", read from the harness's
 *  capabilities. */
export function memoryLine(settings: Record<string, CapabilitySetting | undefined>): string {
  const yes = FEATURES.filter((f) => settings[f]?.supported);
  const no = FEATURES.filter((f) => !settings[f]?.supported);
  if (!yes.length) return 'None.';
  const has = list([...yes]);
  const head = has[0].toUpperCase() + has.slice(1);
  return `${head}, off unless turned on${no.length ? `; no ${list([...no])}` : ''}.`;
}

/** The card's one line: the guide's tagline, or what the capabilities say for an unknown harness. */
export function harnessTagline(h: Pick<Harness, 'name' | 'capabilities'>): string {
  return harnessFacts(h.name)?.tagline ?? h.capabilities.known_differences[0] ?? 'No summary yet: see the Harnesses page.';
}
