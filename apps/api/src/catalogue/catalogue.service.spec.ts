import { keySet } from './catalogue.service';

describe('keySet: whether the key a model needs is set for LiteLLM', () => {
  const keys = { anthropic: true, gemini: false };

  it("reads the flag of the model's provider", () => {
    expect(keySet('claude-haiku-5-5', 'anthropic', keys)).toBe(true);
    expect(keySet('gemini-3.8-flash', 'gemini', keys)).toBe(false);
    expect(keySet('gemini-3.8-flash', 'vertex_ai', keys)).toBe(false);
  });

  it('does not guess: null for a fake model, a provider it is told nothing about, or no flag at all', () => {
    expect(keySet('fake/finance-emi', 'openai', keys)).toBeNull();
    expect(keySet('gpt-5-mini', 'openai', keys)).toBeNull();
    expect(keySet('claude-haiku-5-5', null, keys)).toBeNull();
    expect(keySet('claude-haiku-5-5', 'anthropic', { anthropic: null, gemini: null })).toBeNull();
  });
});
