import { describe, expect, it } from 'vitest';
import example from '../examples/alert-chat-when-comment-held.json';

interface ExampleNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, Record<string, unknown>>;
}

const raw = JSON.stringify(example);
const workflow = example as unknown as {
  nodes: ExampleNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
};

describe('example workflow', () => {
  const trigger = workflow.nodes.find((n) => n.type === '@feedbouncer/n8n-nodes-feedbouncer.feedBouncerTrigger');
  const slack = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.slack');

  it('triggers on flagged items and posts to Slack', () => {
    expect(trigger?.parameters.events).toEqual(['item.flagged']);
    expect(slack?.parameters).toMatchObject({ resource: 'message', operation: 'post' });
    const targets = workflow.connections[trigger!.name].main.flat().map((c) => c.node);
    expect(targets).toEqual([slack!.name]);
  });

  it('quotes the comment text from the event', () => {
    expect(String(slack?.parameters.text)).toContain('{{ $json.data.flaggedItem.comment.text }}');
  });

  it('carries no credential ids, keys, secrets or webhook URLs', () => {
    for (const node of workflow.nodes) {
      for (const credential of Object.values(node.credentials ?? {})) expect(credential).not.toHaveProperty('id');
    }
    expect(raw).not.toMatch(/fbk_|whsec_|xox[abpr]-/);
    expect(raw).not.toMatch(/hooks\.slack\.com\/services\/[A-Z0-9]/);
  });
});
