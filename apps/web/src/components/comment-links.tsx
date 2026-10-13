import { viewOnUrl } from '../lib/permalink';
import { PLATFORM_COPY, isConnectable } from '../lib/platforms';

// The post a comment is on, and a link to the comment on its platform.
export function CommentLinks(props: {
  platform: string;
  permalink: string | null;
  mediaExternalId: string;
}) {
  const copy = isConnectable(props.platform) ? PLATFORM_COPY[props.platform] : null;
  const href = copy ? viewOnUrl(props.platform, props.permalink) : null;
  return (
    <p>
      <span>{`On post ${props.mediaExternalId}`}</span>
      {href && copy ? (
        <>
          {' · '}
          <a href={href} rel="noopener noreferrer" target="_blank">
            {copy.viewOn}
          </a>
        </>
      ) : null}
    </p>
  );
}
