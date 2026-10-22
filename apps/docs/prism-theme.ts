import { themes, type PrismTheme } from 'prism-react-renderer';

/** GitHub-like light palette; every token keeps at least 4.5:1 contrast on the #f6f8fa code background. */
export const lightCodeTheme: PrismTheme = {
  plain: { color: '#24292f', backgroundColor: '#f6f8fa' },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#57606a', fontStyle: 'italic' },
    },
    { types: ['string', 'attr-value', 'char', 'inserted'], style: { color: '#0a3069' } },
    {
      types: ['property', 'number', 'boolean', 'constant', 'symbol', 'attr-name', 'tag'],
      style: { color: '#0550ae' },
    },
    { types: ['keyword', 'selector', 'deleted', 'important'], style: { color: '#b3261e' } },
    { types: ['function', 'class-name', 'method'], style: { color: '#6639ba' } },
    { types: ['punctuation', 'operator'], style: { color: '#24292f' } },
    { types: ['variable', 'builtin', 'regex'], style: { color: '#953800' } },
  ],
};

export const darkCodeTheme: PrismTheme = themes.dracula;
