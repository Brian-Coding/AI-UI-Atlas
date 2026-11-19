import { expect, test } from 'bun:test';
import { redactData, redactSecrets } from './redact';

test.each([
  "curl -H 'x-atlas-qa-token: synthetic-value' -H 'Authorization: Bearer synthetic-value'", // gitleaks:allow (synthetic test values)
  'H="-H X-Atlas-QA-Token:synthetic-value -H content-type:application/json"',
  '{"Authorization":"Basic synthetic-value", "X-Atlas-QA-Token":"synthetic-value"}',
  '{\\"Authorization\\":\\"Bearer synthetic-value\\"}',
  "{'Proxy-Authorization': 'Digest synthetic-value'}",
  'authorization=synthetic-value',
])('redacts header syntax: %s', input => {
  const output = redactSecrets(input);
  expect(output).not.toContain('synthetic-value');
  expect(output).toContain('<redacted-token>');
  expect(redactSecrets(output)).toBe(output);
});

test('redaction preserves JSON, safe headers and exact tokens outside headers', () => {
  const data = { headers: { AUTHORIZATION: 'Bearer synthetic-value', 'content-type': 'application/json' },
    nested: [{ text: 'assigned synthetic-run-token' }], count: 1, ok: true };
  const clean = redactData(data, ['synthetic-run-token']);
  expect(clean.headers.AUTHORIZATION).toBe('<redacted-token>');
  expect(clean.headers['content-type']).toBe('application/json');
  expect(clean.nested[0]?.text).toBe('assigned <redacted-token>');
  expect(JSON.parse(redactSecrets(JSON.stringify(data), ['synthetic-run-token']))).toEqual(clean);
  expect(data.headers.AUTHORIZATION).toBe('Bearer synthetic-value');
});
