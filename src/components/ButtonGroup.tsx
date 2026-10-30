import { Children, Fragment, type ReactNode } from "react";

/** Related actions in one glass capsule with a hairline between them. Children are `Button`s. */
export function ButtonGroup({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  const items = Children.toArray(children);
  return (
    <div role="group" aria-label={label} className={`ws-btn-group ${className}`}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden className="ws-btn-group-divider" />}
          {child}
        </Fragment>
      ))}
    </div>
  );
}
