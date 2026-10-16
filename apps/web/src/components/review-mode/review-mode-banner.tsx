'use client';
import { useState } from 'react';
import { bannerText, type ReviewModeStatusDto } from '../../lib/review-mode';
import { TextWithTimes } from '../local-time';
import { EndReviewModeDialog } from './end-review-mode-dialog';

export function ReviewModeBanner(props: {
  status: ReviewModeStatusDto;
  orgId: string;
  brandId: string;
  canManage: boolean;
}) {
  const [ending, setEnding] = useState(false);
  const { status } = props;
  if (bannerText(status, (iso) => iso) === null) return null;
  return (
    <div role="status">
      <p>
        <TextWithTimes build={(fmt) => bannerText(status, fmt) ?? ''} />
      </p>
      {props.canManage && status.state === 'active' ? (
        ending ? (
          <EndReviewModeDialog
            orgId={props.orgId}
            brandId={props.brandId}
            connectionId={status.connectionId}
            onClose={() => setEnding(false)}
          />
        ) : (
          <button type="button" onClick={() => setEnding(true)}>
            End review mode
          </button>
        )
      ) : null}
    </div>
  );
}
