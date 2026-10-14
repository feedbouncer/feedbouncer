import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmDelete,
  progress,
  progressText,
  replyCheck,
  type Availability,
  type Progress,
} from '../lib/moderation';
import { CommentActions } from './comment-actions';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const ok = { available: true } as const;
const no = (reason: string) => ({ available: false, reason }) as const;

const IG_AVAILABILITY: Availability = {
  hide: ok,
  unhide: no('already_visible'),
  delete: ok,
  ban_author: no('unsupported'),
  unban_author: no('unsupported'),
  public_reply: ok,
  private_reply: no('private_reply_nested_comment'),
};

function render(over: Partial<Parameters<typeof CommentActions>[0]> = {}): string {
  return renderToStaticMarkup(
    <CommentActions
      orgId="o"
      brandId="b"
      commentId="c"
      platform="instagram"
      state="visible"
      availability={IG_AVAILABILITY}
      replyLimits={{ public_reply: 2200, private_reply: 1000 }}
      {...over}
    />,
  );
}

/** The opening tag of the element carrying `marker`, e.g. a button by its label. */
function tagBefore(html: string, marker: string, tag: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf(`<${tag}`, at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

/** The text of the element whose id the given tag's aria-describedby names. */
function describedText(html: string, tag: string): string {
  const id = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
  expect(id).toBeDefined();
  const open = html.indexOf(`id="${id}"`);
  expect(open).toBeGreaterThan(-1);
  const from = html.indexOf('>', open) + 1;
  return html.slice(from, html.indexOf('<', from));
}

const pending: Progress = { phase: 'pending', actionId: 'a1' };

describe('CommentActions', () => {
  it('instagram: no ban button; private reply disabled on a nested reply with the explanation', () => {
    const html = render();
    expect(html).not.toContain('Ban author');
    expect(html).not.toContain('Unban author');
    const button = tagBefore(html, 'Reply privately</button>', 'button');
    expect(button).toContain('disabled=""');
    expect(describedText(html, button)).toBe(
      'Instagram only allows private replies to top-level comments.',
    );
    // The textarea is disabled too, so nothing can be typed into an unavailable reply.
    expect(tagBefore(html, 'aria-label="Private reply"', 'textarea')).toContain('disabled=""');
    // Available actions stay enabled.
    expect(tagBefore(html, '>Hide</button>', 'button')).not.toContain('disabled');
  });

  it('instagram: reply on hidden comment disabled with "Unhide it first"', () => {
    const html = render({
      state: 'hidden',
      availability: {
        ...IG_AVAILABILITY,
        hide: no('already_hidden'),
        unhide: ok,
        public_reply: no('reply_to_hidden_comment'),
      },
    });
    expect(html).toContain('>Unhide</button>');
    const button = tagBefore(html, 'Reply publicly</button>', 'button');
    expect(button).toContain('disabled=""');
    expect(describedText(html, button)).toContain('Unhide it first');
  });

  it('delete asks for confirmation naming Instagram and does nothing when cancelled', () => {
    const asked: string[] = [];
    const confirmed = confirmDelete('instagram', (m) => {
      asked.push(m);
      return false;
    });
    expect(confirmed).toBe(false);
    expect(asked).toEqual(["Delete this comment on Instagram? This can't be undone."]);
    expect(confirmDelete('instagram', () => true)).toBe(true);
    expect(confirmDelete('facebook', (m) => m.includes('Facebook'))).toBe(true);
    expect(render()).toContain('>Delete</button>');
  });

  it('shows Pending… after submit and never shows success until the API reports applied', () => {
    let p = progress({ phase: 'idle' }, { type: 'submit' });
    expect(progressText(p, 'instagram')?.text).toBe('Pending…');
    p = progress(p, {
      type: 'accepted',
      action: { id: 'a1', status: 'pending', outcomeCode: null },
    });
    expect(p).toEqual(pending);
    expect(progressText(p, 'instagram')?.text).toBe('Pending…');
    // A poll that still says pending, or only mentions other actions, changes nothing.
    p = progress(p, {
      type: 'polled',
      actions: [{ id: 'a1', status: 'pending', outcomeCode: null }],
    });
    p = progress(p, {
      type: 'polled',
      actions: [{ id: 'x', status: 'applied', outcomeCode: null }],
    });
    expect(progressText(p, 'instagram')?.text).toBe('Pending…');
    // Giving up polling still never claims success.
    const unconfirmed = progress(p, { type: 'gave_up' });
    expect(progressText(unconfirmed, 'instagram')?.text).not.toMatch(/done/i);
    p = progress(p, {
      type: 'polled',
      actions: [{ id: 'a1', status: 'applied', outcomeCode: null }],
    });
    expect(progressText(p, 'instagram')).toEqual({ text: 'Done', alert: false });
  });

  it('shows "Failed, try again" with the outcome text on failure', () => {
    const p = progress(pending, {
      type: 'polled',
      actions: [{ id: 'a1', status: 'failed', outcomeCode: 'instagram_account_restricted' }],
    });
    expect(progressText(p, 'instagram')).toEqual({
      text: 'Failed, try again. Instagram has restricted this account. Open the Instagram app to resolve it.',
      alert: true,
    });
    const rejected = progress(pending, { type: 'rejected', message: 'Reply is too long.' });
    expect(progressText(rejected, 'instagram')).toEqual({
      text: 'Reply is too long.',
      alert: true,
    });
  });

  it('reply counter counts emoji as one and blocks submit over the limit', () => {
    expect(replyCheck('👍', 1)).toMatchObject({ count: 1, over: false, canSubmit: true });
    expect(replyCheck('👍👍', 1)).toMatchObject({ count: 2, over: true, canSubmit: false });
    expect(replyCheck('a'.repeat(2200), 2200).canSubmit).toBe(true);
    expect(replyCheck('a'.repeat(2201), 2200).canSubmit).toBe(false);
    expect(replyCheck('   ', 10).canSubmit).toBe(false);
    // The counter starts at zero against the platform's limit, and the textarea
    // has no UTF-16 maxLength that would disagree with the code-point count.
    const html = render({ availability: { ...IG_AVAILABILITY, private_reply: ok } });
    expect(html).toContain('0 / 2200');
    expect(html).toContain('0 / 1000');
    expect(html).not.toContain('maxLength');
    expect(html).not.toContain('maxlength');
  });

  it('renders disabled actions with their reason and hides unsupported ones', () => {
    const html = render({
      platform: 'facebook',
      availability: {
        ...IG_AVAILABILITY,
        ban_author: no('author_is_page'),
        unban_author: ok,
        private_reply: no('private_reply_window_closed'),
      },
    });
    const ban = tagBefore(html, '>Ban author</button>', 'button');
    expect(ban).toContain('disabled=""');
    expect(describedText(html, ban)).toBe('The author is your own Page.');
    expect(tagBefore(html, '>Unban author</button>', 'button')).not.toContain('disabled');
  });
});
