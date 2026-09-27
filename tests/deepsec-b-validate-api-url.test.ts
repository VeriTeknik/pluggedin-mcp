import { describe, it, expect } from 'vitest';
import { validateApiUrl } from '../src/security-utils.js';

// The API base URL receives the user's Bearer key on every request, so it must
// be https, or plain http only when it cannot leave the machine (loopback).
describe('validateApiUrl', () => {
  it.each([
    'https://plugged.in',
    'https://plugged.in/',
    'https://self-hosted.example.com',
    'https://self-hosted.example.com:8443/pluggedin',
    'http://localhost:12005',
    'http://LOCALHOST:12005',
    'http://localhost',
    'http://127.0.0.1:12005',
    'http://[::1]:12005',
  ])('accepts %s', (url) => {
    expect(validateApiUrl(url)).toBe(true);
  });

  it.each([
    'http://plugged.in',
    'http://attacker.example',
    'http://192.168.1.10:12005',
    'http://localhost.attacker.example',
    'http://127.0.0.1.attacker.example',
  ])('rejects plain http to a non-loopback host: %s', (url) => {
    expect(validateApiUrl(url)).toBe(false);
  });

  it.each([
    'https://user:pass@plugged.in',
    'https://user@plugged.in',
    'https://:pass@plugged.in',
    'http://user:pass@localhost:12005',
  ])('rejects URLs with embedded credentials: %s', (url) => {
    expect(validateApiUrl(url)).toBe(false);
  });

  it.each([
    'ftp://plugged.in',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '',
  ])('rejects non-http(s) or malformed input: %s', (url) => {
    expect(validateApiUrl(url)).toBe(false);
  });
});
