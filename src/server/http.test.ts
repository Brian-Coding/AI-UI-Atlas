import { describe, expect, test } from 'bun:test';
import { isRequestAllowed, tokenFromRequest, tokensMatch } from './http';

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe('network guard', () => {
  test('allows loopback requests without an Origin (curl, agents)', () => {
    expect(isRequestAllowed(req('http://127.0.0.1:4477/api/project'), 4477)).toBe(true);
    expect(isRequestAllowed(req('http://localhost:4477/api/project'), 4477)).toBe(true);
    expect(isRequestAllowed(req('http://[::1]:4477/api/project'), 4477)).toBe(true);
  });

  test('blocks DNS rebinding through a non-loopback Host', () => {
    expect(isRequestAllowed(req('http://attacker.example:4477/api/project'), 4477)).toBe(false);
    expect(isRequestAllowed(req('http://127.0.0.1:4477/', { host: 'attacker.example:4477' }), 4477)).toBe(false);
  });

  test('only accepts this exact server origin from browsers', () => {
    expect(isRequestAllowed(req('http://127.0.0.1:4477/', { origin: 'http://127.0.0.1:4477' }), 4477)).toBe(true);
    expect(isRequestAllowed(req('http://127.0.0.1:4477/', { origin: 'http://localhost:4477' }), 4477)).toBe(true);
    // The app under test usually runs on another loopback port: refused.
    expect(isRequestAllowed(req('http://127.0.0.1:4477/', { origin: 'http://localhost:3000' }), 4477)).toBe(false);
    expect(isRequestAllowed(req('http://127.0.0.1:4477/', { origin: 'https://evil.example' }), 4477)).toBe(false);
    expect(isRequestAllowed(req('http://127.0.0.1:4477/', { origin: 'null' }), 4477)).toBe(false);
    expect(isRequestAllowed(req('http://127.0.0.1:4477/', { origin: 'not a url' }), 4477)).toBe(false);
  });
});

describe('API token', () => {
  test('reads x-atlas-qa-token or a bearer token', () => {
    expect(tokenFromRequest(req('http://127.0.0.1/', { 'x-atlas-qa-token': ' abc ' }))).toBe('abc');
    expect(tokenFromRequest(req('http://127.0.0.1/', { authorization: 'Bearer xyz' }))).toBe('xyz');
    expect(tokenFromRequest(req('http://127.0.0.1/'))).toBeNull();
  });

  test('compares tokens exactly', () => {
    expect(tokensMatch('secret', 'secret')).toBe(true);
    expect(tokensMatch('secret', 'secreT')).toBe(false);
    expect(tokensMatch('secret', 'secret-longer')).toBe(false);
    expect(tokensMatch('secret', null)).toBe(false);
  });
});
