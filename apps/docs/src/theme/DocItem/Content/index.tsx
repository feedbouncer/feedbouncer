import type { ReactNode } from 'react';
import Content from '@theme-original/DocItem/Content';
import type ContentType from '@theme/DocItem/Content';
import type { WrapperProps } from '@docusaurus/types';
import { useDoc } from '@docusaurus/plugin-content-docs/client';
import FeatureStatus from '../../../components/FeatureStatus';

type Props = WrapperProps<typeof ContentType>;

export default function ContentWrapper(props: Props): ReactNode {
  const { status } = useDoc().frontMatter as { status?: string };
  return (
    <>
      {status === 'planned' && (
        <FeatureStatus status="planned">This page describes a planned feature.</FeatureStatus>
      )}
      {status === 'partial' && (
        <FeatureStatus status="partial">
          Parts of this page describe features that are only partly available.
        </FeatureStatus>
      )}
      <Content {...props} />
    </>
  );
}
