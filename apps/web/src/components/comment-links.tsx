import { viewOnUrl } from '../lib/permalink';
import { PLATFORM_COPY, isConnectable } from '../lib/platforms';

const VIDEO_ID = /\/video\/(\d{1,32})$/;

function ExternalLink(props: { href: string; text: string }) {
  return (
    <>
      {' · '}
      <a href={props.href} rel="noopener noreferrer" target="_blank">
        {props.text}
      </a>
    </>
  );
}

// The post a comment is on, and a link to the comment (or, on TikTok, its video) on its platform.
export function CommentLinks(props: {
  platform: string;
  permalink: string | null;
  mediaExternalId: string;
  sourcePermalink?: string | null;
}) {
  const source = viewOnUrl(props.platform, props.sourcePermalink ?? null);
  if (props.platform === 'tiktok_ads') {
    const videoId = source ? VIDEO_ID.exec(new URL(source).pathname)?.[1] : undefined;
    return (
      <p>
        <span>{`Ad ${props.mediaExternalId}`}</span>
        {source ? (
          <ExternalLink
            href={source}
            text={videoId ? `Video ${videoId}` : PLATFORM_COPY.tiktok_ads.viewOn}
          />
        ) : null}
      </p>
    );
  }
  if (props.platform === 'tiktok')
    return (
      <p>
        <span>{`On video ${props.mediaExternalId}`}</span>
        {source ? <ExternalLink href={source} text={PLATFORM_COPY.tiktok.viewOn} /> : null}
      </p>
    );
  const copy = isConnectable(props.platform) ? PLATFORM_COPY[props.platform] : null;
  const href = copy ? viewOnUrl(props.platform, props.permalink) : null;
  return (
    <p>
      <span>{`On post ${props.mediaExternalId}`}</span>
      {href && copy ? <ExternalLink href={href} text={copy.viewOn} /> : null}
    </p>
  );
}
