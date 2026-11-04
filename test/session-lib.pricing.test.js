const assert = require('node:assert/strict');
const test = require('node:test');
const { priceUSD } = require('../session-lib');

// 1M of each token class, so the expected value is just the sum of per-MTok rates.
const M = 1_000_000;
const all = (model) => ({
  model, input_tokens: M, output_tokens: M, cache_read_tokens: M,
  cache_creation_5m_tokens: M, cache_creation_1h_tokens: M,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('2026-11 list prices: explicit cache rates for 5.x models', () => {
  close(priceUSD(all('claude-opus-5-5')), 4 + 20 + 0.2 + 5 + 8);
  close(priceUSD(all('claude-opus-5-20261001')), 5 + 25 + 0.5 + 6.25 + 10);
  close(priceUSD(all('claude-sonnet-5-5')), 2 + 10 + 0.1 + 2.5 + 4);
  close(priceUSD(all('claude-sonnet-5')), 2 + 10 + 0.2 + 2.5 + 4);
  close(priceUSD(all('claude-fable-5-1')), 10 + 50 + 0.25 + 12.5 + 20);
  close(priceUSD(all('claude-fable-5')), 10 + 50 + 1 + 12.5 + 20);
});

test('Opus 4.5-4.8 are $5/$25 but Opus 4 / 4.1 stay $15/$75 (prefix order)', () => {
  close(priceUSD(all('claude-opus-4-8')), 5 + 25 + 0.5 + 6.25 + 10);
  close(priceUSD(all('claude-opus-4-5-20251101')), 5 + 25 + 0.5 + 6.25 + 10);
  close(priceUSD(all('claude-opus-4-1-20250805')), 15 + 75 + 1.5 + 18.75 + 30);
  close(priceUSD(all('claude-opus-4-20250514')), 15 + 75 + 1.5 + 18.75 + 30);
});

test('Haiku 5.5 switches to the long-prompt tier above 100K prompt tokens', () => {
  const small = { model: 'claude-haiku-5-5', input_tokens: 50_000, output_tokens: 1_000 };
  close(priceUSD(small), (50_000 * 0.1 + 1_000 * 0.5) / M);
  const big = { model: 'claude-haiku-5-5', input_tokens: 10_000, cache_read_tokens: 95_000, output_tokens: 1_000 };
  close(priceUSD(big), (10_000 * 0.5 + 95_000 * 0.05 + 1_000 * 2.5) / M);
  close(priceUSD(all('claude-haiku-4-5-20251001')), 1 + 5 + 0.1 + 1.25 + 2);
});
