import type { ReactNode } from 'react';
import CodeBlock from '@theme/CodeBlock';
import type { WorkedExampleData } from '../examples/schema';
import ExampleComment from './ExampleComment';

export default function WorkedExample({ data }: { data: WorkedExampleData }): ReactNode {
  const { expected } = data;
  return (
    <section aria-label={data.title}>
      <h4>Rule</h4>
      {data.rules.map((rule) => (
        <CodeBlock key={rule.name} language="json">
          {JSON.stringify(rule, null, 2)}
        </CodeBlock>
      ))}
      <h4>Sample input</h4>
      <ExampleComment text={data.comment.text} mild={data.comment.mild} />
      <h4>Decision</h4>
      <ul>
        <li>Outcome: {expected.outcome}</li>
        <li>Deciding rule: {expected.decidedRule ?? 'none'}</li>
        <li>Steps: {expected.steps.join(', ') || 'none'}</li>
        {expected.suggestions.length > 0 && <li>Suggestions: {expected.suggestions.join(', ')}</li>}
        {expected.alsoMatched.length > 0 && (
          <li>Also matched: {expected.alsoMatched.join(', ')}</li>
        )}
      </ul>
      {data.note && <p>{data.note}</p>}
    </section>
  );
}
