import { viewOnUrl } from '../lib/permalink';
import { PLATFORM_COPY, isConnectable } from '../lib/platforms';

// The post a comment is on, and a link to the comment on its platform.
export function CommentLinks(props: {
  platform: string;
  permalink: string | null;
  mediaExternalId: string;
}) {
  const href = isConnectable(props.platform) ? viewOnUrl(props.platform, props.permalink) : null;
  const post = `On post ${props.mediaExternalId}`;
  return (
    <p>
      {href ? (
        <a href={href} rel="noopener noreferrer" target="_blank">
          {post}
        </a>
      ) : (
        <span>{post}</span>
      )}
      {href && isConnectable(props.platform) ? (
        <>
          {' · '}
          <a href={href} rel="noopener noreferrer" target="_blank">
            {PLATFORM_COPY[props.platform].viewOn}
          </a>
        </>
      ) : null}
    </p>
  );
}
