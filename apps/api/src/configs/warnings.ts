import type { ConfigWarning } from '../contract';

/**
 * Valid but risky configs (Rishi's guide review, platform item 1): the API takes them, and says
 * what will happen and how to avoid it, so a run is not spent on a request that is not what the
 * config says.
 */

/**
 * LangGraph's model-name rules: langchain-openai 1.7.2 (the LangGraph worker's pin) changes the
 * request by the model's name, with no switch (workers/langgraph/README.md, finding 6;
 * `langchain_openai/chat_models/base.py`). Each rule is a test on the name LangGraph is given,
 * which is the config's model (the LiteLLM name), and what it does.
 */
const LANGGRAPH_NAME_RULES: { test: (name: string) => boolean; change: string }[] = [
  {
    // base.py:1369: lower-cased, starts with gpt-5, no "chat" in it.
    test: (n) => n.toLowerCase().startsWith('gpt-5') && !n.toLowerCase().includes('chat'),
    change: 'a gpt-5 name drops any temperature other than 1',
  },
  {
    // base.py:1362: lower-cased, starts with o1, and no temperature given.
    test: (n) => n.toLowerCase().startsWith('o1'),
    change: 'an o1 name sends temperature 1 when the config leaves temperature unset',
  },
  {
    // base.py:3848: re.match(r"^o\d"), case as given.
    test: (n) => /^o\d/.test(n),
    change: 'an o<digit> name sends the system prompt with the role developer instead of system',
  },
  {
    // base.py:2024 and :775. The adapter passes use_responses_api=False, which overrides both at
    // this pin, so the request is unchanged today; the rule is listed so a name that depends on
    // that one override is still flagged.
    test: (n) => n.toLowerCase().startsWith('gpt-6') || n.includes('codex'),
    change:
      'a gpt-6 or codex name moves the call to the Responses API by name; the adapter forces Chat Completions ' +
      '(use_responses_api=False), so check the captured request before trusting the trial',
  },
];

/** Every warning for this harness and model; empty when there is none. */
export function configWarnings(harness: string, model: string): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  if (harness === 'langgraph') {
    const changes = LANGGRAPH_NAME_RULES.filter((r) => r.test(model)).map((r) => r.change);
    if (changes.length) {
      warnings.push({
        code: 'langgraph_model_name_rewrite',
        message: `LangGraph changes the request for this model name (${model}): ${changes.join('; ')}.`,
        fix: 'Serve the model under a LiteLLM name that does not start with gpt-5, gpt-6, o1 or o<digit> and does not contain codex, or run it on another harness.',
      });
    }
  }
  return warnings;
}
