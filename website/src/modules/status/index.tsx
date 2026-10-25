import { Badge } from 'flowbite-react';
import { productBoundary } from '@site/policy';
export function ReleaseStatus() {
  return <div aria-label="Release verification status"><Badge color="purple">Unverified — product integration and deployment</Badge><p>{productBoundary}</p></div>;
}
