import { readdirSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge } from './badge';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';

describe('Button', () => {
  it('default is a pill with min height and keeps type', () => {
    const html = renderToStaticMarkup(<Button type="submit">Go</Button>);
    expect(html).toContain('bg-primary');
    expect(html).toContain('rounded-full');
    expect(html).toContain('min-h-10');
    expect(html).toContain('type="submit"');
  });

  it('never uses a transform class without motion-safe', () => {
    for (const variant of [
      'default',
      'secondary',
      'ghost',
      'outline',
      'destructive',
      'link',
    ] as const) {
      const html = renderToStaticMarkup(<Button variant={variant}>x</Button>);
      const classes = /class="([^"]*)"/.exec(html)![1]!.split(/\s+/);
      for (const c of classes) {
        if (/(^|:)(-?translate-|scale-)/.test(c)) expect(c).toMatch(/^motion-safe:/);
      }
      expect(html).not.toMatch(/(^|[\s"])transition-/);
    }
  });

  it('keeps its font size next to the text colour', () => {
    expect(renderToStaticMarkup(<Button>x</Button>)).toContain('text-ui');
    expect(renderToStaticMarkup(<Button size="sm">x</Button>)).toContain('text-small');
  });

  it('icon size is square 10', () => {
    expect(renderToStaticMarkup(<Button size="icon">x</Button>)).toContain('size-10');
  });
});

describe('Badge', () => {
  it('coral uses the strong text token', () => {
    const html = renderToStaticMarkup(<Badge variant="coral">x</Badge>);
    expect(html).toContain('text-coral-strong');
    expect(html).not.toContain('text-coral ');
  });
  it('keeps text-caption in every variant', () => {
    for (const v of ['default', 'good', 'coral', 'danger', 'destructive'] as const) {
      expect(renderToStaticMarkup(<Badge variant={v}>x</Badge>)).toContain('text-caption');
    }
  });
  it('good and danger', () => {
    expect(renderToStaticMarkup(<Badge variant="good">x</Badge>)).toContain('text-good');
    expect(renderToStaticMarkup(<Badge variant="danger">x</Badge>)).toContain('text-danger');
  });
});

describe('Card', () => {
  it('renders themed card parts', () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>T</CardTitle>
        </CardHeader>
        <CardContent>c</CardContent>
      </Card>,
    );
    expect(html).toContain('rounded-lg');
    expect(html).toContain('bg-card');
    expect(html).toContain('font-display');
    expect(html).toContain('text-card-title');
  });
});

describe('ui sources', () => {
  const dir = 'src/components/ui';
  for (const f of readdirSync(dir).filter((n) => /\.tsx$/.test(n) && !n.includes('.test.'))) {
    it(`${f} has no hex colours, px values or physical direction utilities`, () => {
      const src = readFileSync(`${dir}/${f}`, 'utf8');
      expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(src).not.toMatch(/\[\d+px\]/);
      expect(src).not.toMatch(/[\s"'`:](pl|pr|ml|mr|left|right)-|text-(left|right)/);
    });
  }
});
