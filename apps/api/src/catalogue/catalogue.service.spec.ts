import { keySet, missingKeyVar } from './catalogue.service';

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

describe('missingKeyVar: the .env variable to add, only when the key is known not to be set', () => {
  it('names the variable for an unset key, and nothing otherwise', () => {
    const keys = { anthropic: true, gemini: false };
    expect(missingKeyVar('gemini-3.8-flash', 'gemini', keys)).toBe('GEMINI_API_KEY');
    expect(missingKeyVar('gemini-3.8-flash', 'vertex_ai', keys)).toBe('GEMINI_API_KEY');
    expect(missingKeyVar('claude-haiku-5-5', 'anthropic', { anthropic: false, gemini: true })).toBe('ANTHROPIC_API_KEY');
    expect(missingKeyVar('claude-haiku-5-5', 'anthropic', keys)).toBeNull();
    expect(missingKeyVar('fake/judge', 'openai', keys)).toBeNull();
    expect(missingKeyVar('gemini-3.8-flash', 'gemini', { anthropic: null, gemini: null })).toBeNull();
  });
});
