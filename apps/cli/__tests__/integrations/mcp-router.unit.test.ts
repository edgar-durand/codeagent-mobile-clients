import { describe, it, expect } from 'vitest';
import {
  searchTools,
  splitQualifiedName,
  qualifiedName,
  routerToolDefinitions,
  type RoutedTool,
} from '../../src/integrations/mcp-router';

const T = (integration: string, name: string, description = ''): RoutedTool => ({
  integration,
  name,
  description,
  inputSchema: { type: 'object' },
});

const TOOLS: RoutedTool[] = [
  T('clickup', 'create_task', 'Create a task in a list'),
  T('clickup', 'get_workspace_tasks', 'List tasks across the workspace'),
  T('trello', 'get_my_cards', 'Cards assigned to me'),
  T('jira', 'create_issue', 'Create an issue in a project'),
  T('linear', 'search_issues', 'Search issues; can create saved views'),
];

describe('routerToolDefinitions — the whole point is how FEW there are', () => {
  it('exposes exactly four tools, each with a strict object schema', () => {
    const defs = routerToolDefinitions();
    expect(defs.map((d) => d.name)).toEqual(['list_integrations', 'search_tools', 'describe_tool', 'call_tool']);
    for (const d of defs) {
      expect((d.inputSchema as { type: string }).type).toBe('object');
      expect((d.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
  });

  it('is small: the four schemas together are a tiny fraction of one integration', () => {
    // 475 real tools measured ≈ 698 KB. The router's whole surface must stay
    // under 4 KB so the saving is not eaten by verbose descriptions.
    expect(JSON.stringify(routerToolDefinitions()).length).toBeLessThan(4_000);
  });
});

describe('qualifiedName / splitQualifiedName', () => {
  it('round-trips, and rejects malformed names instead of guessing', () => {
    expect(splitQualifiedName(qualifiedName('clickup', 'create_task'))).toEqual({ integration: 'clickup', tool: 'create_task' });
    expect(splitQualifiedName('clickup')).toBeNull();
    expect(splitQualifiedName('/create_task')).toBeNull();
    expect(splitQualifiedName('clickup/')).toBeNull();
    // A tool name may itself contain a slash; only the FIRST one separates.
    expect(splitQualifiedName('http/get/v1')).toEqual({ integration: 'http', tool: 'get/v1' });
  });
});

describe('searchTools', () => {
  it('ANDs keywords so "create task" narrows to tools about creating tasks', () => {
    const hits = searchTools(TOOLS, 'create task').map((t) => qualifiedName(t.integration, t.name));
    expect(hits).toEqual(['clickup/create_task']);
  });

  it('ranks a NAME hit above a description-only hit', () => {
    // "create" appears in linear/search_issues' description and in the NAME of
    // create_task and create_issue; the names must come first.
    const hits = searchTools(TOOLS, 'create').map((t) => t.name);
    expect(hits.slice(0, 2).sort()).toEqual(['create_issue', 'create_task']);
    expect(hits[2]).toBe('search_issues');
  });

  it('scopes to one integration when asked', () => {
    expect(searchTools(TOOLS, 'task', 'trello')).toEqual([]);
    expect(searchTools(TOOLS, 'task', 'clickup').map((t) => t.name).sort()).toEqual(['create_task', 'get_workspace_tasks']);
  });

  it('is case-insensitive and treats an empty query as "everything in scope"', () => {
    expect(searchTools(TOOLS, 'CARDS').map((t) => t.name)).toEqual(['get_my_cards']);
    expect(searchTools(TOOLS, '', 'clickup')).toHaveLength(2);
    expect(searchTools(TOOLS, '   ')).toHaveLength(TOOLS.length);
  });
});
