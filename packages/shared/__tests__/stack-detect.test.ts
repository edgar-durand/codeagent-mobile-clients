import { describe, it, expect } from 'vitest';
import {
  classifyStack,
  detectedIntegrationsFromDeps,
  recommendForDeps,
  DEP_TO_INTEGRATION,
  STACK_TO_RECOMMENDED,
} from '../src/integrations/stack-detect';
import { isKnownIntegrationId } from '../src/integrations/registry';

describe('stack-detect', () => {
  it('classifies a React app as frontend', () => {
    expect(classifyStack(['react', 'react-dom', 'vite'])).toBe('frontend');
  });

  it('classifies a NestJS app as backend', () => {
    expect(classifyStack(['@nestjs/core', 'express'])).toBe('backend');
  });

  it('classifies a Next.js API + React app as fullstack', () => {
    expect(classifyStack(['next', 'react', 'fastify'])).toBe('fullstack');
  });

  it('classifies Expo/React Native as mobile (mobile wins over frontend)', () => {
    expect(classifyStack(['expo', 'react', 'react-native'])).toBe('mobile');
  });

  it('classifies an unrecognized stack as unknown', () => {
    expect(classifyStack(['left-pad', 'lodash'])).toBe('unknown');
  });

  it('detects integrations by exact dep name', () => {
    expect(detectedIntegrationsFromDeps(['convex', 'posthog-js'])).toEqual(['convex', 'posthog']);
  });

  it('detects integrations by scoped-package prefix', () => {
    expect(detectedIntegrationsFromDeps(['@sentry/nextjs', '@supabase/ssr'])).toEqual([
      'sentry',
      'supabase',
    ]);
  });

  it('dedupes multiple deps that map to the same integration', () => {
    expect(detectedIntegrationsFromDeps(['@sentry/node', '@sentry/react', 'dd-trace'])).toEqual([
      'sentry',
      'datadog',
    ]);
  });

  it('recommendForDeps: backend repo detects convex + recommends the rest of the backend set', () => {
    const r = recommendForDeps(['@nestjs/core', 'convex']);
    expect(r.stack).toBe('backend');
    expect(r.detected).toEqual(['convex']);
    expect(r.source).toBe('scan');
    // recommended excludes the already-detected convex
    expect(r.recommended).not.toContain('convex');
    expect(r.recommended).toContain('sentry');
    expect(r.recommended).toContain('datadog');
  });

  it('recommendForDeps: frontend repo recommends design/analytics/deploy tools', () => {
    const r = recommendForDeps(['react', 'next']);
    expect(['frontend', 'fullstack']).toContain(r.stack);
    expect(r.recommended).toContain('figma');
    expect(r.recommended).toContain('sentry');
  });

  it('recommendForDeps: unknown stack with no known deps yields empty (triggers agent fallback)', () => {
    const r = recommendForDeps(['left-pad']);
    expect(r.detected).toEqual([]);
    expect(r.recommended).toEqual([]);
  });

  it('every mapped integration id (and every recommendation) is a real registry id', () => {
    for (const id of Object.values(DEP_TO_INTEGRATION)) expect(isKnownIntegrationId(id)).toBe(true);
    for (const list of Object.values(STACK_TO_RECOMMENDED)) {
      for (const id of list) expect(isKnownIntegrationId(id)).toBe(true);
    }
  });
});
